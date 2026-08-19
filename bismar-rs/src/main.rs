#!/usr/bin/env bismar
#![allow(dead_code)]

//! bismar — Browse, weigh, and diff packages from any registry.
//! Rust port of the TypeScript bismar CLI.

mod cli;
#[allow(dead_code)]
mod diff;
#[allow(dead_code)]
mod env;
#[allow(dead_code)]
mod fs_modify;
#[allow(dead_code)]
mod interactive;
#[allow(dead_code)]
mod public;
#[allow(dead_code)]
mod refs;
#[allow(dead_code)]
mod registries;
#[allow(dead_code)]
mod size;
#[allow(dead_code)]
mod surface;

use crate::cli::{parse_args, USAGE};
use crate::diff::{
    bundle_stat_csv, bundle_stat_human, diff_bundle_rows, diff_target, diff_trees, measured_side,
    pack_local_sides, render_unified_highlighted, stat_csv, stat_human, walk_files,
};
use crate::env::{csv_enabled, paint, stdout_color, want_color, Color};
use crate::fs_modify::{clear_temp_caches, temp_dir};
use crate::interactive::{run_diff_interactive, run_interactive};
use crate::public::explicit_path;
use crate::refs::{as_ref_str, explicit_ref, parse_npm_ref};
use crate::registries::{is_registry_selector, parse_registry_ref, registry_context};
use crate::size::run_size;
use crate::surface::{file_sizes_csv, file_sizes_human};
use anyhow::{bail, Result};
use std::io::{self, Write};

/// Call the blocking `registry_context` from an async context without
/// blocking the Tokio executor thread.
async fn fetch_registry(
    out_dir: std::path::PathBuf,
    r: crate::registries::RegistryRef,
) -> Result<crate::registries::RegistryContext> {
    tokio::task::spawn_blocking(move || registry_context(&out_dir, &r))
        .await
        .map_err(|e| anyhow::anyhow!("registry context panicked: {}", e))?
}

#[tokio::main]
async fn main() {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    if let Err(e) = run_cli(argv).await {
        let _ = writeln!(
            std::io::stderr(),
            "{} {}",
            paint("error:", Color::RED, want_color()),
            e
        );
        std::process::exit(1);
    }
}

async fn run_cli(argv: Vec<String>) -> Result<()> {
    let args = parse_args(&argv);

    if args.help || argv.is_empty() {
        println!("{}", USAGE);
        return Ok(());
    }

    // --clear
    if args.clear {
        clear_temp_caches()?;
        return Ok(());
    }

    let cwd = std::env::current_dir()?;
    let out_dir = temp_dir()?;

    // --diff
    if args.diff {
        if args.paths.len() < 2 {
            bail!("--diff requires two selectors");
        }
        let raw_a = &args.paths[0];
        let raw_b = &args.paths[1];

        // Non-interactive size stats: -ds / -dbs / -dbsm
        let size_only = args.size && !args.interactive;
        if size_only && !args.bundle {
            // -ds: plain file-size diff stat table
            let a_side = diff_target(&out_dir, raw_a, &cwd, false)?;
            let b_side = diff_target(&out_dir, raw_b, &cwd, false)?;
            let (a_packed, b_packed) = pack_local_sides(&out_dir, a_side, b_side);
            let diff = diff_trees(
                &a_packed.dir,
                &b_packed.dir,
                a_packed.sel.as_deref(),
                b_packed.sel.as_deref(),
            );
            if csv_enabled() {
                println!("{}", stat_csv(&diff.entries));
            } else {
                println!(
                    "{}",
                    stat_human(&a_packed.label, &b_packed.label, &diff, stdout_color())
                );
            }
            return Ok(());
        }

        if args.bundle && args.size {
            // -dbs / -dbsm: diff of bundle sizes
            let a_side = diff_target(&out_dir, raw_a, &cwd, true)?;
            let b_side = diff_target(&out_dir, raw_b, &cwd, true)?;
            let _a_measured = measured_side(&out_dir, a_side);
            let _b_measured = measured_side(&out_dir, b_side);
            // Measure both sides with esbuild (delegated to size module).
            let a_bf = crate::size::build_first(raw_a, &out_dir)?;
            let b_bf = crate::size::build_first(raw_b, &out_dir)?;
            let a_rows = crate::size::measure_rows(&a_bf, args.minify, false)?;
            let b_rows = crate::size::measure_rows(&b_bf, args.minify, false)?;
            let a_map: std::collections::HashMap<String, Vec<f64>> = a_rows
                .iter()
                .map(|r| {
                    (
                        r.id.clone(),
                        vec![r.loc, r.min_bytes, r.gz_bytes, r.plain_bytes],
                    )
                })
                .collect();
            let b_map: std::collections::HashMap<String, Vec<f64>> = b_rows
                .iter()
                .map(|r| {
                    (
                        r.id.clone(),
                        vec![r.loc, r.min_bytes, r.gz_bytes, r.plain_bytes],
                    )
                })
                .collect();
            let bundle_rows = diff_bundle_rows(&a_map, &b_map);
            if csv_enabled() {
                println!("{}", bundle_stat_csv(&bundle_rows));
            } else {
                println!(
                    "{}",
                    bundle_stat_human(raw_a, raw_b, &bundle_rows, stdout_color())
                );
            }
            return Ok(());
        }

        // Interactive diff
        let a_side = diff_target(&out_dir, raw_a, &cwd, false)?;
        let b_side = diff_target(&out_dir, raw_b, &cwd, false)?;
        let (a_packed, b_packed) = pack_local_sides(&out_dir, a_side, b_side);
        let diff = diff_trees(
            &a_packed.dir,
            &b_packed.dir,
            a_packed.sel.as_deref(),
            b_packed.sel.as_deref(),
        );

        if !stdout_color() {
            // Non-TTY: emit unified diff to stdout.
            println!(
                "{}",
                render_unified_highlighted(&a_packed.dir, &b_packed.dir, &diff.entries, false)
            );
        } else {
            run_diff_interactive(
                a_packed.dir.clone(),
                b_packed.dir.clone(),
                a_packed.label.clone(),
                b_packed.label.clone(),
                diff.entries,
            )?;
        }
        return Ok(());
    }

    // No selector
    if args.paths.is_empty() {
        println!("{}", USAGE);
        return Ok(());
    }

    let raw = &args.paths[0];

    // --size / plain
    if args.size && !args.bundle {
        if is_registry_selector(raw) {
            let r = parse_registry_ref(raw);
            let ctx = fetch_registry(out_dir.clone(), r.clone()).await?;
            let sel = if r.path.is_empty() {
                None
            } else {
                Some(r.path.as_str())
            };
            if csv_enabled() {
                println!("{}", file_sizes_csv(&ctx.pkg_dir, sel, &ctx.label));
            } else {
                println!(
                    "{}",
                    file_sizes_human(&ctx.pkg_dir, sel, &ctx.label, stdout_color())
                );
            }
        } else if explicit_ref(raw) {
            let r = parse_npm_ref(&as_ref_str(raw))?;
            let got = crate::refs::installed_ref(&out_dir, &r, true)?;
            let sel = if r.path.is_empty() {
                None
            } else {
                Some(r.path.as_str())
            };
            if csv_enabled() {
                println!("{}", file_sizes_csv(&got.pkg_dir, sel, &got.label));
            } else {
                println!(
                    "{}",
                    file_sizes_human(&got.pkg_dir, sel, &got.label, stdout_color())
                );
            }
        } else if explicit_path(raw) || raw == "." {
            let dir = cwd.join(raw);
            if csv_enabled() {
                println!("{}", file_sizes_csv(&dir, None, raw));
            } else {
                println!("{}", file_sizes_human(&dir, None, raw, stdout_color()));
            }
        } else {
            // JS package by name: use size module.
            let result = run_size(raw, false, false, false)?;
            println!("{}", result);
        }
        return Ok(());
    }

    // --bundle (-b) / --minify (-m) / --size (-bs/-bsm)
    if args.bundle {
        if is_registry_selector(raw) {
            // Non-JS: download and emit the raw archive bytes to stdout.
            let r = parse_registry_ref(raw);
            let bytes = crate::registries::registry_archive(&out_dir, &r)?;
            io::stdout().write_all(&bytes)?;
            return Ok(());
        }
        // JS: delegate to size / esbuild.
        let result = run_size(raw, true, args.minify, false)?;
        print!("{}", result);
        return Ok(());
    }

    // --list (-l)
    if args.list {
        let result = run_size(raw, false, false, true)?;
        println!("{}", result);
        return Ok(());
    }

    // Interactive navigator (default for a selector with no flag).
    if is_registry_selector(raw) {
        let r = parse_registry_ref(raw);
        let ctx = fetch_registry(out_dir.clone(), r.clone()).await?;
        if stdout_color() {
            run_interactive(ctx.pkg_dir, ctx.label)?;
        } else {
            // Non-TTY: print file listing.
            let files = walk_files(&ctx.pkg_dir);
            let mut sorted: Vec<String> = files.into_keys().collect();
            sorted.sort();
            for f in sorted {
                println!("{}", f);
            }
        }
        return Ok(());
    }

    if explicit_ref(raw) {
        let r = parse_npm_ref(&as_ref_str(raw))?;
        let got = crate::refs::installed_ref(&out_dir, &r, true)?;
        if stdout_color() {
            run_interactive(got.pkg_dir, got.label)?;
        } else {
            let files = walk_files(&got.pkg_dir);
            let mut sorted: Vec<String> = files.into_keys().collect();
            sorted.sort();
            for f in sorted {
                println!("{}", f);
            }
        }
        return Ok(());
    }

    if explicit_path(raw) || raw == "." {
        let dir = cwd.join(raw);
        if stdout_color() {
            run_interactive(dir, raw.to_string())?;
        } else {
            let files = walk_files(&dir);
            let mut sorted: Vec<String> = files.into_keys().collect();
            sorted.sort();
            for f in sorted {
                println!("{}", f);
            }
        }
        return Ok(());
    }

    // Bare name: treat as npm ref.
    let r = parse_npm_ref(&format!("npm:{}", raw))?;
    let got = crate::refs::installed_ref(&out_dir, &r, true)?;
    if stdout_color() {
        run_interactive(got.pkg_dir, got.label)?;
    } else {
        let files = walk_files(&got.pkg_dir);
        let mut sorted: Vec<String> = files.into_keys().collect();
        sorted.sort();
        for f in sorted {
            println!("{}", f);
        }
    }
    Ok(())
}
