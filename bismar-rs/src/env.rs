//! Shared environment detection: colors, progress, CSV, and terminal-safe output.
//! Maps bismar's src/env.ts.

use once_cell::sync::Lazy;
use std::io::Write;
use std::sync::Mutex;
use std::time::{Duration, Instant};

// ── Color detection ──────────────────────────────────────────────────────────

/// Returns true when ANSI color should be used for *stderr* output (progress,
/// warnings). Honors CLICOLOR_FORCE / FORCE_COLOR / NO_COLOR / CLICOLOR, then
/// falls back to whether stderr is a TTY.
pub fn want_color() -> bool {
    let env_force = std::env::var("CLICOLOR_FORCE").ok();
    if let Some(ref v) = env_force {
        if v != "0" {
            return true;
        }
    }
    let force_color = std::env::var("FORCE_COLOR").ok();
    if let Some(ref v) = force_color {
        if v != "0" {
            return true;
        }
    }
    if std::env::var("NO_COLOR").is_ok() {
        return false;
    }
    if force_color.as_deref() == Some("0") {
        return false;
    }
    if std::env::var("CLICOLOR").as_deref() == Ok("0") {
        return false;
    }
    stderr_is_tty()
}

/// Returns true when ANSI color should be used for *stdout* output (diffs,
/// listings). Like want_color but keyed to stdout.
pub fn stdout_color() -> bool {
    let env_force = std::env::var("CLICOLOR_FORCE").ok();
    if let Some(ref v) = env_force {
        if v != "0" {
            return true;
        }
    }
    let force_color = std::env::var("FORCE_COLOR").ok();
    if let Some(ref v) = force_color {
        if v != "0" {
            return true;
        }
    }
    if std::env::var("NO_COLOR").is_ok() {
        return false;
    }
    if force_color.as_deref() == Some("0") {
        return false;
    }
    if std::env::var("CLICOLOR").as_deref() == Ok("0") {
        return false;
    }
    stdout_is_tty()
}

/// Whether CSV output is preferred (BISMAR_CSV=1, or a non-interactive stdout).
pub fn csv_enabled() -> bool {
    if std::env::var("BISMAR_CSV").as_deref() == Ok("1") {
        return true;
    }
    !stdout_is_tty()
}

fn stderr_is_tty() -> bool {
    use std::io::IsTerminal;
    std::io::stderr().is_terminal()
}

fn stdout_is_tty() -> bool {
    use std::io::IsTerminal;
    std::io::stdout().is_terminal()
}

// ── ANSI palette ─────────────────────────────────────────────────────────────

pub struct Color;
impl Color {
    pub const RESET: &'static str = "\x1b[0m";
    pub const BOLD: &'static str = "\x1b[1m";
    pub const DIM: &'static str = "\x1b[2m";
    pub const RED: &'static str = "\x1b[31m";
    pub const GREEN: &'static str = "\x1b[32m";
    pub const YELLOW: &'static str = "\x1b[33m";
    pub const BLUE: &'static str = "\x1b[34m";
    pub const PINK: &'static str = "\x1b[95m";
    pub const CYAN: &'static str = "\x1b[36m";
    pub const GRAY: &'static str = "\x1b[90m";
    pub const WHITE: &'static str = "\x1b[97m";
}

/// Colorize text; no-op when `on` is false.
pub fn paint(text: &str, code: &str, on: bool) -> String {
    let safe = terminal_text(text, false, None);
    if on {
        format!("{}{}{}", code, safe, Color::RESET)
    } else {
        safe
    }
}

/// Colorize text for stderr/color-enabled contexts.
pub fn paint_color(text: &str, code: &str) -> String {
    paint(text, code, want_color())
}

/// Colorize text for stdout-keyed contexts.
pub fn paint_stdout(text: &str, code: &str) -> String {
    paint(text, code, stdout_color())
}

// ── Terminal text sanitization ────────────────────────────────────────────────

/// Make untrusted text inert for terminal output. C0/C1 controls → control
/// pictures; tabs expanded to `tab_width` spaces if given; newlines kept if
/// `multiline`.
pub fn terminal_text(text: &str, multiline: bool, tab_width: Option<usize>) -> String {
    let mut out = String::with_capacity(text.len());
    let chars: Vec<char> = text.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        let code = c as u32;
        if c == '\n' && multiline {
            out.push('\n');
            i += 1;
            continue;
        }
        if c == '\r' && multiline && i + 1 < chars.len() && chars[i + 1] == '\n' {
            i += 1;
            continue;
        }
        if c == '\t' {
            if let Some(w) = tab_width {
                for _ in 0..w {
                    out.push(' ');
                }
                i += 1;
                continue;
            }
        }
        if code <= 0x1f {
            // C0 control picture (U+2400–U+241F)
            out.push(char::from_u32(0x2400 + code).unwrap_or('\u{FFFD}'));
        } else if code == 0x7f {
            out.push('\u{2421}'); // DEL picture
        } else if (0x80..=0x9f).contains(&code) {
            out.push_str(&format!("\\u{:04x}", code));
        } else {
            out.push(c);
        }
        i += 1;
    }
    out
}

/// Strip ANSI escape sequences.
pub fn strip_ansi(s: &str) -> String {
    // Match ESC [ digits (;digits)* m
    let mut out = String::with_capacity(s.len());
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == 0x1b && i + 1 < bytes.len() && bytes[i + 1] == b'[' {
            // Skip until 'm'
            let start = i;
            i += 2;
            while i < bytes.len() && (bytes[i].is_ascii_digit() || bytes[i] == b';') {
                i += 1;
            }
            if i < bytes.len() && bytes[i] == b'm' {
                i += 1;
                // Consumed the escape sequence.
            } else {
                // Not a valid SGR, emit original bytes
                out.push_str(&s[start..i]);
            }
        } else {
            // SAFETY: we're walking valid UTF-8 boundaries carefully via char handling below.
            let ch = s[i..].chars().next().unwrap();
            out.push(ch);
            i += ch.len_utf8();
        }
    }
    out
}

/// Sanitize a composed terminal row while retaining bismar's own color SGRs.
pub fn terminal_ansi(text: &str, multiline: bool, tab_width: Option<usize>) -> String {
    // Safe SGR patterns bismar emits.
    static SAFE_CODES: &[&str] = &[
        "0", "1", "2", "31", "32", "33", "34", "35", "36", "37", "90", "95", "97",
    ];
    let mut out = String::with_capacity(text.len());
    let bytes = text.as_bytes();
    let mut plain = String::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == 0x1b && i + 1 < bytes.len() && bytes[i + 1] == b'[' {
            // Try to match a safe SGR.
            let start = i;
            i += 2;
            let num_start = i;
            while i < bytes.len() && (bytes[i].is_ascii_digit() || bytes[i] == b';') {
                i += 1;
            }
            if i < bytes.len() && bytes[i] == b'm' {
                let code_str = &text[num_start..i];
                i += 1;
                if SAFE_CODES.contains(&code_str) {
                    out.push_str(&terminal_text(&plain, multiline, tab_width));
                    plain.clear();
                    out.push_str(&text[start..i]);
                    continue;
                }
            }
            // Not safe: treat as plain text.
            plain.push_str(&text[start..i]);
        } else {
            let ch = text[i..].chars().next().unwrap();
            plain.push(ch);
            i += ch.len_utf8();
        }
    }
    out.push_str(&terminal_text(&plain, multiline, tab_width));
    out
}

// ── CSV helpers ───────────────────────────────────────────────────────────────

pub fn csv_cell(val: &str) -> String {
    let cell = terminal_text(&strip_ansi(val), true, Some(2));
    if cell.contains('"') || cell.contains(',') || cell.contains('\r') || cell.contains('\n') {
        format!("\"{}\"", cell.replace('"', "\"\""))
    } else {
        cell
    }
}

pub fn csv_row(values: &[&str]) -> String {
    values
        .iter()
        .map(|v| csv_cell(v))
        .collect::<Vec<_>>()
        .join(",")
}

pub fn csv_row_owned(values: &[String]) -> String {
    values
        .iter()
        .map(|v| csv_cell(v))
        .collect::<Vec<_>>()
        .join(",")
}

// ── Progress line ─────────────────────────────────────────────────────────────

struct ProgressState {
    text: String,
    shown: bool,
    muted: bool,
    start: Option<Instant>,
}

static PROGRESS: Lazy<Mutex<ProgressState>> = Lazy::new(|| {
    Mutex::new(ProgressState {
        text: String::new(),
        shown: false,
        muted: false,
        start: None,
    })
});

const PROGRESS_DELAY: Duration = Duration::from_secs(1);

fn progress_write(text: &str) {
    if !stderr_is_tty() {
        return;
    }
    let msg = paint(
        &format!(
            "Loading…{}",
            if text.is_empty() {
                String::new()
            } else {
                format!(" {}", text)
            }
        ),
        Color::DIM,
        want_color(),
    );
    let _ = write!(std::io::stderr(), "\r\x1b[K{}", msg);
    let _ = std::io::stderr().flush();
}

/// Update the progress line; appears after 1 second of latency on a TTY.
pub fn progress_update(text: &str) {
    let mut state = PROGRESS.lock().unwrap();
    if state.muted || !stderr_is_tty() {
        return;
    }
    state.text = terminal_text(text, false, None);
    let show_text = state.text.clone();
    if state.shown {
        progress_write(&show_text);
    } else if state.start.is_none() {
        state.start = Some(Instant::now());
    } else if state
        .start
        .map(|s| s.elapsed() >= PROGRESS_DELAY)
        .unwrap_or(false)
    {
        state.shown = true;
        progress_write(&show_text);
    }
}

/// Show the progress line immediately (no delay).
pub fn progress_show(text: &str) {
    let mut state = PROGRESS.lock().unwrap();
    if state.muted || !stderr_is_tty() {
        return;
    }
    state.text = terminal_text(text, false, None);
    state.shown = true;
    state.start = None;
    let t = state.text.clone();
    drop(state);
    progress_write(&t);
}

/// Clear the progress line.
pub fn progress_done() {
    let mut state = PROGRESS.lock().unwrap();
    state.start = None;
    if state.shown {
        let _ = write!(std::io::stderr(), "\r\x1b[K");
        let _ = std::io::stderr().flush();
    }
    state.shown = false;
    state.text.clear();
}

/// Mute progress for the rest of the process (TUI owns the screen).
pub fn progress_off() {
    progress_done();
    PROGRESS.lock().unwrap().muted = true;
}

/// Undo progress_off and reset state.
pub fn progress_reset() {
    progress_done();
    PROGRESS.lock().unwrap().muted = false;
}
