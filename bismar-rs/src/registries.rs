//! Non-JS registry support: crates.io, rubygems, pypi, packagist, github,
//! gitlab, go proxy. Also the namespace table and registry search.
//! Maps bismar's src/registries.ts.

use crate::env::progress_show;
use crate::fs_modify::{extract_archive, promote_temp, rm};
use crate::refs::{
    cache_key, has_cache_identity, read_archive_bytes, read_version_tag, write_cache_identity,
};
use anyhow::{bail, Context, Result};
use once_cell::sync::Lazy;
use reqwest::blocking::Client;
use reqwest::header::{HeaderMap, HeaderValue, USER_AGENT};
use serde::Deserialize;
use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Duration;

// ── Constants ─────────────────────────────────────────────────────────────────

pub const MAX_METADATA_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_ARCHIVE_BYTES: u64 = 512 * 1024 * 1024;
pub const BIG_ARCHIVE: u64 = 100 * 1024 * 1024;

const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";

// ── HTTP client ───────────────────────────────────────────────────────────────

fn build_client() -> Client {
    let mut headers = HeaderMap::new();
    headers.insert(USER_AGENT, HeaderValue::from_static(UA));
    Client::builder()
        .default_headers(headers)
        .timeout(Duration::from_secs(60))
        .build()
        .expect("building HTTP client")
}

static CLIENT: Lazy<Client> = Lazy::new(build_client);

fn get_bytes(url: &str) -> Result<Vec<u8>> {
    let resp = CLIENT
        .get(url)
        .send()
        .with_context(|| format!("GET {}", url))?;
    if !resp.status().is_success() {
        bail!("HTTP {} for {}", resp.status(), url);
    }
    let bytes = resp.bytes().with_context(|| format!("reading body of {}", url))?;
    if bytes.len() > MAX_METADATA_BYTES {
        bail!("response too large from {}", url);
    }
    Ok(bytes.to_vec())
}

fn get_json<T: for<'de> Deserialize<'de>>(url: &str) -> Result<T> {
    let bytes = get_bytes(url)?;
    serde_json::from_slice(&bytes).with_context(|| format!("parsing JSON from {}", url))
}

fn get_archive(url: &str) -> Result<Vec<u8>> {
    let resp = CLIENT
        .get(url)
        .send()
        .with_context(|| format!("GET {}", url))?;
    if !resp.status().is_success() {
        bail!("HTTP {} for {}", resp.status(), url);
    }
    let bytes = resp.bytes().with_context(|| format!("reading archive body of {}", url))?;
    if bytes.len() as u64 > MAX_ARCHIVE_BYTES {
        bail!("archive too large from {}", url);
    }
    Ok(bytes.to_vec())
}

// ── Base URL overrides ────────────────────────────────────────────────────────

fn env_base(var: &str, default: &str) -> String {
    std::env::var(var).unwrap_or_else(|_| default.to_string())
}

fn crates() -> String {
    env_base("BISMAR_CRATES", "https://crates.io")
}
fn gems() -> String {
    env_base("BISMAR_GEMS", "https://rubygems.org")
}
fn pypi() -> String {
    env_base("BISMAR_PYPI", "https://pypi.org")
}
fn npm_api() -> String {
    env_base("BISMAR_NPM", "https://registry.npmjs.org")
}
fn jsr_api() -> String {
    env_base("BISMAR_JSR", "https://api.jsr.io")
}
fn jsr_npm() -> String {
    env_base("BISMAR_JSR_NPM", "https://npm.jsr.io")
}
fn gh_api() -> String {
    env_base("BISMAR_GH", "https://api.github.com")
}
fn gh_codeload() -> String {
    env_base("BISMAR_GH_CODELOAD", "https://codeload.github.com")
}
fn gitlab_api() -> String {
    env_base("BISMAR_GITLAB", "https://gitlab.com")
}
fn go_proxy() -> String {
    env_base("BISMAR_GO", "https://proxy.golang.org")
}
fn composer() -> String {
    env_base("BISMAR_COMPOSER", "https://repo.packagist.org")
}
fn packagist() -> String {
    env_base("BISMAR_PACKAGIST", "https://packagist.org")
}

// ── Registry table ────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct Registry {
    pub prefix: String,
    pub aliases: Vec<String>,
    pub description: String,
}

pub fn registries() -> HashMap<String, Registry> {
    let list = vec![
        ("npm", vec!["js"], "npm registry"),
        ("jsr", vec!["jsr"], "JSR registry"),
        ("crate", vec!["rs"], "crates.io"),
        ("gem", vec!["rb"], "RubyGems"),
        ("pypi", vec!["py"], "PyPI"),
        ("packagist", vec!["php"], "Packagist/Composer"),
        ("github", vec!["gh"], "GitHub"),
        ("gitlab", vec![], "GitLab"),
        ("go", vec![], "Go module proxy"),
    ];
    let mut map = HashMap::new();
    for (prefix, aliases, description) in list {
        let r = Registry {
            prefix: prefix.to_string(),
            aliases: aliases.iter().map(|s| s.to_string()).collect(),
            description: description.to_string(),
        };
        for alias in &r.aliases {
            map.insert(alias.clone(), r.clone());
        }
        map.insert(prefix.to_string(), r);
    }
    map
}

/// Canonical prefix for a selector (e.g. `js:` → `npm:`).
pub fn canon_selector(raw: &str) -> String {
    let regs = registries();
    if let Some(colon) = raw.find(':') {
        let prefix = &raw[..colon];
        let rest = &raw[colon + 1..];
        if let Some(r) = regs.get(prefix) {
            return format!("{}:{}", r.prefix, rest);
        }
    }
    raw.to_string()
}

pub fn is_registry_selector(raw: &str) -> bool {
    let regs = registries();
    if let Some(colon) = raw.find(':') {
        let prefix = &raw[..colon];
        return regs.contains_key(prefix);
    }
    false
}

// ── RegistryRef ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct RegistryRef {
    pub name: String,
    pub path: String,
    pub prefix: String,
    pub version: String,
}

pub fn parse_registry_ref(raw: &str) -> RegistryRef {
    let canon = canon_selector(raw);
    let colon = canon.find(':').unwrap_or(0);
    let prefix = canon[..colon].to_string();
    let body = &canon[colon + 1..];
    // Split name@version/path
    let slash = body.find('/').unwrap_or(body.len());
    let name_part = &body[..slash];
    let path = if slash < body.len() { &body[slash + 1..] } else { "" };
    let at = name_part.rfind('@').unwrap_or(usize::MAX);
    let (name, version) = if at < name_part.len() {
        (name_part[..at].to_string(), name_part[at + 1..].to_string())
    } else {
        (name_part.to_string(), String::new())
    };
    RegistryRef {
        name,
        path: path.to_string(),
        prefix,
        version,
    }
}

// ── RegistryContext: resolved + extracted package ─────────────────────────────

pub struct RegistryContext {
    pub archive_bytes: Option<u64>,
    pub label: String,
    pub pkg_dir: PathBuf,
}

pub async fn registry_context(out_dir: &Path, r: &RegistryRef) -> Result<RegistryContext> {
    match r.prefix.as_str() {
        "crate" => fetch_crate(out_dir, r).await,
        "gem" => fetch_gem(out_dir, r).await,
        "pypi" => fetch_pypi(out_dir, r).await,
        "packagist" => fetch_packagist(out_dir, r).await,
        "github" => fetch_github(out_dir, r).await,
        "gitlab" => fetch_gitlab(out_dir, r).await,
        "go" => fetch_go(out_dir, r).await,
        p => bail!("unknown registry prefix: {}", p),
    }
}

/// Download a registry archive (with caching) and extract it.
fn download_and_extract(
    label: &str,
    download_url: &str,
    extract_dir: &Path,
) -> Result<RegistryContext> {
    let cache_dir = crate::refs::refs_cache_dir(label)?;

    if has_cache_identity(label) && cache_dir.exists() {
        return Ok(RegistryContext {
            archive_bytes: read_archive_bytes(label),
            label: label.to_string(),
            pkg_dir: cache_dir,
        });
    }

    progress_show(&format!("downloading {}", label));
    let bytes = get_archive(download_url)?;
    let n = bytes.len() as u64;
    let digest = crate::fs_modify::sha256(&bytes);

    let tmp = extract_dir.join(format!("tmp-{}", cache_key(label)));
    std::fs::create_dir_all(&tmp)?;
    extract_archive(&bytes, &tmp)?;

    // Descend single root directory if present.
    let entries: Vec<_> = std::fs::read_dir(&tmp)?.flatten().collect();
    let root = if entries.len() == 1 && entries[0].path().is_dir() {
        entries[0].path()
    } else {
        tmp.clone()
    };

    write_cache_identity(label, Some(n), Some(digest))?;
    if !promote_temp(&root, &cache_dir) {
        // Concurrent winner; use the existing cache.
        if cache_dir.exists() {
            let _ = rm(&tmp);
            return Ok(RegistryContext {
                archive_bytes: read_archive_bytes(label),
                label: label.to_string(),
                pkg_dir: cache_dir,
            });
        }
    }

    Ok(RegistryContext {
        archive_bytes: Some(n),
        label: label.to_string(),
        pkg_dir: cache_dir,
    })
}

// ── crates.io ────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct CrateMeta {
    #[serde(rename = "crate")]
    krate: CrateInfo,
}
#[derive(Deserialize)]
struct CrateInfo {
    newest_version: String,
}

async fn fetch_crate(out_dir: &Path, r: &RegistryRef) -> Result<RegistryContext> {
    let version = if r.version.is_empty() {
        let label = format!("crate:{}", r.name);
        if let Some(v) = read_version_tag(&label, 1) {
            v
        } else {
            let url = format!("{}/api/v1/crates/{}", crates(), r.name);
            let meta: CrateMeta = get_json(&url)?;
            let v = meta.krate.newest_version;
            crate::refs::write_version_tag(&label, &v)?;
            v
        }
    } else {
        r.version.clone()
    };
    let label = format!("crate:{}@{}", r.name, version);
    let download_url = format!(
        "{}/api/v1/crates/{}/{}/download",
        crates(),
        r.name,
        version
    );
    download_and_extract(&label, &download_url, out_dir)
}

// ── RubyGems ──────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct GemMeta {
    version: String,
    gem_uri: Option<String>,
}

async fn fetch_gem(out_dir: &Path, r: &RegistryRef) -> Result<RegistryContext> {
    let url = format!("{}/api/v1/gems/{}.json", gems(), r.name);
    let meta: GemMeta = get_json(&url)?;
    let version = if r.version.is_empty() {
        meta.version.clone()
    } else {
        r.version.clone()
    };
    let label = format!("gem:{}@{}", r.name, version);
    let download_url = format!(
        "{}/gems/{}-{}.gem",
        gems(),
        r.name,
        version
    );
    download_and_extract(&label, &download_url, out_dir)
}

// ── PyPI ──────────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct PypiMeta {
    info: PypiInfo,
    urls: Vec<PypiUrl>,
}
#[derive(Deserialize)]
struct PypiInfo {
    version: String,
}
#[derive(Deserialize)]
struct PypiUrl {
    filename: String,
    url: String,
    packagetype: String,
}

async fn fetch_pypi(out_dir: &Path, r: &RegistryRef) -> Result<RegistryContext> {
    let url = if r.version.is_empty() {
        format!("{}/pypi/{}/json", pypi(), r.name)
    } else {
        format!("{}/pypi/{}/{}/json", pypi(), r.name, r.version)
    };
    let meta: PypiMeta = get_json(&url)?;
    let version = meta.info.version.clone();
    let label = format!("pypi:{}@{}", r.name, version);
    // Prefer wheel over sdist.
    let archive_url = meta
        .urls
        .iter()
        .find(|u| u.packagetype == "bdist_wheel")
        .or_else(|| meta.urls.iter().find(|u| u.packagetype == "sdist"))
        .map(|u| u.url.clone())
        .ok_or_else(|| anyhow::anyhow!("no downloadable archive for pypi:{}", r.name))?;
    download_and_extract(&label, &archive_url, out_dir)
}

// ── Packagist/Composer ────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct P2Entry {
    version: String,
    dist: Option<P2Dist>,
}
#[derive(Deserialize)]
struct P2Dist {
    url: String,
}

async fn fetch_packagist(out_dir: &Path, r: &RegistryRef) -> Result<RegistryContext> {
    let url = format!("{}/p2/{}.json", composer(), r.name);
    let meta: serde_json::Value = get_json(&url)?;
    let packages = meta["packages"][&r.name]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let entry = packages
        .iter()
        .find(|e| {
            r.version.is_empty()
                || e.get("version").and_then(|v| v.as_str()) == Some(&r.version)
        })
        .and_then(|e| serde_json::from_value::<P2Entry>(e.clone()).ok())
        .ok_or_else(|| anyhow::anyhow!("packagist: no matching version for {}", r.name))?;
    let version = entry.version.clone();
    let label = format!("packagist:{}@{}", r.name, version);
    let dist_url = entry
        .dist
        .ok_or_else(|| anyhow::anyhow!("packagist: no dist for {}", r.name))?
        .url;
    download_and_extract(&label, &dist_url, out_dir)
}

// ── GitHub ────────────────────────────────────────────────────────────────────

async fn fetch_github(out_dir: &Path, r: &RegistryRef) -> Result<RegistryContext> {
    let (owner, repo_name) = r.name.split_once('/').unwrap_or((&r.name, ""));
    if repo_name.is_empty() {
        bail!("github ref must be owner/repo: {}", r.name);
    }
    let git_ref = if r.version.is_empty() {
        let url = format!("{}/repos/{}/{}", gh_api(), owner, repo_name);
        let meta: serde_json::Value = get_json(&url)?;
        meta["default_branch"]
            .as_str()
            .unwrap_or("main")
            .to_string()
    } else {
        r.version.clone()
    };
    let label = format!("github:{}@{}", r.name, git_ref);
    let download_url = format!(
        "{}/{}/{}/legacy.tar.gz/{}",
        gh_codeload(),
        owner,
        repo_name,
        git_ref
    );
    download_and_extract(&label, &download_url, out_dir)
}

// ── GitLab ────────────────────────────────────────────────────────────────────

async fn fetch_gitlab(out_dir: &Path, r: &RegistryRef) -> Result<RegistryContext> {
    let encoded = r.name.replace('/', "%2F");
    let git_ref = if r.version.is_empty() {
        let url = format!("{}/api/v4/projects/{}", gitlab_api(), encoded);
        let meta: serde_json::Value = get_json(&url)?;
        meta["default_branch"]
            .as_str()
            .unwrap_or("main")
            .to_string()
    } else {
        r.version.clone()
    };
    let label = format!("gitlab:{}@{}", r.name, git_ref);
    let download_url = format!(
        "{}/api/v4/projects/{}/repository/archive.tar.gz?sha={}",
        gitlab_api(),
        encoded,
        git_ref
    );
    download_and_extract(&label, &download_url, out_dir)
}

// ── Go proxy ─────────────────────────────────────────────────────────────────

async fn fetch_go(out_dir: &Path, r: &RegistryRef) -> Result<RegistryContext> {
    let version = if r.version.is_empty() {
        let label = format!("go:{}", r.name);
        if let Some(v) = read_version_tag(&label, 1) {
            v
        } else {
            let url = format!("{}/{}/@latest", go_proxy(), r.name);
            let meta: serde_json::Value = get_json(&url)?;
            let v = meta["Version"].as_str().unwrap_or("latest").to_string();
            crate::refs::write_version_tag(&label, &v)?;
            v
        }
    } else {
        r.version.clone()
    };
    let label = format!("go:{}@{}", r.name, version);
    let download_url = format!("{}/{}/@v/{}.zip", go_proxy(), r.name, version);
    download_and_extract(&label, &download_url, out_dir)
}

// ── Search ────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct SearchHit {
    pub desc: String,
    pub name: String,
    pub version: String,
}

#[derive(Debug, Clone)]
pub struct HitStats {
    pub deps: Option<u32>,
    pub tgz_bytes: Option<u64>,
    pub version: Option<String>,
}

pub fn can_search(prefix: &str) -> bool {
    matches!(
        prefix,
        "npm" | "jsr" | "crate" | "gem" | "pypi" | "packagist" | "github" | "gitlab"
    )
}

pub fn search_registry(prefix: &str, query: &str) -> Result<Vec<SearchHit>> {
    match prefix {
        "npm" => search_npm(query),
        "jsr" => search_jsr(query),
        "crate" => search_crates(query),
        "gem" => search_gems(query),
        "pypi" => search_pypi(query),
        "packagist" => search_packagist(query),
        "github" => search_github(query),
        _ => Ok(vec![]),
    }
}

fn hit_of(name: &str, version: &str, desc: &str) -> SearchHit {
    SearchHit {
        desc: desc.to_string(),
        name: name.to_string(),
        version: version.to_string(),
    }
}

fn search_npm(query: &str) -> Result<Vec<SearchHit>> {
    let url = format!(
        "{}/search/suggest?q={}&size=10",
        npm_api(),
        urlencoded(query)
    );
    let meta: serde_json::Value = get_json(&url)?;
    Ok(meta
        .as_array()
        .map(|arr| {
            arr.iter()
                .flat_map(|o| {
                    Some(hit_of(
                        o["name"].as_str()?,
                        o["version"].as_str().unwrap_or(""),
                        o["description"].as_str().unwrap_or(""),
                    ))
                })
                .collect()
        })
        .unwrap_or_default())
}

fn search_jsr(query: &str) -> Result<Vec<SearchHit>> {
    let url = format!("{}/packages?query={}&limit=10", jsr_api(), urlencoded(query));
    let meta: serde_json::Value = get_json(&url)?;
    Ok(meta["items"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .flat_map(|o| {
                    Some(hit_of(
                        o["fullName"].as_str()?,
                        "",
                        o["description"].as_str().unwrap_or(""),
                    ))
                })
                .collect()
        })
        .unwrap_or_default())
}

fn search_crates(query: &str) -> Result<Vec<SearchHit>> {
    let url = format!("{}/api/v1/crates?q={}&per_page=10", crates(), urlencoded(query));
    let meta: serde_json::Value = get_json(&url)?;
    Ok(meta["crates"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .flat_map(|o| {
                    Some(hit_of(
                        o["name"].as_str()?,
                        o["newest_version"].as_str().unwrap_or(""),
                        o["description"].as_str().unwrap_or(""),
                    ))
                })
                .collect()
        })
        .unwrap_or_default())
}

fn search_gems(query: &str) -> Result<Vec<SearchHit>> {
    let url = format!("{}/api/v1/search.json?query={}&per_page=10", gems(), urlencoded(query));
    let meta: serde_json::Value = get_json(&url)?;
    Ok(meta
        .as_array()
        .map(|arr| {
            arr.iter()
                .flat_map(|o| {
                    Some(hit_of(
                        o["name"].as_str()?,
                        o["version"].as_str().unwrap_or(""),
                        o["info"].as_str().unwrap_or(""),
                    ))
                })
                .collect()
        })
        .unwrap_or_default())
}

fn search_pypi(query: &str) -> Result<Vec<SearchHit>> {
    // PyPI doesn't have a simple JSON search API; use the JSON API for exact name lookup.
    let _url = format!("{}/search/?q={}&o=&c=&format=json", pypi(), urlencoded(query));
    // Fallback: just return an empty list (PyPI search requires HTML parsing).
    Ok(vec![])
}

fn search_packagist(query: &str) -> Result<Vec<SearchHit>> {
    let url = format!("{}/search.json?q={}&per_page=10", packagist(), urlencoded(query));
    let meta: serde_json::Value = get_json(&url)?;
    Ok(meta["results"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .flat_map(|o| {
                    Some(hit_of(
                        o["name"].as_str()?,
                        "",
                        o["description"].as_str().unwrap_or(""),
                    ))
                })
                .collect()
        })
        .unwrap_or_default())
}

fn search_github(query: &str) -> Result<Vec<SearchHit>> {
    let url = format!(
        "{}/search/repositories?q={}&per_page=10",
        gh_api(),
        urlencoded(query)
    );
    let meta: serde_json::Value = get_json(&url)?;
    Ok(meta["items"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .flat_map(|o| {
                    Some(hit_of(
                        o["full_name"].as_str()?,
                        "",
                        o["description"].as_str().unwrap_or(""),
                    ))
                })
                .collect()
        })
        .unwrap_or_default())
}

// ── Profile ───────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct ProfileRef {
    pub prefix: String,
    pub user: String,
}

pub fn parse_profile_ref(raw: &str) -> Option<ProfileRef> {
    let colon = raw.find(':')?;
    let prefix_raw = &raw[..colon];
    let user = raw[colon + 1..].to_string();
    // Accept @user for github
    let regs = registries();
    let reg = regs.get(prefix_raw)?;
    if user.is_empty() {
        return None;
    }
    // Only github/gitlab/npm support profiles.
    if !matches!(reg.prefix.as_str(), "github" | "gitlab" | "npm" | "jsr") {
        return None;
    }
    Some(ProfileRef {
        prefix: reg.prefix.clone(),
        user,
    })
}

pub fn can_profile(prefix: &str) -> bool {
    matches!(prefix, "github" | "gitlab" | "npm" | "jsr" | "crate" | "gem")
}

pub fn profile_hits(prefix: &str, user: &str) -> Result<Vec<SearchHit>> {
    match prefix {
        "github" => {
            let url = format!("{}/users/{}/repos?per_page=25&sort=updated", gh_api(), user);
            let repos: serde_json::Value = get_json(&url)?;
            Ok(repos
                .as_array()
                .map(|arr| {
                    arr.iter()
                        .flat_map(|r| {
                            Some(hit_of(
                                r["full_name"].as_str()?,
                                "",
                                r["description"].as_str().unwrap_or(""),
                            ))
                        })
                        .collect()
                })
                .unwrap_or_default())
        }
        "npm" => {
            let url = format!("{}/-/v1/search?text=maintainer:{}&size=25", npm_api(), user);
            let meta: serde_json::Value = get_json(&url)?;
            Ok(meta["objects"]
                .as_array()
                .map(|arr| {
                    arr.iter()
                        .flat_map(|o| {
                            Some(hit_of(
                                o["package"]["name"].as_str()?,
                                o["package"]["version"].as_str().unwrap_or(""),
                                o["package"]["description"].as_str().unwrap_or(""),
                            ))
                        })
                        .collect()
                })
                .unwrap_or_default())
        }
        _ => Ok(vec![]),
    }
}

/// Get tgz size and version for npm/jsr hits (used in diff footer garnish).
pub fn js_hit_stats(prefix: &str, hit: &SearchHit) -> Result<Option<HitStats>> {
    let url = if prefix == "jsr:" {
        format!("{}/{}", jsr_npm(), hit.name)
    } else {
        format!("{}/{}", npm_api(), hit.name)
    };
    let meta: serde_json::Value = get_json(&url)?;
    let version = meta["dist-tags"]["latest"]
        .as_str()
        .or_else(|| Some(hit.version.as_str()))
        .unwrap_or("")
        .to_string();
    let tgz_bytes = meta["versions"][&version]["dist"]["unpackedSize"]
        .as_u64()
        .or_else(|| meta["versions"][&version]["dist"]["tarball"].as_str().map(|_| 0));
    Ok(Some(HitStats {
        deps: None,
        tgz_bytes,
        version: Some(version),
    }))
}

pub fn registry_archive(_out_dir: &Path, r: &RegistryRef) -> Result<Vec<u8>> {
    // Return the raw archive bytes for a ref (used by -b for non-JS packages).
    let url = match r.prefix.as_str() {
        "crate" => format!(
            "{}/api/v1/crates/{}/{}/download",
            crates(),
            r.name,
            r.version
        ),
        "gem" => format!("{}/gems/{}-{}.gem", gems(), r.name, r.version),
        _ => bail!("raw archive download not supported for prefix: {}", r.prefix),
    };
    get_archive(&url)
}

fn urlencoded(s: &str) -> String {
    // Simple percent-encoding of non-unreserved characters.
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{:02X}", b));
        }
    }
    out
}
