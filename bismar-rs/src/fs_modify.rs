//! Filesystem mutations: temp dirs, archive extraction, npm subprocess.
//! Maps bismar's src/fs-modify.ts.

use crate::env::progress_show;
use anyhow::{bail, Context, Result};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;

// ── Safe extensions allowed in temp dirs ─────────────────────────────────────

static SAFE_EXTS: &[&str] = &[
    ".cjs", ".js", ".json", ".mjs", ".ts", ".crate", ".gem", ".gz", ".zip", ".whl", ".tar",
];

// ── Temp dir management ───────────────────────────────────────────────────────

/// Return (or create) the bismar run temp dir.
pub fn temp_dir() -> Result<PathBuf> {
    let base = std::env::temp_dir();
    let dir = base.join("bismar-run");
    fs::create_dir_all(&dir)?;
    set_private(&dir)?;
    Ok(dir)
}

/// Remove a temp directory (must be under the OS temp dir and start with bismar-).
pub fn rm_temp_dir(path: &Path) -> Result<()> {
    if !in_bismar_tmp(path) {
        bail!("refusing to remove non-bismar path: {}", path.display());
    }
    if path.exists() {
        fs::remove_dir_all(path).with_context(|| format!("removing {}", path.display()))?;
    }
    Ok(())
}

/// Remove all bismar temp directories.
pub fn clear_temp_caches() -> Result<()> {
    let base = std::env::temp_dir();
    for entry in fs::read_dir(&base)
        .with_context(|| format!("reading {}", base.display()))?
        .flatten()
    {
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if name_str.starts_with("bismar-") {
            let _ = fs::remove_dir_all(entry.path());
        }
    }
    Ok(())
}

fn in_bismar_tmp(path: &Path) -> bool {
    let base = std::env::temp_dir();
    if let Ok(rel) = path.strip_prefix(&base) {
        if let Some(first) = rel.components().next() {
            return first.as_os_str().to_string_lossy().starts_with("bismar-");
        }
    }
    false
}

#[cfg(unix)]
fn set_private(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
        .with_context(|| format!("setting permissions on {}", path.display()))
}

#[cfg(not(unix))]
fn set_private(_path: &Path) -> Result<()> {
    Ok(())
}

/// Return (or create) a named, private machine-level cache dir.
pub fn private_cache_dir(name: &str, child: &str) -> Result<PathBuf> {
    let base = std::env::temp_dir();
    let dir = base.join(name).join(child);
    fs::create_dir_all(&dir)?;
    set_private(&dir)?;
    Ok(dir)
}

// ── File write / append ───────────────────────────────────────────────────────

/// Write data to a path inside a bismar temp dir.
pub fn write(path: &Path, data: &[u8]) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, data).with_context(|| format!("writing {}", path.display()))
}

pub fn write_text(path: &Path, data: &str) -> Result<()> {
    write(path, data.as_bytes())
}

/// Append to a log file (for BISMAR_LOG).
pub fn append_log(path: &Path, data: &str) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut f = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?;
    f.write_all(data.as_bytes())?;
    Ok(())
}

// ── Atomic promotion ──────────────────────────────────────────────────────────

/// Atomically rename `src` → `dst`. Returns true on success, false if `dst`
/// already exists and is valid (concurrent winner).
pub fn promote_temp(src: &Path, dst: &Path) -> bool {
    if dst.exists() {
        return false;
    }
    if let Some(parent) = dst.parent() {
        let _ = fs::create_dir_all(parent);
    }
    fs::rename(src, dst).is_ok()
}

// ── Archive extraction ────────────────────────────────────────────────────────

/// Maximum uncompressed archive size (512 MiB).
pub const MAX_ARCHIVE_BYTES: u64 = 512 * 1024 * 1024;
/// Maximum compressed member path depth.
const MAX_PATH_DEPTH: usize = 64;

/// Extract a .tar.gz or .zip archive into `out_dir`.
pub fn extract_archive(bytes: &[u8], out_dir: &Path) -> Result<()> {
    fs::create_dir_all(out_dir)?;
    // Detect zip by magic bytes (PK\x03\x04).
    if bytes.starts_with(b"PK\x03\x04") {
        extract_zip(bytes, out_dir)
    } else {
        extract_tar(bytes, out_dir)
    }
}

fn safe_member_path(path: &Path) -> Result<PathBuf> {
    let mut out = PathBuf::new();
    let depth = path.components().count();
    if depth > MAX_PATH_DEPTH {
        bail!("archive path too deep: {}", path.display());
    }
    for comp in path.components() {
        use std::path::Component::*;
        if let Normal(c) = comp {
            let s = c.to_string_lossy();
            // Reject Windows device names and traversal tricks.
            if s.contains('\0') || s == ".." {
                bail!("unsafe archive path component: {:?}", s);
            }
            out.push(c);
        }
    }
    Ok(out)
}

fn check_windows_safe(name: &str) -> Result<()> {
    // Reject Windows reserved device names when running cross-platform.
    static RESERVED: &[&str] = &[
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
        "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ];
    let stem = name.split('.').next().unwrap_or(name).to_uppercase();
    if RESERVED.contains(&stem.as_str()) {
        bail!("unsafe Windows reserved name in archive: {}", name);
    }
    Ok(())
}

pub fn extract_tar(bytes: &[u8], out_dir: &Path) -> Result<()> {
    use flate2::read::GzDecoder;
    use tar::Archive;

    let gz = GzDecoder::new(bytes);
    let mut archive = Archive::new(gz);
    let mut total: u64 = 0;

    for entry in archive.entries()? {
        let mut entry = entry?;
        let header = entry.header();

        // Skip non-files (symlinks, devices, directories).
        let entry_type = header.entry_type();
        if !entry_type.is_file() {
            continue;
        }

        let path = entry.path()?;
        let safe = safe_member_path(&path)?;
        if let Some(name) = safe.file_name() {
            check_windows_safe(&name.to_string_lossy())?;
        }

        let size = header.size()?;
        total += size;
        if total > MAX_ARCHIVE_BYTES {
            bail!("archive too large (>{} bytes)", MAX_ARCHIVE_BYTES);
        }

        let out_path = out_dir.join(&safe);
        if let Some(parent) = out_path.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut f = fs::File::create(&out_path)?;
        let mut buf = vec![0u8; size as usize];
        entry.read_exact(&mut buf)?;
        f.write_all(&buf)?;
    }
    Ok(())
}

pub fn extract_zip(bytes: &[u8], out_dir: &Path) -> Result<()> {
    use std::io::Cursor;
    use zip::ZipArchive;

    let cursor = Cursor::new(bytes);
    let mut archive = ZipArchive::new(cursor)?;
    let mut total: u64 = 0;

    for i in 0..archive.len() {
        let mut file = archive.by_index(i)?;
        if file.is_dir() {
            continue;
        }
        let raw_path = file.mangled_name();
        let safe = safe_member_path(&raw_path)?;
        if let Some(name) = safe.file_name() {
            check_windows_safe(&name.to_string_lossy())?;
        }

        let size = file.size();
        total += size;
        if total > MAX_ARCHIVE_BYTES {
            bail!("archive too large (>{} bytes)", MAX_ARCHIVE_BYTES);
        }

        let out_path = out_dir.join(&safe);
        if let Some(parent) = out_path.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut out_file = fs::File::create(&out_path)?;
        let mut buf = Vec::with_capacity(size as usize);
        file.read_to_end(&mut buf)?;
        out_file.write_all(&buf)?;
    }
    Ok(())
}

// ── npm subprocess ────────────────────────────────────────────────────────────

const NPM_INSTALL_ARGS: &[&str] = &[
    "install",
    "--force",
    "--prefer-offline",
    "--ignore-scripts",
    "--no-package-lock",
    "--no-audit",
    "--no-fund",
];

/// Run `npm install` in `dir`. Pass `online = true` to skip `--prefer-offline`.
pub fn npm_install(dir: &Path, online: bool) -> Result<()> {
    progress_show(&format!("npm install {}", dir.display()));
    let args: Vec<&str> = NPM_INSTALL_ARGS
        .iter()
        .filter(|&&a| !online || a != "--prefer-offline")
        .copied()
        .collect();
    let status = Command::new("npm")
        .args(&args)
        .current_dir(dir)
        .status()
        .context("running npm install")?;
    if !status.success() {
        bail!("npm install failed in {}", dir.display());
    }
    Ok(())
}

/// Run `npm pack` in `pkg_dir`, copying the tarball to `out_dir`. Returns the
/// tarball path.
pub fn npm_pack(pkg_dir: &Path, out_dir: &Path) -> Result<PathBuf> {
    fs::create_dir_all(out_dir)?;
    let output = Command::new("npm")
        .args(["pack", "--json"])
        .current_dir(pkg_dir)
        .output()
        .context("running npm pack")?;
    if !output.status.success() {
        bail!(
            "npm pack failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    let json: serde_json::Value =
        serde_json::from_slice(&output.stdout).context("parsing npm pack output")?;
    let filename = json[0]["filename"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("npm pack: missing filename"))?;
    let src = pkg_dir.join(filename);
    let dst = out_dir.join(filename);
    fs::copy(&src, &dst)?;
    let _ = fs::remove_file(&src);
    Ok(dst)
}

/// Write a minimal package.json at `path`.
pub fn write_pkg(path: &Path, content: &str) -> Result<()> {
    write_text(path, content)
}

/// Write a .npmrc that points npm at the JSR npm-compat registry.
pub fn write_jsr_npmrc(dir: &Path) -> Result<()> {
    fs::create_dir_all(dir)?;
    write_text(&dir.join(".npmrc"), "@jsr:registry=https://npm.jsr.io\n")
}

/// Compute the SHA-256 digest of a byte slice.
pub fn sha256(data: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(data);
    format!("{:x}", h.finalize())
}

/// Remove the temp dir if it exists (safe to call multiple times).
pub fn rm(path: &Path) -> Result<()> {
    if path.is_dir() {
        fs::remove_dir_all(path)?;
    } else if path.exists() {
        fs::remove_file(path)?;
    }
    Ok(())
}
