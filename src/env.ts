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
/** CSV over tables: BISMAR_CSV=1, or a non-interactive terminal (LLM agents, pipes, CI logs). */
export function csvEnabled(env?: Env): boolean {
  const proc = cliProcess();
  if (!proc) return false;
  return envFlag((env ?? proc.env)?.BISMAR_CSV) || !colorEnabled(env);
}
export const stripAnsi = (str: string): string => str.replace(/\x1b\[\d+(;\d+)*m/g, '');
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
export const paint = (text: string, code: string, on: boolean = true): string =>
  on ? `${code}${text}${color.reset}` : text;
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
  progressText = text;
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
  progressText = text;
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
  const cell = stripAnsi(String(val ?? ''));
  return /[",\r\n]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell;
};
export const csvRow = (values: unknown[]): string => values.map(csvCell).join(',');
