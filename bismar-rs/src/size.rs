//! Bundle size measurement and export listing.
//! For JS packages, delegates to an esbuild subprocess (mirroring TS).
//! For non-JS, measures raw file sizes.
//! Maps bismar's src/size.ts.

use crate::diff::walk_files;
use crate::env::{csv_enabled, progress_done, progress_update, stdout_color};
use crate::fs_modify::temp_dir;
use crate::public::{read_pkg, Pkg};
use crate::refs::{as_ref_str, explicit_ref, installed_ref, parse_npm_ref, ref_db, RefDbMod};
use anyhow::Result;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;

// ── RowData / Built ───────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct RowData {
    pub id: String,
    pub loc: f64,
    pub min_bytes: f64,
    pub gz_bytes: f64,
    pub plain_bytes: f64,
}

#[derive(Debug, Clone)]
pub struct Built {
    pub label: String,
    pub rows: Vec<RowData>,
    pub row_map: HashMap<String, Vec<f64>>,
}

// ── esbuild integration ───────────────────────────────────────────────────────

/// Find `esbuild` binary: try local node_modules/.bin first, then PATH.
fn find_esbuild() -> Option<String> {
    let local = std::env::current_dir()
        .ok()
        .map(|d| d.join("node_modules").join(".bin").join("esbuild"));
    if let Some(p) = local {
        if p.exists() {
            return Some(p.to_string_lossy().into_owned());
        }
    }
    Some("esbuild".to_string())
}

/// Run esbuild to bundle an entry point and report sizes.
/// Returns (loc, minified_bytes, gzipped_bytes, plain_bytes).
fn esbuild_measure(
    entry: &str,
    external: &[String],
    root_dir: &Path,
) -> Result<(f64, f64, f64, f64)> {
    let esbuild = find_esbuild().ok_or_else(|| anyhow::anyhow!("esbuild not found"))?;
    let external_args: Vec<String> = external
        .iter()
        .map(|e| format!("--external:{}", e))
        .collect();
    let mut args = vec![
        entry.to_string(),
        "--bundle".to_string(),
        "--format=iife".to_string(),
        "--platform=browser".to_string(),
        "--minify".to_string(),
        "--log-level=error".to_string(),
        "--metafile=/dev/stderr".to_string(),
    ];
    args.extend(external_args);
    let output = Command::new(&esbuild)
        .args(&args)
        .current_dir(root_dir)
        .output()
        .map_err(|e| anyhow::anyhow!("esbuild failed: {}", e))?;

    let minified = output.stdout.len() as f64;
    let gz = {
        use flate2::{write::GzEncoder, Compression};
        use std::io::Write;
        let mut enc = GzEncoder::new(Vec::new(), Compression::default());
        enc.write_all(&output.stdout)?;
        enc.finish()?.len() as f64
    };
    let plain = {
        // Re-run without minify for plain size.
        let plain_args = vec![
            entry.to_string(),
            "--bundle".to_string(),
            "--format=iife".to_string(),
            "--platform=browser".to_string(),
            "--log-level=error".to_string(),
        ];
        let output2 = Command::new(&esbuild)
            .args(&plain_args)
            .current_dir(root_dir)
            .output()
            .ok();
        output2.map(|o| o.stdout.len() as f64).unwrap_or(minified)
    };
    let loc = count_loc(&output.stdout);
    Ok((loc, minified, gz, plain))
}

fn count_loc(code: &[u8]) -> f64 {
    code.iter().filter(|&&b| b == b'\n').count() as f64
}

// ── buildFirst: install + enumerate modules ───────────────────────────────────

pub struct BuildFirst {
    pub label: String,
    pub pkg: Pkg,
    pub pkg_dir: PathBuf,
    pub ref_dir: Option<PathBuf>,
    pub modules: Vec<RefDbMod>,
    pub out_dir: PathBuf,
}

pub fn build_first(raw: &str, out_dir: &Path) -> Result<BuildFirst> {
    if explicit_ref(raw) || raw.contains(':') {
        let r = parse_npm_ref(&as_ref_str(raw))?;
        let got = installed_ref(out_dir, &r, false)?;
        let db = ref_db(&got.ref_dir);
        let modules = db
            .modules
            .unwrap_or_else(|| enumerate_modules(&got.pkg, &got.pkg_dir, &got.ref_dir));
        Ok(BuildFirst {
            label: got.label,
            pkg: got.pkg,
            pkg_dir: got.pkg_dir,
            ref_dir: Some(got.ref_dir),
            modules,
            out_dir: out_dir.to_path_buf(),
        })
    } else {
        let target = crate::public::pkg_target(raw, &std::env::current_dir()?)?;
        let pkg = read_pkg(&target.pkg_file, false)?;
        let modules = enumerate_modules(&pkg, &target.cwd, &target.cwd);
        Ok(BuildFirst {
            label: pkg.name.clone(),
            pkg,
            pkg_dir: target.cwd.clone(),
            ref_dir: None,
            modules,
            out_dir: out_dir.to_path_buf(),
        })
    }
}

fn enumerate_modules(pkg: &Pkg, pkg_dir: &Path, _ref_dir: &Path) -> Vec<RefDbMod> {
    use crate::public::public_entries;
    let ctx = crate::public::PublicCtx {
        cwd: pkg_dir.to_path_buf(),
        pkg: pkg.clone(),
        pkg_file: pkg_dir.join("package.json"),
    };
    public_entries(&ctx)
        .into_iter()
        .filter(|e| !e.js_rel.is_empty())
        .map(|e| {
            let module = e.key.trim_start_matches("./").to_string();
            let module = if module == "." {
                pkg.name.clone()
            } else {
                module
            };
            RefDbMod {
                exports: vec![],
                file: e.js_rel,
                module,
            }
        })
        .collect()
}

// ── measureRows ───────────────────────────────────────────────────────────────

pub fn measure_rows(bf: &BuildFirst, _minify: bool, _skip_cache: bool) -> Result<Vec<RowData>> {
    let mut rows = Vec::new();
    for m in &bf.modules {
        progress_update(&format!("measuring {}", m.module));
        let entry = bf.pkg_dir.join(&m.file);
        if !entry.exists() {
            continue;
        }
        let entry_str = entry.to_string_lossy().into_owned();
        let external: Vec<String> = bf.pkg.dependencies.keys().cloned().collect();
        match esbuild_measure(&entry_str, &external, &bf.pkg_dir) {
            Ok((loc, min_bytes, gz_bytes, plain_bytes)) => {
                rows.push(RowData {
                    id: m.module.clone(),
                    loc,
                    min_bytes,
                    gz_bytes,
                    plain_bytes,
                });
            }
            Err(e) => {
                eprintln!("warning: esbuild failed for {}: {}", m.module, e);
            }
        }
    }
    progress_done();
    Ok(rows)
}

// ── runSize ───────────────────────────────────────────────────────────────────

pub fn run_size(raw: &str, bundle: bool, minify: bool, list_mode: bool) -> Result<String> {
    let out_dir = temp_dir()?;
    let bf = build_first(raw, &out_dir)?;

    if list_mode {
        let ids: Vec<String> = bf.modules.iter().map(|m| m.module.clone()).collect();
        return Ok(ids.join("\n"));
    }

    if !bundle {
        // Plain file sizes.
        let files = walk_files(&bf.pkg_dir);
        let mut sorted_files: Vec<(String, u64)> = files.into_iter().collect();
        sorted_files.sort_by(|a, b| a.0.cmp(&b.0));
        if csv_enabled() {
            return Ok(crate::surface::sizes_csv(&sorted_files));
        }
        return Ok(crate::surface::sizes_human(
            &sorted_files,
            &bf.label,
            stdout_color(),
        ));
    }

    let rows = measure_rows(&bf, minify, false)?;
    let _row_map: HashMap<String, Vec<f64>> = rows
        .iter()
        .map(|r| {
            (
                r.id.clone(),
                vec![r.loc, r.min_bytes, r.gz_bytes, r.plain_bytes],
            )
        })
        .collect();

    if csv_enabled() {
        let entries: Vec<(String, u64)> = rows
            .iter()
            .map(|r| {
                (
                    r.id.clone(),
                    if minify { r.gz_bytes } else { r.min_bytes } as u64,
                )
            })
            .collect();
        return Ok(crate::surface::sizes_csv(&entries));
    }

    let entries: Vec<(String, u64)> = rows
        .iter()
        .map(|r| {
            let bytes = if minify { r.gz_bytes } else { r.min_bytes } as u64;
            (r.id.clone(), bytes)
        })
        .collect();
    Ok(crate::surface::sizes_human(
        &entries,
        &bf.label,
        stdout_color(),
    ))
}
