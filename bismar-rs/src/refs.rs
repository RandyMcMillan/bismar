//! External npm/jsr package refs: selector classification, ref parsing,
//! installs into bismar-owned dirs, and the per-ref measurement cache.
//! Maps bismar's src/refs.ts.

use crate::env::progress_show;
use crate::fs_modify::{
    npm_install, private_cache_dir, promote_temp, rm_temp_dir, write_jsr_npmrc, write_pkg,
    write_text,
};
use crate::public::{bad, read_json, read_text, slug, Pkg};
use anyhow::{bail, Result};
use once_cell::sync::Lazy;
use regex::Regex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

// ── ExternalRef ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct ExternalRef {
    pub bare: String,
    pub jsr: bool,
    pub label: String,
    pub path: String,
    pub version: String,
}

static PINNED: Lazy<Regex> = Lazy::new(|| Regex::new(r"^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$").unwrap());

pub fn is_pinned(version: &str) -> bool {
    PINNED.is_match(version)
}

pub const TAG_TTL_MS: u64 = 15 * 60_000;
pub const SIZES_V: u32 = 1;

pub fn parse_npm_ref(raw: &str) -> Result<ExternalRef> {
    let jsr = raw.starts_with("jsr:");
    let body = &raw["npm:".len()..]; // both prefixes are 4 chars
    let parts: Vec<&str> = body.split('/').collect();
    let name_parts: Vec<&str> = if body.starts_with('@') {
        parts[..2.min(parts.len())].to_vec()
    } else {
        parts[..1].to_vec()
    };
    let name = name_parts.join("/");
    let at = name.rfind('@').unwrap_or(0);
    let (bare, version) = if at > 0 {
        (name[..at].to_string(), name[at + 1..].to_string())
    } else {
        (name.clone(), String::new())
    };

    let valid_name = Regex::new(r"^(@[\w.-]+/)?[\w.-]+$")
        .unwrap()
        .is_match(&bare);
    let scoped_incomplete = body.starts_with('@') && parts.len() < 2;
    let bad_version = version.contains(':') || version.contains('+');

    if !valid_name || scoped_incomplete || bad_version {
        let _site = if jsr { "jsr.io" } else { "npmjs.com" };
        let fmt = if jsr {
            format!(
                "invalid jsr ref: {}; use jsr:@scope/name@version/module/export",
                bad(raw)
            )
        } else {
            format!(
                "invalid npm ref: {}; use npm:name@version/module/export",
                bad(raw)
            )
        };
        bail!("{}", fmt);
    }
    if jsr && !bare.starts_with('@') {
        bail!(
            "invalid jsr ref: {}; use jsr:@scope/name@version/module/export",
            bad(raw)
        );
    }

    let path = parts[name_parts.len()..].join("/");
    let label = if jsr {
        format!("jsr:{}", name)
    } else {
        name.clone()
    };
    Ok(ExternalRef {
        bare,
        jsr,
        label,
        path,
        version,
    })
}

fn install_name(r: &ExternalRef) -> String {
    if r.jsr {
        format!("@jsr/{}", r.bare[1..].replace('/', "__"))
    } else {
        r.bare.clone()
    }
}

fn installed_at(base: &Path, r: &ExternalRef) -> PathBuf {
    base.join("node_modules")
        .join(install_name(r))
        .join("package.json")
}

// ── Cache dirs ────────────────────────────────────────────────────────────────

pub fn refs_root() -> Result<PathBuf> {
    private_cache_dir("bismar-refs", "v2")
}

pub fn cache_key(label: &str) -> String {
    let readable = slug(label);
    let readable = if readable.is_empty() {
        "ref"
    } else {
        &readable[..readable.len().min(48)]
    }
    .to_string();
    let mut h = Sha256::new();
    h.update(label.as_bytes());
    let digest = format!("{:x}", h.finalize());
    format!("{}-{}", readable, digest)
}

pub fn refs_cache_dir(label: &str) -> Result<PathBuf> {
    let root = refs_root()?;
    let colon = label.find(':').unwrap_or(usize::MAX);
    let (prefix, rest) = if colon < label.len() {
        (&label[..colon], &label[colon + 1..])
    } else {
        ("npm", label)
    };
    Ok(root.join(prefix).join(cache_key(rest)))
}

pub fn refs_tag_file(label: &str) -> Result<PathBuf> {
    let root = refs_root()?;
    Ok(root
        .join(".tags")
        .join(format!("{}.json", cache_key(label))))
}

pub fn refs_meta_file(label: &str) -> Result<PathBuf> {
    let root = refs_root()?;
    Ok(root
        .join(".meta")
        .join(format!("{}.json", cache_key(label))))
}

// ── Version tags ──────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
struct VersionTag {
    at: u64,
    label: String,
    v: u32,
    version: String,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub fn read_version_tag(label: &str, ttl_scale: u64) -> Option<String> {
    let file = refs_tag_file(label).ok()?;
    let tag: VersionTag = read_json(&file).ok()?;
    if tag.v == 2 && tag.label == label && (now_ms() - tag.at) < TAG_TTL_MS * ttl_scale {
        Some(tag.version)
    } else {
        None
    }
}

pub fn write_version_tag(label: &str, version: &str) -> Result<()> {
    let file = refs_tag_file(label)?;
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tag = VersionTag {
        at: now_ms(),
        label: label.to_string(),
        v: 2,
        version: version.to_string(),
    };
    write_text(&file, &format!("{}\n", serde_json::to_string(&tag)?))
}

// ── Cache identity / meta ─────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
struct RefCacheMeta {
    #[serde(skip_serializing_if = "Option::is_none")]
    archive_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    archive_sha256: Option<String>,
    label: String,
    v: u32,
}

fn read_cache_meta(label: &str) -> Option<RefCacheMeta> {
    let file = refs_meta_file(label).ok()?;
    let meta: RefCacheMeta = read_json(&file).ok()?;
    if meta.v == 2 && meta.label == label {
        Some(meta)
    } else {
        None
    }
}

pub fn has_cache_identity(label: &str) -> bool {
    read_cache_meta(label).is_some()
}

pub fn write_cache_identity(
    label: &str,
    archive_bytes: Option<u64>,
    archive_sha256: Option<String>,
) -> Result<()> {
    let file = refs_meta_file(label)?;
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let meta = RefCacheMeta {
        archive_bytes,
        archive_sha256,
        label: label.to_string(),
        v: 2,
    };
    write_text(&file, &format!("{}\n", serde_json::to_string(&meta)?))
}

pub fn read_archive_bytes(label: &str) -> Option<u64> {
    let b = read_cache_meta(label)?.archive_bytes?;
    if b > 0 {
        Some(b)
    } else {
        None
    }
}

pub fn read_archive_sha256(label: &str) -> Option<String> {
    let d = read_cache_meta(label)?.archive_sha256?;
    if d.len() == 64 && d.chars().all(|c| c.is_ascii_hexdigit()) {
        Some(d)
    } else {
        None
    }
}

pub fn write_archive_bytes(label: &str, bytes: u64, sha256: Option<String>) -> Result<()> {
    write_cache_identity(label, Some(bytes), sha256)
}

// ── RefDb ─────────────────────────────────────────────────────────────────────

pub const REF_DB: &str = "bismar.db.json";

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct RefDbMod {
    pub exports: Vec<String>,
    pub file: String,
    pub module: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RefDbSizes {
    pub esbuild: String,
    pub rows: HashMap<String, Vec<f64>>,
    pub v: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct RefDb {
    pub modules: Option<Vec<RefDbMod>>,
    pub sizes: Option<RefDbSizes>,
    pub v: Option<u32>,
}

pub fn ref_db(ref_dir: &Path) -> RefDb {
    let file = ref_dir.join(REF_DB);
    let Ok(text) = read_text(&file) else {
        return RefDb::default();
    };
    let Ok(raw): Result<serde_json::Value, _> = serde_json::from_str(&text) else {
        return RefDb::default();
    };
    if raw.get("v") != Some(&serde_json::Value::Number(1.into())) {
        return RefDb::default();
    }
    let modules = raw.get("modules").and_then(|m| {
        let mods: Option<Vec<RefDbMod>> = serde_json::from_value(m.clone()).ok();
        mods.filter(|ms| ms.iter().all(|m| !m.file.is_empty()))
    });
    let sizes = raw.get("sizes").and_then(|s| {
        let sizes: Option<RefDbSizes> = serde_json::from_value(s.clone()).ok();
        sizes.filter(|s| s.v == SIZES_V)
    });
    RefDb {
        modules,
        sizes,
        v: Some(1),
    }
}

pub fn save_ref_db(ref_dir: &Path, patch: &RefDb) -> Result<()> {
    let file = ref_dir.join(REF_DB);
    let existing: serde_json::Value = read_text(&file)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or(serde_json::json!({"v": 1}));
    let mut merged = if let serde_json::Value::Object(map) = existing {
        map
    } else {
        serde_json::Map::new()
    };
    if let Some(mods) = &patch.modules {
        merged.insert("modules".to_string(), serde_json::to_value(mods)?);
    }
    if let Some(sizes) = &patch.sizes {
        merged.insert("sizes".to_string(), serde_json::to_value(sizes)?);
    }
    merged.insert("v".to_string(), serde_json::json!(1));
    write_text(&file, &format!("{}\n", serde_json::to_string(&merged)?))
}

// ── InstalledRef ──────────────────────────────────────────────────────────────

pub struct InstalledRef {
    pub label: String,
    pub pkg: Pkg,
    pub pkg_dir: PathBuf,
    pub pkg_file: PathBuf,
    pub ref_dir: PathBuf,
}

fn pinned_dir_of(r: &ExternalRef, version: &str) -> Result<PathBuf> {
    let label = format!("{}{}@{}", if r.jsr { "jsr:" } else { "" }, r.bare, version);
    refs_cache_dir(&label)
}

fn valid_ref_cache(dir: &Path, label: &str, r: &ExternalRef, version: &str) -> bool {
    if !has_cache_identity(label) {
        return false;
    }
    let manifest = installed_at(dir, r);
    if let Ok(pkg) = read_json::<Pkg>(&manifest) {
        pkg.name == install_name(r) && pkg.version.as_deref() == Some(version)
    } else {
        false
    }
}

fn install_ref(out_dir: &Path, r: &ExternalRef) -> Result<PathBuf> {
    let version = if is_pinned(&r.version) {
        r.version.clone()
    } else {
        read_version_tag(&r.label, 1).unwrap_or_else(|| r.version.clone())
    };
    let pinned = is_pinned(&version);
    let pinned_dir = if pinned {
        Some(pinned_dir_of(r, &version)?)
    } else {
        None
    };
    let pinned_label = format!("{}{}@{}", if r.jsr { "jsr:" } else { "" }, r.bare, version);

    if let Some(ref pd) = pinned_dir {
        if valid_ref_cache(pd, &pinned_label, r, &version) {
            return Ok(pd.clone());
        }
        if pd.exists() {
            rm_temp_dir(pd)?;
        }
    }

    let dir = out_dir.join(".refs").join(cache_key(&format!(
        "{}@{}",
        r.label,
        if version.is_empty() {
            "latest"
        } else {
            &version
        }
    )));
    std::fs::create_dir_all(&dir)?;
    progress_show(&format!("installing {}", r.label));

    if r.jsr {
        write_jsr_npmrc(&dir)?;
    }
    let dep_version = if version.is_empty() {
        "latest".to_string()
    } else {
        version.clone()
    };
    let pkg_json = format!(
        "{}\n",
        serde_json::to_string_pretty(&serde_json::json!({
            "dependencies": { install_name(r): dep_version },
            "private": true
        }))?
    );
    write_pkg(&dir.join("package.json"), &pkg_json)?;

    npm_install(&dir, false).or_else(|_| {
        if pinned {
            if let Some(ref pd) = pinned_dir {
                if valid_ref_cache(pd, &pinned_label, r, &version) {
                    return Ok(());
                }
            }
        }
        npm_install(&dir, true)
    })?;

    if pinned {
        if let Some(ref pd) = pinned_dir {
            write_cache_identity(&pinned_label, None, None)?;
            if promote_temp(&dir, pd) {
                return Ok(pd.clone());
            }
            if valid_ref_cache(pd, &pinned_label, r, &version) {
                return Ok(pd.clone());
            }
        }
    }

    if !pinned {
        let manifest = installed_at(&dir, r);
        if let Ok(pkg) = read_json::<Pkg>(&manifest) {
            if let Some(got) = pkg.version {
                if is_pinned(&got) {
                    write_version_tag(&r.label, &got)?;
                    let target = pinned_dir_of(r, &got)?;
                    let target_label =
                        format!("{}{}@{}", if r.jsr { "jsr:" } else { "" }, r.bare, got);
                    if !valid_ref_cache(&target, &target_label, r, &got) && !target.exists() {
                        write_cache_identity(&target_label, None, None)?;
                        if promote_temp(&dir, &target)
                            && valid_ref_cache(&target, &target_label, r, &got)
                        {
                            return Ok(target);
                        }
                    }
                }
            }
        }
    }

    Ok(dir)
}

fn ref_label(r: &ExternalRef, pkg: &Pkg) -> String {
    if !r.version.is_empty() || pkg.version.is_none() {
        r.label.clone()
    } else {
        format!(
            "{}{}@{}",
            if r.jsr { "jsr:" } else { "" },
            r.bare,
            pkg.version.as_deref().unwrap_or("")
        )
    }
}

pub fn installed_ref(
    out_dir: &Path,
    r: &ExternalRef,
    entry_optional: bool,
) -> Result<InstalledRef> {
    let ref_dir = install_ref(out_dir, r)?;
    let pkg_file = installed_at(&ref_dir, r);
    let pkg = crate::public::read_pkg(&pkg_file, entry_optional)?;
    let pkg_dir = pkg_file.parent().unwrap_or(&ref_dir).to_path_buf();
    let label = ref_label(r, &pkg);
    Ok(InstalledRef {
        label,
        pkg,
        pkg_dir,
        pkg_file,
        ref_dir,
    })
}

// ── Selector helpers ──────────────────────────────────────────────────────────

static NPM_BARE: Lazy<Regex> = Lazy::new(|| Regex::new(r"^[a-z0-9][\w.-]*$").unwrap());

pub fn npm_hint_of(raw: &str) -> String {
    if raw.starts_with('@') {
        if raw.contains('/') {
            format!("npm:{}", raw)
        } else {
            String::new()
        }
    } else {
        let seg = raw.split('/').next().unwrap_or(raw);
        let at = seg.rfind('@').unwrap_or(usize::MAX);
        let base = if at < seg.len() { &seg[..at] } else { seg };
        if NPM_BARE.is_match(base) {
            format!("npm:{}", raw)
        } else {
            String::new()
        }
    }
}

pub fn npm_hint_use(raw: &str) -> String {
    let hint = npm_hint_of(raw);
    if !hint.is_empty() {
        format!("use {} for the registry package", hint)
    } else {
        String::new()
    }
}

pub fn explicit_ref(raw: &str) -> bool {
    raw.starts_with("npm:") || raw.starts_with("jsr:")
}

pub fn as_ref_str(raw: &str) -> String {
    if explicit_ref(raw) {
        raw.to_string()
    } else {
        format!("npm:{}", raw)
    }
}

pub fn foreign_selector(raw: &str, pkg_name: &str) -> bool {
    explicit_ref(raw)
        || (raw.starts_with('@') && raw != pkg_name && !raw.starts_with(&format!("{}/", pkg_name)))
}

pub fn sole_index_of(mods: &[RefDbMod]) -> bool {
    mods.len() == 1 && mods[0].module == "index"
}

pub fn ref_rename<'a>(
    label: &'a str,
    sole_index: bool,
    pkg_name: &'a str,
) -> impl Fn(&str, Option<&str>) -> String + 'a {
    move |module: &str, leaf: Option<&str>| -> String {
        let leaf = leaf.unwrap_or(module);
        if (!pkg_name.is_empty() && module == pkg_name) || (sole_index && module == "index") {
            label.to_string()
        } else {
            format!("{}/{}", label, leaf)
        }
    }
}
