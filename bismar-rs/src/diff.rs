//! Recursive package diff (`-d`): walks two trees, classifies files, and
//! renders Myers line diffs as unified hunks or a stat table.
//! Maps bismar's src/diff.ts.

use crate::env::{csv_row, Color};
use crate::fs_modify::{extract_archive, npm_install, npm_pack, write_pkg};
use crate::public::{bad, explicit_path, fmt_bytes, kb, read_pkg};
use crate::refs::{
    as_ref_str, cache_key, explicit_ref, installed_ref, npm_hint_use, parse_npm_ref,
};
use crate::registries::{is_registry_selector, parse_registry_ref, registry_context};
use anyhow::{bail, Result};
use similar::{ChangeTag, TextDiff};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

// ── Types ─────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq)]
pub enum DiffStatus {
    Added,
    Modified,
    Removed,
}

#[derive(Debug, Clone)]
pub struct DiffEntry {
    pub a_bytes: u64,
    pub b_bytes: u64,
    pub path: String,
    pub status: DiffStatus,
}

#[derive(Debug)]
pub struct TreeDiff {
    pub a_total: u64,
    pub b_total: u64,
    pub entries: Vec<DiffEntry>,
    pub same: usize,
}

#[derive(Debug, Clone)]
pub struct DiffSide {
    pub archive_bytes: Option<u64>,
    pub cache_dir: Option<PathBuf>,
    pub dir: PathBuf,
    pub label: String,
    pub local_dir: Option<bool>,
    pub sel: Option<String>,
    pub tarball: Option<PathBuf>,
}

// ── Walk ──────────────────────────────────────────────────────────────────────

static SKIP: &[&str] = &[".git", "node_modules"];

fn walk(root: &Path, rel: &str, out: &mut HashMap<String, u64>) {
    let dir = if rel.is_empty() {
        root.to_path_buf()
    } else {
        root.join(rel)
    };
    let Ok(entries) = fs::read_dir(&dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if SKIP.contains(&name.as_str()) {
            continue;
        }
        let sub = if rel.is_empty() {
            name.clone()
        } else {
            format!("{}/{}", rel, name)
        };
        let meta = entry.metadata().ok();
        if let Some(m) = &meta {
            if m.is_dir() {
                walk(root, &sub, out);
            } else if m.is_file() {
                out.insert(sub, m.len());
            }
        }
    }
}

pub fn walk_files(root: &Path) -> HashMap<String, u64> {
    let mut out = HashMap::new();
    walk(root, "", &mut out);
    out
}

/// Scope a file map to a path tail.
pub fn scoped(files: HashMap<String, u64>, sel: Option<&str>) -> HashMap<String, u64> {
    let Some(sel) = sel else { return files };
    let dir = format!("{}/", sel.trim_end_matches('/'));
    files
        .into_iter()
        .filter(|(path, _)| path == sel || path.starts_with(&dir))
        .collect()
}

// ── DiffSide resolution ───────────────────────────────────────────────────────

static TGZ: once_cell::sync::Lazy<regex::Regex> =
    once_cell::sync::Lazy::new(|| regex::Regex::new(r"(?i)\.(?:tgz|tar\.gz)$").unwrap());

fn extracted_tgz(out_dir: &Path, file: &Path, label: &str) -> Result<DiffSide> {
    let bytes = fs::read(file)?;
    let dir = out_dir.join(format!("tgz-{}", cache_key(label)));
    extract_archive(&bytes, &dir)?;
    let entries: Vec<_> = fs::read_dir(&dir)?.flatten().collect();
    let root = if entries.len() == 1 && entries[0].path().is_dir() {
        entries[0].path()
    } else {
        dir.clone()
    };
    Ok(DiffSide {
        archive_bytes: Some(bytes.len() as u64),
        cache_dir: None,
        dir: root,
        label: label.to_string(),
        local_dir: None,
        sel: None,
        tarball: Some(file.to_path_buf()),
    })
}

pub fn diff_target(out_dir: &Path, raw: &str, cwd: &Path, bundle: bool) -> Result<DiffSide> {
    if is_registry_selector(raw) {
        let r = parse_registry_ref(raw);
        let got = registry_context(out_dir, &r)?;
        let label = if r.path.is_empty() {
            got.label.clone()
        } else {
            format!("{}/{}", got.label, r.path)
        };
        return Ok(DiffSide {
            archive_bytes: got.archive_bytes,
            cache_dir: None,
            dir: got.pkg_dir,
            label,
            local_dir: None,
            sel: if r.path.is_empty() {
                None
            } else {
                Some(r.path)
            },
            tarball: None,
        });
    }
    if TGZ.is_match(raw) {
        let file = cwd.join(raw);
        if !file.is_file() {
            bail!("missing tarball: {}", bad(raw));
        }
        return extracted_tgz(out_dir, &file, raw);
    }
    if raw == "." || explicit_path(raw) {
        let dir = cwd.join(raw);
        if !dir.is_dir() {
            bail!("missing diff directory: {}", bad(raw));
        }
        return Ok(DiffSide {
            archive_bytes: None,
            cache_dir: None,
            dir,
            label: raw.to_string(),
            local_dir: Some(true),
            sel: None,
            tarball: None,
        });
    }
    if explicit_ref(raw) {
        let r = parse_npm_ref(&as_ref_str(raw))?;
        let got = installed_ref(out_dir, &r, !bundle)?;
        let archive_bytes = None; // async garnish omitted in blocking path
        let label = if r.path.is_empty() {
            got.label.clone()
        } else {
            format!("{}/{}", got.label, r.path)
        };
        return Ok(DiffSide {
            archive_bytes,
            cache_dir: Some(got.ref_dir),
            dir: got.pkg_dir,
            label,
            local_dir: None,
            sel: if r.path.is_empty() {
                None
            } else {
                Some(r.path)
            },
            tarball: None,
        });
    }
    let use_hint = npm_hint_use(raw);
    bail!(
        "--diff expects package refs or directories, not {}{}",
        bad(raw),
        if use_hint.is_empty() {
            String::new()
        } else {
            format!("; {}", use_hint)
        }
    )
}

fn packable(side: &DiffSide) -> bool {
    side.local_dir == Some(true) && side.dir.join("package.json").is_file()
}

pub fn pack_local_side(out_dir: &Path, side: DiffSide) -> DiffSide {
    if !packable(&side) {
        return side;
    }
    let label = format!("{} (npm pack)", side.label);
    let tarball = match npm_pack(
        &side.dir,
        &out_dir.join(format!("pack-{}", cache_key(&side.label))),
    ) {
        Ok(t) => t,
        Err(_) => return side,
    };
    match extracted_tgz(out_dir, &tarball, &label) {
        Ok(s) => s,
        Err(_) => side,
    }
}

pub fn pack_local_sides(out_dir: &Path, a: DiffSide, b: DiffSide) -> (DiffSide, DiffSide) {
    let a_pack = packable(&a);
    let b_pack = packable(&b);
    if a_pack == b_pack {
        return (a, b);
    }
    (pack_local_side(out_dir, a), pack_local_side(out_dir, b))
}

pub fn measured_side(out_dir: &Path, side: DiffSide) -> DiffSide {
    if side.cache_dir.is_some() || side.tarball.is_none() {
        return side;
    }
    let pkg_file = side.dir.join("package.json");
    if !pkg_file.is_file() {
        return side;
    }
    let Ok(pkg) = read_pkg(&pkg_file, false) else {
        return side;
    };
    let pkg_name = pkg.name.clone();
    let dir = out_dir.join(format!("install-{}", cache_key(&side.label)));
    let pkg_json = format!(
        "{}\n",
        serde_json::to_string_pretty(&serde_json::json!({
            "dependencies": { (pkg_name.as_str()): format!("file:{}", side.tarball.as_ref().unwrap().display()) },
            "private": true
        }))
        .unwrap_or_default()
    );
    if write_pkg(&dir.join("package.json"), &pkg_json).is_err() {
        return side;
    }
    if npm_install(&dir, false).is_err() {
        return side;
    }
    DiffSide {
        dir: dir.join("node_modules").join(&pkg_name),
        ..side
    }
}

// ── Tree diff ─────────────────────────────────────────────────────────────────

pub fn diff_trees(
    a_dir: &Path,
    b_dir: &Path,
    a_sel: Option<&str>,
    b_sel: Option<&str>,
) -> TreeDiff {
    let a = scoped(walk_files(a_dir), a_sel);
    let b = scoped(walk_files(b_dir), b_sel);
    let a_total: u64 = a.values().sum();
    let b_total: u64 = b.values().sum();
    let all_paths: HashSet<&String> = a.keys().chain(b.keys()).collect();
    let mut sorted_paths: Vec<&String> = all_paths.into_iter().collect();
    sorted_paths.sort();
    let mut entries = Vec::new();
    let mut same = 0usize;
    for path in sorted_paths {
        match (a.get(path), b.get(path)) {
            (None, Some(&b_bytes)) => entries.push(DiffEntry {
                a_bytes: 0,
                b_bytes,
                path: path.clone(),
                status: DiffStatus::Added,
            }),
            (Some(&a_bytes), None) => entries.push(DiffEntry {
                a_bytes,
                b_bytes: 0,
                path: path.clone(),
                status: DiffStatus::Removed,
            }),
            (Some(&a_bytes), Some(&b_bytes)) => {
                // Read file contents to determine modified vs same.
                let a_content = fs::read(a_dir.join(path)).ok();
                let b_content = fs::read(b_dir.join(path)).ok();
                if a_content == b_content {
                    same += 1;
                } else {
                    entries.push(DiffEntry {
                        a_bytes,
                        b_bytes,
                        path: path.clone(),
                        status: DiffStatus::Modified,
                    });
                }
            }
            _ => {}
        }
    }
    TreeDiff {
        a_total,
        b_total,
        entries,
        same,
    }
}

// ── Stat rendering ────────────────────────────────────────────────────────────

pub fn stat_names(entries: &[DiffEntry]) -> Vec<String> {
    entries.iter().map(|e| e.path.clone()).collect()
}

pub fn stat_csv(entries: &[DiffEntry]) -> String {
    let mut lines = vec![csv_row(&["status", "path", "a_bytes", "b_bytes"])];
    for e in entries {
        let status = match e.status {
            DiffStatus::Added => "added",
            DiffStatus::Modified => "modified",
            DiffStatus::Removed => "removed",
        };
        lines.push(csv_row(&[
            status,
            &e.path,
            &e.a_bytes.to_string(),
            &e.b_bytes.to_string(),
        ]));
    }
    lines.join("\n")
}

pub fn stat_human(_a_label: &str, _b_label: &str, diff: &TreeDiff, color: bool) -> String {
    let mut lines = Vec::new();
    let a_col = if color { Color::RED } else { "" };
    let b_col = if color { Color::GREEN } else { "" };
    let reset = if color { Color::RESET } else { "" };
    for e in &diff.entries {
        let (status_str, col) = match e.status {
            DiffStatus::Added => ("+", b_col),
            DiffStatus::Removed => ("-", a_col),
            DiffStatus::Modified => ("~", if color { Color::YELLOW } else { "" }),
        };
        lines.push(format!(
            "{}{}{} {} ({} → {})",
            col,
            status_str,
            reset,
            e.path,
            kb(e.a_bytes),
            kb(e.b_bytes)
        ));
    }
    let footer = format!(
        "{} → {} ({} same, {} changed)",
        fmt_bytes(diff.a_total),
        fmt_bytes(diff.b_total),
        diff.same,
        diff.entries.len()
    );
    lines.push(String::new());
    lines.push(footer);
    lines.join("\n")
}

// ── Unified diff rendering ────────────────────────────────────────────────────

pub fn render_unified_highlighted(
    a_dir: &Path,
    b_dir: &Path,
    entries: &[DiffEntry],
    color: bool,
) -> String {
    let mut out = String::new();
    for entry in entries {
        if entry.status == DiffStatus::Added || entry.status == DiffStatus::Removed {
            let side = if entry.status == DiffStatus::Added {
                b_dir
            } else {
                a_dir
            };
            let content = fs::read_to_string(side.join(&entry.path)).unwrap_or_default();
            let prefix = if entry.status == DiffStatus::Added {
                "+"
            } else {
                "-"
            };
            let col = if color {
                if entry.status == DiffStatus::Added {
                    Color::GREEN
                } else {
                    Color::RED
                }
            } else {
                ""
            };
            out.push_str(&format!(
                "{}--- {}\n+++ {}\n{}",
                if color { Color::BOLD } else { "" },
                entry.path,
                entry.path,
                if color { Color::RESET } else { "" }
            ));
            for line in content.lines() {
                if color {
                    out.push_str(&format!("{}{} {}{}\n", col, prefix, line, Color::RESET));
                } else {
                    out.push_str(&format!("{} {}\n", prefix, line));
                }
            }
        } else {
            // Modified
            let a_content = fs::read_to_string(a_dir.join(&entry.path)).unwrap_or_default();
            let b_content = fs::read_to_string(b_dir.join(&entry.path)).unwrap_or_default();
            out.push_str(&render_text_unified_highlighted(
                &entry.path,
                &a_content,
                &b_content,
                color,
            ));
        }
    }
    out
}

pub fn render_text_unified_highlighted(path: &str, a: &str, b: &str, color: bool) -> String {
    let diff = TextDiff::from_lines(a, b);
    let mut out = String::new();
    if color {
        out.push_str(&format!(
            "{}--- {}\n+++ {}{}\n",
            Color::BOLD,
            path,
            path,
            Color::RESET
        ));
    } else {
        out.push_str(&format!("--- {}\n+++ {}\n", path, path));
    }
    for group in diff.grouped_ops(3) {
        for op in &group {
            for change in diff.iter_changes(op) {
                let (sign, col) = match change.tag() {
                    ChangeTag::Delete => ("-", Color::RED),
                    ChangeTag::Insert => ("+", Color::GREEN),
                    ChangeTag::Equal => (" ", ""),
                };
                if color && !col.is_empty() {
                    out.push_str(&format!(
                        "{}{}{}{}\n",
                        col,
                        sign,
                        change.value(),
                        Color::RESET
                    ));
                } else {
                    out.push_str(&format!("{}{}\n", sign, change.value()));
                }
            }
        }
    }
    out
}

// ── Bundle stat rows ──────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct BundleRow {
    pub id: String,
    pub a_loc: Option<f64>,
    pub b_loc: Option<f64>,
    pub a_min: Option<f64>,
    pub b_min: Option<f64>,
    pub a_gz: Option<f64>,
    pub b_gz: Option<f64>,
}

pub fn diff_bundle_rows(
    a_rows: &HashMap<String, Vec<f64>>,
    b_rows: &HashMap<String, Vec<f64>>,
) -> Vec<BundleRow> {
    let all_keys: HashSet<&String> = a_rows.keys().chain(b_rows.keys()).collect();
    let mut keys: Vec<&String> = all_keys.into_iter().collect();
    keys.sort();
    keys.into_iter()
        .map(|k| {
            let a = a_rows.get(k);
            let b = b_rows.get(k);
            BundleRow {
                id: k.clone(),
                a_loc: a.and_then(|r| r.get(0).copied()),
                b_loc: b.and_then(|r| r.get(0).copied()),
                a_min: a.and_then(|r| r.get(1).copied()),
                b_min: b.and_then(|r| r.get(1).copied()),
                a_gz: a.and_then(|r| r.get(2).copied()),
                b_gz: b.and_then(|r| r.get(2).copied()),
            }
        })
        .collect()
}

pub fn bundle_stat_csv(rows: &[BundleRow]) -> String {
    let mut lines = vec![csv_row(&[
        "id", "a_loc", "b_loc", "a_min", "b_min", "a_gz", "b_gz",
    ])];
    for r in rows {
        lines.push(csv_row(&[
            &r.id,
            &r.a_loc.map(|v| v.to_string()).unwrap_or_default(),
            &r.b_loc.map(|v| v.to_string()).unwrap_or_default(),
            &r.a_min.map(|v| v.to_string()).unwrap_or_default(),
            &r.b_min.map(|v| v.to_string()).unwrap_or_default(),
            &r.a_gz.map(|v| v.to_string()).unwrap_or_default(),
            &r.b_gz.map(|v| v.to_string()).unwrap_or_default(),
        ]));
    }
    lines.join("\n")
}

pub fn bundle_stat_human(
    _a_label: &str,
    _b_label: &str,
    rows: &[BundleRow],
    color: bool,
) -> String {
    let mut lines = Vec::new();
    let col = if color { Color::CYAN } else { "" };
    let reset = if color { Color::RESET } else { "" };
    lines.push(format!(
        "{}{:<40} {:>8} {:>8} {:>8} {:>8}{}",
        col, "id", "a_min", "b_min", "a_gz", "b_gz", reset
    ));
    for r in rows {
        lines.push(format!(
            "{:<40} {:>8} {:>8} {:>8} {:>8}",
            r.id,
            r.a_min.map(|v| kb(v as u64)).unwrap_or_default(),
            r.b_min.map(|v| kb(v as u64)).unwrap_or_default(),
            r.a_gz.map(|v| kb(v as u64)).unwrap_or_default(),
            r.b_gz.map(|v| kb(v as u64)).unwrap_or_default(),
        ));
    }
    lines.join("\n")
}
