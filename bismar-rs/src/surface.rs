//! Static facts: public surface listing and plain file-size stats.
//! Maps bismar's src/surface.ts.

use crate::diff::{scoped, walk_files};
use crate::env::{csv_row, Color};
use crate::public::{fmt_bytes, kb, read_json, resolve_inside, sorted};
use once_cell::sync::Lazy;
use regex::Regex;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;

static RE_GO_MODULE: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?m)^module\s+(\S+)").unwrap());
static RE_GO_PACKAGE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?m)^package\s+([A-Za-z_]\w*)").unwrap());
static RE_IDENT: Lazy<Regex> = Lazy::new(|| Regex::new(r"^[A-Za-z_]\w*$").unwrap());
static RE_DIST_INFO: Lazy<Regex> = Lazy::new(|| Regex::new(r"\.(dist|egg)-info$").unwrap());
static RE_CARGO_NAME: Lazy<Regex> =
    Lazy::new(|| Regex::new(r#"(?m)^name\s*=\s*"([^"]+)""#).unwrap());

// ── Go surface ────────────────────────────────────────────────────────────────

fn go_skip(rel: &str) -> bool {
    rel.split('/').any(|seg| {
        matches!(seg, "internal" | "testdata" | "vendor")
            || seg.starts_with('.')
            || seg.starts_with('_')
    })
}

fn go_module(pkg_dir: &Path, ref_name: &str) -> String {
    let go_mod = pkg_dir.join("go.mod");
    if let Ok(text) = fs::read_to_string(&go_mod) {
        if let Some(cap) = RE_GO_MODULE.captures(&text) {
            return cap[1].to_string();
        }
    }
    ref_name.to_string()
}

pub fn go_surface(pkg_dir: &Path, ref_name: &str) -> Vec<String> {
    let module = go_module(pkg_dir, ref_name);
    let files = walk_files(pkg_dir);
    let mut by_dir: HashMap<String, Vec<String>> = HashMap::new();
    for file in files.keys() {
        if !file.ends_with(".go") || file.ends_with("_test.go") {
            continue;
        }
        let dir = {
            let p = std::path::Path::new(file);
            p.parent()
                .map(|d| d.to_string_lossy().into_owned())
                .unwrap_or_default()
        };
        let rel = if dir == "." || dir.is_empty() {
            String::new()
        } else {
            dir
        };
        if go_skip(&rel) {
            continue;
        }
        by_dir.entry(rel).or_default().push(file.clone());
    }
    let mut paths = Vec::new();
    for (rel, dir_files) in &by_dir {
        for file in dir_files {
            let content = fs::read_to_string(pkg_dir.join(file)).unwrap_or_default();
            if let Some(cap) = RE_GO_PACKAGE.captures(&content) {
                let pkg = &cap[1];
                if pkg != "main" {
                    paths.push(if rel.is_empty() {
                        module.clone()
                    } else {
                        format!("{}/{}", module, rel)
                    });
                    break;
                }
            }
        }
    }
    sorted(paths)
}

// ── Composer (PHP PSR-4) surface ──────────────────────────────────────────────

fn psr4_ident(s: &str) -> bool {
    !s.is_empty() && s.chars().all(|c| c.is_alphanumeric() || c == '_')
}

pub fn composer_surface(pkg_dir: &Path) -> Vec<String> {
    #[derive(serde::Deserialize)]
    struct ComposerJson {
        autoload: Option<AutoloadSection>,
    }
    #[derive(serde::Deserialize)]
    struct AutoloadSection {
        #[serde(rename = "psr-4")]
        psr4: Option<serde_json::Value>,
    }

    let manifest_path = pkg_dir.join("composer.json");
    let Ok(manifest) = read_json::<ComposerJson>(&manifest_path) else {
        return vec![];
    };
    let psr4 = match manifest.autoload.and_then(|a| a.psr4) {
        Some(serde_json::Value::Object(m)) => m,
        _ => return vec![],
    };
    let mut classes = Vec::new();
    for (ns, target) in &psr4 {
        let dirs = match target {
            serde_json::Value::String(s) => vec![s.as_str().to_string()],
            serde_json::Value::Array(arr) => arr
                .iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect(),
            _ => continue,
        };
        for dir in dirs {
            let Some(root) = resolve_inside(pkg_dir, &dir) else {
                continue;
            };
            for file in walk_files(&root).keys() {
                if !file.ends_with(".php") {
                    continue;
                }
                let parts: Vec<&str> = file[..file.len() - 4].split('/').collect();
                if parts.iter().all(|p| psr4_ident(p)) {
                    classes.push(format!("{}{}", ns, parts.join("\\")));
                }
            }
        }
    }
    sorted(classes)
}

// ── PyPI surface ──────────────────────────────────────────────────────────────

static PY_SKIP: &[&str] = &[
    "doc", "docs", "example", "examples", "test", "testing", "tests",
];

pub fn pypi_surface(pkg_dir: &Path) -> Vec<String> {
    let mut names = HashSet::new();
    for base in &["", "src"] {
        let base_dir = if base.is_empty() {
            pkg_dir.to_path_buf()
        } else {
            pkg_dir.join(base)
        };
        if let Ok(entries) = fs::read_dir(&base_dir) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                if name.ends_with(".dist-info") || name.ends_with(".egg-info") {
                    let top = base_dir.join(&name).join("top_level.txt");
                    if let Ok(content) = fs::read_to_string(&top) {
                        for line in content.lines() {
                            let t = line.trim();
                            if !t.is_empty() && RE_IDENT.is_match(t) {
                                names.insert(t.to_string());
                            }
                        }
                    }
                }
            }
        }
    }
    if names.is_empty() {
        for base in &["src", ""] {
            let base_dir = if base.is_empty() {
                pkg_dir.to_path_buf()
            } else {
                pkg_dir.join(base)
            };
            if let Ok(entries) = fs::read_dir(&base_dir) {
                for entry in entries.flatten() {
                    let name = entry.file_name().to_string_lossy().into_owned();
                    if PY_SKIP.contains(&name.as_str()) {
                        continue;
                    }
                    if base_dir.join(&name).join("__init__.py").exists() {
                        names.insert(name);
                    }
                }
            }
            if !names.is_empty() {
                break;
            }
        }
    }
    sorted(names)
}

// ── Gem surface ───────────────────────────────────────────────────────────────

pub fn gem_surface(pkg_dir: &Path) -> Vec<String> {
    let lib = pkg_dir.join("lib");
    if !lib.exists() {
        return vec![];
    }
    sorted(
        walk_files(&lib)
            .keys()
            .filter(|f| f.ends_with(".rb"))
            .map(|f| f[..f.len() - 3].to_string())
            .collect::<Vec<_>>(),
    )
}

// ── Rust crate surface ────────────────────────────────────────────────────────

pub fn crate_surface(pkg_dir: &Path) -> Vec<String> {
    // Read Cargo.toml for crate name, list pub mod names from src/.
    let cargo = pkg_dir.join("Cargo.toml");
    let name = fs::read_to_string(&cargo)
        .ok()
        .and_then(|t| RE_CARGO_NAME.captures(&t).map(|c| c[1].to_string()))
        .unwrap_or_default();
    if name.is_empty() {
        return vec![];
    }
    sorted(vec![name])
}

// ── Public surface entry point ────────────────────────────────────────────────

/// Generate `import` / `use` lines for a package, or file listing as fallback.
pub fn registry_surface(pkg_dir: &Path, prefix: &str, ref_name: &str, _color: bool) -> Vec<String> {
    let lines = match prefix {
        "go" => go_surface(pkg_dir, ref_name),
        "packagist" => composer_surface(pkg_dir),
        "pypi" => pypi_surface(pkg_dir),
        "gem" => gem_surface(pkg_dir),
        "crate" => crate_surface(pkg_dir),
        _ => vec![],
    };
    if !lines.is_empty() {
        return lines;
    }
    // Fallback: shipped file listing.
    let mut files: Vec<String> = walk_files(pkg_dir).into_keys().collect();
    files.sort();
    files
}

// ── Plain file sizes ──────────────────────────────────────────────────────────

pub fn file_sizes_human(pkg_dir: &Path, sel: Option<&str>, label: &str, color: bool) -> String {
    let files = scoped(walk_files(pkg_dir), sel);
    let mut sorted_files: Vec<(String, u64)> = files.into_iter().collect();
    sorted_files.sort_by(|a, b| a.0.cmp(&b.0));
    let total: u64 = sorted_files.iter().map(|(_, s)| s).sum();
    let col = if color { Color::CYAN } else { "" };
    let reset = if color { Color::RESET } else { "" };
    let mut lines: Vec<String> = sorted_files
        .iter()
        .map(|(path, bytes)| format!("{:>10}  {}", kb(*bytes), path))
        .collect();
    lines.push(format!(
        "\n{}total: {} ({}){}",
        col,
        fmt_bytes(total),
        label,
        reset
    ));
    lines.join("\n")
}

pub fn file_sizes_csv(pkg_dir: &Path, sel: Option<&str>, _label: &str) -> String {
    let files = scoped(walk_files(pkg_dir), sel);
    let mut sorted_files: Vec<(String, u64)> = files.into_iter().collect();
    sorted_files.sort_by(|a, b| a.0.cmp(&b.0));
    let mut lines = vec![csv_row(&["path", "bytes"])];
    for (path, bytes) in &sorted_files {
        lines.push(csv_row(&[path, &bytes.to_string()]));
    }
    lines.join("\n")
}

pub fn sizes_human(entries: &[(String, u64)], label: &str, color: bool) -> String {
    let col = if color { Color::CYAN } else { "" };
    let reset = if color { Color::RESET } else { "" };
    let total: u64 = entries.iter().map(|(_, s)| s).sum();
    let mut lines: Vec<String> = entries
        .iter()
        .map(|(id, bytes)| format!("{:>10}  {}", kb(*bytes), id))
        .collect();
    lines.push(format!(
        "\n{}total: {} ({}){}",
        col,
        fmt_bytes(total),
        label,
        reset
    ));
    lines.join("\n")
}

pub fn sizes_csv(entries: &[(String, u64)]) -> String {
    let mut lines = vec![csv_row(&["id", "bytes"])];
    for (id, bytes) in entries {
        lines.push(csv_row(&[id, &bytes.to_string()]));
    }
    lines.join("\n")
}
