/*! bismar - MIT License (c) 2026 Paul Miller (paulmillr.com) */
/**
 * Shared environment detection. Exports here are public API with downstream
 * consumers (@paulmillr/jsbt) — some have no callers inside bismar itself.
 * Decides when to use colors and when to prefer simple machine-friendly output
 * (e.g. CSV instead of tables) for non-interactive environments: LLM agents, pipes, CI logs.
 *
 * Everything is computed lazily: callers snapshot values at their own import time,
 * so re-imports (and browser-like environments without `process`) detect correctly.
 * @module
 */
export type Env = Record<string, string | undefined>;
/** CLI process, or undefined outside CLI (browsers). Lazy: bundlers can't see a hard dependency. */
export const cliProcess = (): Record<string, any> | undefined =>
  // @ts-ignore
  'process' in globalThis ? globalThis['process'] : undefined;
export const envFlag = (value: string | undefined): boolean => !!Number(value);
export function wantColor(env?: Env, tty?: boolean): boolean {
  const proc = cliProcess();
  const e = env ?? proc?.env ?? {};
  const t = tty ?? (!!proc?.stderr?.isTTY || !!proc?.stdout?.isTTY);
  if (e.CLICOLOR_FORCE && e.CLICOLOR_FORCE !== '0') return true;
  if (e.FORCE_COLOR && e.FORCE_COLOR !== '0') return true;
  // Explicit force flags must win so one-shot debug runs can override a global NO_COLOR shell.
  if (e.NO_COLOR) return false;
  if (e.FORCE_COLOR === '0') return false;
  if (e.CLICOLOR === '0') return false;
  return t;
}
export function colorEnabled(env?: Env): boolean {
  const proc = cliProcess();
  if (!proc) return false;
  return wantColor(env, !!proc.stderr?.isTTY || !!proc.stdout?.isTTY);
}
/** CSV over tables: BISMAR_CSV=1, or a non-interactive stdout (LLM agents, pipes, CI logs).
 * Keyed to stdout alone — the stream the rows land on — so `bismar -s pkg | sort` gets
 * CSV even while stderr still points at the terminal (colorEnabled, which also feeds
 * stderr progress lines, considers both streams and would call that interactive). */
export function csvEnabled(env?: Env, stdoutTty?: boolean): boolean {
  const proc = cliProcess();
  if (!proc) return false;
  return (
    envFlag((env ?? proc.env)?.BISMAR_CSV) || !wantColor(env, stdoutTty ?? !!proc.stdout?.isTTY)
  );
}
/** Color for text printed to stdout — diffs, listings, tables. Keyed to stdout
 * alone for the same reason csvEnabled is: it is the stream the text lands on, so
 * `bismar -d pkg v1 v2 | less` gets plain text while stderr, still on the terminal,
 * keeps its colored progress lines and warnings (wantColor/colorEnabled consider
 * both streams, which is what those need). Force flags win either way, so
 * `FORCE_COLOR=1 bismar -d … | less -R` still paints. */
export function stdoutColor(env?: Env, stdoutTty?: boolean): boolean {
  const proc = cliProcess();
  if (!proc) return false;
  return wantColor(env, stdoutTty ?? !!proc.stdout?.isTTY);
}
export const stripAnsi = (str: string): string => str.replace(/\x1b\[\d+(;\d+)*m/g, '');
export type TerminalTextOpts = {
  /** Keep LF as a line separator. All other controls remain visible. */
  multiline?: boolean;
  /** Expand tabs to this many spaces instead of showing their control picture. */
  tabs?: number;
};
// C0 controls have standard visible "control pictures". C1 has no equivalent
// complete block, so spell those bytes out. Either representation occupies
// ordinary terminal cells and cannot be interpreted as a terminal command.
const visibleControl = (code: number): string =>
  code <= 0x1f
    ? String.fromCharCode(0x2400 + code)
    : code === 0x7f
      ? '\u2421'
      : `\\u${code.toString(16).padStart(4, '0')}`;
/**
 * Make untrusted text inert before composing it with terminal ANSI. Newlines
 * and tabs are controls too: callers must opt into the layout they own.
 */
export const terminalText = (text: string, opts: TerminalTextOpts = {}): string => {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 0x0a && opts.multiline) {
      out += '\n';
      continue;
    }
    // Treat ordinary CRLF as the caller-owned LF. A standalone CR stays
    // visible: it would otherwise rewind into text already drawn.
    if (code === 0x0d && opts.multiline && text.charCodeAt(i + 1) === 0x0a) continue;
    if (code === 0x09 && opts.tabs !== undefined) {
      out += ' '.repeat(Math.max(0, opts.tabs));
      continue;
    }
    out += code <= 0x1f || (code >= 0x7f && code <= 0x9f) ? visibleControl(code) : text[i];
  }
  return out;
};
// The complete SGR vocabulary emitted by bismar and the vendored terminal
// highlighter. This is deliberately not a general ANSI parser: OSC hyperlinks,
// clipboard commands, cursor motion, erases, and malformed ESC sequences are
// rendered visibly even when they arrive next to trusted colors.
const SAFE_SGR = /^\x1b\[(?:0|1|2|31|32|33|34|35|36|37|90|95|97)m/;
/** Sanitize a composed terminal row while retaining bismar's own color SGRs. */
export const terminalAnsi = (text: string, opts: TerminalTextOpts = {}): string => {
  let out = '';
  let plain = '';
  const flush = (): void => {
    out += terminalText(plain, opts);
    plain = '';
  };
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 0x1b) {
      const sgr = SAFE_SGR.exec(text.slice(i))?.[0];
      if (sgr) {
        flush();
        out += sgr;
        i += sgr.length - 1;
        continue;
      }
    }
    plain += text[i];
  }
  flush();
  return out;
};
/** Shared ANSI palette. */
const esc = String.fromCharCode(27); // \x1b — a shared prefix minifies better than escapes
export const color: Record<
  | 'blue'
  | 'bold'
  | 'cyan'
  | 'dim'
  | 'gray'
  | 'green'
  | 'pink'
  | 'red'
  | 'reset'
  | 'white'
  | 'yellow',
  string
> = {
  blue: esc + '[34m',
  bold: esc + '[1m',
  cyan: esc + '[36m',
  dim: esc + '[2m',
  gray: esc + '[90m',
  green: esc + '[32m',
  pink: esc + '[95m',
  red: esc + '[31m',
  reset: esc + '[0m',
  white: esc + '[97m', // bright: stands out against both gray and default text
  yellow: esc + '[33m',
};
/** Colorize text for terminals; pass `on` from colorEnabled()/wantColor(). */
export const paint = (text: string, code: string, on: boolean = true): string => {
  const safe = terminalText(text);
  return on ? `${code}${safe}${color.reset}` : safe;
};
/**
Transient startup progress: one status line on stderr for runs that stay silent
too long (npm installs, export enumeration, measuring a large package). The line
appears only once the run has been busy for a second on a terminal, rewrites in
place as details refine, and must be cleared (`progressDone`) before real output.
 */
const PROGRESS_DELAY_MS = 1000;
let progressText = '';
let progressShown = false;
let progressMuted = false;
let progressTimer: ReturnType<typeof setTimeout> | undefined;
const progressStderr = (): { isTTY?: boolean; write: (text: string) => boolean } | undefined =>
  cliProcess()?.stderr;
const progressWrite = (): void =>
  void progressStderr()?.write(
    `\r\x1b[K${paint(`Loading…${progressText ? ` ${progressText}` : ''}`, color.dim, colorEnabled())}`
  );
/** Update the status detail; the first call arms the one-second delay. No-op off-terminal. */
export const progressUpdate = (text: string): void => {
  if (progressMuted || !progressStderr()?.isTTY) return;
  progressText = terminalText(text);
  if (progressShown) progressWrite();
  else if (!progressTimer) {
    const timer = setTimeout(() => {
      progressShown = true;
      progressWrite();
    }, PROGRESS_DELAY_MS);
    // Never keeps the process alive: a finished run must exit, line or no line.
    timer.unref?.();
    progressTimer = timer;
  }
};
/** Show the line right now, skipping the delay: for known-slow synchronous work
 * (npm install blocks the event loop, so the timer could never fire during it). */
export const progressShow = (text: string): void => {
  if (progressMuted || !progressStderr()?.isTTY) return;
  if (progressTimer) clearTimeout(progressTimer);
  progressTimer = undefined;
  progressText = terminalText(text);
  progressShown = true;
  progressWrite();
};
/** Clear the line (if shown) and cancel the pending delay; call before printing
 * real output. The next update arms a fresh delay. */
export const progressDone = (): void => {
  if (progressTimer) clearTimeout(progressTimer);
  progressTimer = undefined;
  if (progressShown) progressStderr()?.write('\r\x1b[K');
  progressShown = false;
  progressText = '';
};
/** Mute progress for the rest of the process — for when a TUI owns the screen. */
export const progressOff = (): void => {
  progressDone();
  progressMuted = true;
};
/** Undo progressOff and reset state, for long-lived embedders and tests. */
export const progressReset = (): void => {
  progressDone();
  progressMuted = false;
};
export const csvCell = (val: unknown): string => {
  // CSV can be forced onto a TTY. Remove bismar-owned colors, then neutralize
  // every remaining terminal control while retaining real CSV record content.
  const cell = terminalText(stripAnsi(String(val ?? '')), { multiline: true, tabs: 2 });
  return /[",\r\n]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell;
};
export const csvRow = (values: unknown[]): string => values.map(csvCell).join(',');
