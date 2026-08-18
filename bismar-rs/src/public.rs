//! Shared helpers: package.json reading, path utilities, public-entry listing.
//! Maps bismar's src/public.ts.

use crate::env::{paint, Color};
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

// ── Error helpers ─────────────────────────────────────────────────────────────

/// Paint text red for error display.
pub fn bad(text: &str) -> String {
    paint(text, Color::RED, crate::env::want_color())
}

/// Format bytes as KB with two decimal places.
pub fn kb(bytes: u64) -> String {
    format!("{:.2}", bytes as f64 / 1024.0)
}

/// Human-readable byte size.
pub fn fmt_bytes(bytes: u64) -> String {
    if bytes < 1024 {
        format!("{}B", bytes)
    } else if bytes < 1024 * 1024 {
        format!("{:.2}kB", bytes as f64 / 1024.0)
    } else {
        format!("{:.2}MB", bytes as f64 / (1024.0 * 1024.0))
    }
}

// ── File utilities ────────────────────────────────────────────────────────────

pub fn read_text(file: &Path) -> Result<String> {
    std::fs::read_to_string(file).with_context(|| format!("reading {}", file.display()))
}

pub fn read_json<T: for<'de> Deserialize<'de>>(file: &Path) -> Result<T> {
    let text = read_text(file)?;
    serde_json::from_str(&text).with_context(|| format!("parsing JSON from {}", file.display()))
}

/// Relative name from `cwd` to `file`, or the basename if they're the same.
pub fn rel_name(cwd: &Path, file: &Path) -> String {
    let rel = file.strip_prefix(cwd).unwrap_or(file);
    let s = rel.to_string_lossy();
    if s.is_empty() {
        file.file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default()
    } else {
        s.into_owned()
    }
}

/// Whether `raw` looks like an explicit path (starts with ./ ../ / or is `.`).
pub fn explicit_path(raw: &str) -> bool {
    raw == "."
        || raw.starts_with("./")
        || raw.starts_with("../")
        || raw.starts_with('/')
        || (cfg!(windows) && raw.len() > 2 && raw.chars().nth(1) == Some(':'))
}

pub fn slug(s: &str) -> String {
    s.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '.' {
                c
            } else {
                '-'
            }
        })
        .collect::<String>()
        .trim_matches('-')
        .to_string()
}

/// Ensure `candidate` is inside `root` (no path traversal). Returns the
/// resolved absolute path if safe, None otherwise.
pub fn resolve_inside(root: &Path, candidate: &str) -> Option<PathBuf> {
    let joined = root.join(candidate);
    let canonical = joined.canonicalize().ok().or_else(|| {
        // If it doesn't exist yet, normalise lexically.
        let mut p = root.to_path_buf();
        for comp in Path::new(candidate).components() {
            use std::path::Component::*;
            match comp {
                Normal(c) => p.push(c),
                ParentDir => {
                    p.pop();
                }
                _ => {}
            }
        }
        Some(p)
    })?;
    if canonical.starts_with(root) {
        Some(canonical)
    } else {
        None
    }
}

/// Guard that `file` is a child of `cwd`; bail with `label` otherwise.
pub fn guard_child(cwd: &Path, file: &Path, label: &str) -> Result<()> {
    if !file.starts_with(cwd) {
        bail!("path escape: {} is outside {}", label, cwd.display());
    }
    Ok(())
}

// ── Package manifest ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Pkg {
    pub name: String,
    pub version: Option<String>,
    pub description: Option<String>,
    #[serde(default)]
    pub dependencies: HashMap<String, String>,
    #[serde(rename = "devDependencies", default)]
    pub dev_dependencies: HashMap<String, String>,
    #[serde(rename = "peerDependencies", default)]
    pub peer_dependencies: HashMap<String, String>,
    pub main: Option<String>,
    pub module: Option<String>,
    pub types: Option<String>,
    pub exports: Option<Value>,
    pub os: Option<Vec<String>>,
    pub cpu: Option<Vec<String>>,
    #[serde(rename = "type")]
    pub pkg_type: Option<String>,
    #[serde(flatten)]
    pub extra: HashMap<String, Value>,
}

pub struct PkgTarget {
    pub cwd: PathBuf,
    pub pkg_file: PathBuf,
}

pub struct PublicCtx {
    pub cwd: PathBuf,
    pub pkg: Pkg,
    pub pkg_file: PathBuf,
}

#[derive(Debug, Clone)]
pub struct PublicEntry {
    pub js_rel: String,
    pub key: String,
    pub spec: String,
    pub value: Value,
}

#[derive(Debug, Clone)]
pub struct PublicMod {
    pub dts_file: String,
    pub js_file: String,
    pub key: String,
    pub spec: String,
}

#[derive(Debug, Clone)]
pub struct PublicRow {
    pub file: String,
    pub dts_file: String,
    pub js_file: String,
    pub key: String,
    pub spec: String,
}

/// Read a package.json, optionally tolerating a missing `exports`/`main`.
pub fn read_pkg(pkg_file: &Path, entry_optional: bool) -> Result<Pkg> {
    let pkg: Pkg = read_json(pkg_file)?;
    if pkg.name.is_empty() {
        bail!("package.json missing `name`: {}", pkg_file.display());
    }
    if !entry_optional && pkg.main.is_none() && pkg.exports.is_none() {
        bail!(
            "package.json missing `exports` or `main`: {}",
            pkg_file.display()
        );
    }
    Ok(pkg)
}

/// Locate the package.json nearest to `pkg_arg` from `cwd`.
pub fn pkg_target(pkg_arg: &str, cwd: &Path) -> Result<PkgTarget> {
    let base: PathBuf = if explicit_path(pkg_arg) {
        cwd.join(pkg_arg)
    } else {
        cwd.to_path_buf()
    };
    let pkg_file = if base.is_dir() {
        base.join("package.json")
    } else if base.extension().and_then(|e| e.to_str()) == Some("json") {
        base.clone()
    } else {
        base.join("package.json")
    };
    if !pkg_file.exists() {
        bail!("no package.json found at {}", pkg_file.display());
    }
    let cwd = pkg_file.parent().unwrap_or(cwd).to_path_buf();
    Ok(PkgTarget { cwd, pkg_file })
}

pub fn public_ctx(pkg_arg: &str, cwd: &Path) -> Result<PublicCtx> {
    let target = pkg_target(pkg_arg, cwd)?;
    let pkg = read_pkg(&target.pkg_file, false)?;
    Ok(PublicCtx {
        cwd: target.cwd,
        pkg,
        pkg_file: target.pkg_file,
    })
}

/// Extract a JS path from an exports value (string, {default}, {import}).
pub fn js_path(value: &Value) -> Option<String> {
    match value {
        Value::String(s) => Some(s.clone()),
        Value::Object(map) => {
            for key in &["import", "require", "default", "node", "browser"] {
                if let Some(v) = map.get(*key) {
                    if let Some(p) = js_path(v) {
                        return Some(p);
                    }
                }
            }
            None
        }
        Value::Array(arr) => arr.iter().find_map(js_path),
        _ => None,
    }
}

/// Extract a .d.ts path from an exports value.
pub fn dts_path(value: &Value) -> Option<String> {
    match value {
        Value::String(s) if s.ends_with(".d.ts") => Some(s.clone()),
        Value::Object(map) => {
            for key in &["types", "typings"] {
                if let Some(v) = map.get(*key) {
                    if let Some(p) = dts_path(v) {
                        return Some(p);
                    }
                }
            }
            // fall through to js_path for inference
            None
        }
        _ => None,
    }
}

pub fn public_spec(pkg: &Pkg, key: &str) -> String {
    if key == "." {
        pkg.name.clone()
    } else {
        let tail = key.strip_prefix("./").unwrap_or(key);
        format!("{}/{}", pkg.name, tail)
    }
}

/// List all public entries from a package's `exports` map.
pub fn public_entries(ctx: &PublicCtx) -> Vec<PublicEntry> {
    let mut entries = Vec::new();
    match &ctx.pkg.exports {
        Some(Value::Object(map)) => {
            for (key, value) in map {
                if !key.starts_with('.') {
                    continue;
                }
                let js_rel = js_path(value).unwrap_or_default();
                entries.push(PublicEntry {
                    js_rel,
                    key: key.clone(),
                    spec: public_spec(&ctx.pkg, key),
                    value: value.clone(),
                });
            }
        }
        Some(Value::String(s)) => {
            entries.push(PublicEntry {
                js_rel: s.clone(),
                key: ".".to_string(),
                spec: ctx.pkg.name.clone(),
                value: Value::String(s.clone()),
            });
        }
        _ => {
            if let Some(main) = &ctx.pkg.main {
                entries.push(PublicEntry {
                    js_rel: main.clone(),
                    key: ".".to_string(),
                    spec: ctx.pkg.name.clone(),
                    value: Value::String(main.clone()),
                });
            }
        }
    }
    entries
}

pub fn list_modules(ctx: &PublicCtx) -> Vec<PublicMod> {
    public_entries(ctx)
        .into_iter()
        .filter(|e| !e.js_rel.is_empty())
        .map(|e| {
            let js_file = ctx.cwd.join(&e.js_rel).to_string_lossy().into_owned();
            let dts_file = dts_path(&e.value)
                .map(|d| ctx.cwd.join(&d).to_string_lossy().into_owned())
                .unwrap_or_default();
            PublicMod {
                dts_file,
                js_file,
                key: e.key,
                spec: e.spec,
            }
        })
        .collect()
}

/// Sorted unique strings.
pub fn sorted<I: IntoIterator<Item = String>>(items: I) -> Vec<String> {
    let mut v: Vec<String> = items.into_iter().collect();
    v.sort();
    v.dedup();
    v
}

pub const SRC_EXT: &str = r"\.[cm]?[jt]s";
pub static ONLY_EXT: Lazy<regex::Regex> =
    Lazy::new(|| regex::Regex::new(&format!("(?:{})$", SRC_EXT)).unwrap());

use once_cell::sync::Lazy;

/// Determine if `name` is a valid JS identifier.
pub fn ident(name: &str) -> bool {
    !name.is_empty()
        && name
            .chars()
            .enumerate()
            .all(|(i, c)| c.is_alphanumeric() || c == '_' || c == '$' || (i > 0 && c == '-'))
}

/// Format an import line for a module spec + optional named export.
pub fn import_line(spec: &str, export: Option<&str>, is_default: bool) -> String {
    match export {
        None => format!("import '{}';", spec),
        Some(e) if is_default => format!("import {} from '{}';", e, spec),
        Some(e) => format!("import {{ {} }} from '{}';", e, spec),
    }
}
