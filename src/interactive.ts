/**
Interactive mode (`-i`): ranger-style package navigation. A bare `bismar`
(no selector) opens the launcher menu first: browse the current directory, or
search a registry — top hits to pick from; pypi, searchless, opens exact
names. Sessions open in the
files view — shipped files browse like a filesystem and preview as text; `r`
jumps to the github repository the manifest names, and back — every ecosystem
that advertises one, not just JS. `m` toggles JS
packages into the modules view, where modules are directories, exports are files, and every
row measures itself in the background (same in-memory engine as --size);
`enter` there bundles and pages through the source. Listings take the mouse too
— click to select, click again to open, wheel to scroll; the pager keeps it
native so text selection works. One key grammar across every view: `q` and
`esc` back out one level (exiting at the session root), ←/h climb without ever
exiting, PgUp/PgDn/d/u page, and Ctrl-C closes from anywhere. Draws with plain
ANSI on the alternate screen; nothing is ever written to the filesystem.
@module
 */
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { highlightText } from './vendor/speed-highlight/terminal.js';
import {
  type DiffEntry,
  type DiffSide,
  highlightedFileDiffLines,
  scoped,
  statSummary,
  statTail,
  type TreeDiff,
  walkFiles,
} from './diff.ts';
import {
  color,
  paint,
  progressOff,
  stripAnsi,
  terminalAnsi,
  terminalText,
  wantColor,
} from './env.ts';
import { rmTempDir, tempDir } from './fs-modify.ts';
import { bad, err, explicitPath, firstModule, fmtBytes, kb, ONLY_EXT, paintId } from './public.ts';
import { languageFromFilename } from './vendor/speed-highlight/detect.js';
import {
  canProfile,
  canSearch,
  displayLabel,
  isRegistrySelector,
  jsHitStats,
  parseRegistryRef,
  profileHits,
  registryContext,
  type RegistryRef,
  type SearchHit,
  searchRegistry,
  setBigArchivePolicy,
} from './registries.ts';
import {
  asRef,
  explicitRef as npmRef,
  noPkgErr,
  npmHintUse,
  parseNpmRef,
  saveRefDb,
} from './refs.ts';
import {
  applyDbExports,
  BUILD_POOL,
  buildFirst,
  type Built,
  type Ctx,
  fileBase,
  fillExports,
  inputCtx,
  inputMods,
  isFile,
  loadEsbuild,
  type Mod,
  noPkgCtx,
  readModules,
  refContext,
  resolveCtx,
  runSize,
  sizeTail,
  toDbModules,
} from './size.ts';
import { ghRepoOf } from './surface.ts';

const decoder = new TextDecoder();
export type InteractiveIo = {
  cols?: number;
  input?: NodeJS.ReadableStream & { setRawMode?: (on: boolean) => void };
  output?: { write: (text: string) => boolean };
  rows?: number;
};
export type InteractiveOpts = {
  cwd?: string;
  io?: InteractiveIo;
  menu?: boolean;
  // Pre-fetched profile hits (`bismar gh:@user`): the launcher opens directly
  // on its results stage, listing them like a search that already ran.
  profile?: { hits: SearchHit[]; prefix: string; user: string };
};
type Stats = { gz: number; loc: number; min: number };
// 'failed' keeps broken selectors out of the auto-measure queue; `s` retries them.
type Cell = Stats | 'failed' | 'pending';
type IEntry = { kind: 'back' | 'export' | 'module' | 'pkg'; mod?: Mod; sel: string; text: string };
// A row in the files view (the home view): shipped files browse like a
// filesystem and preview as text — never bundled.
type FEntry = { dir: boolean; name: string; path: string; size: number };
type Pager = {
  lines: string[];
  offset: number;
  // A deep-linked preview (`bismar gem:sinatra/README.md`) is its session's
  // root view: esc exits from it like q, while ← still climbs into the
  // listing underneath.
  root?: boolean;
  // Header tail replacing the default rendered-line count — a diff pager
  // carries the file's own length and how much of it changed.
  stat?: string;
  title: string;
  // Draw-time wrap memo: logical lines re-wrap only when the width changes;
  // starts[i] is the wrapped-row index where logical line i begins.
  wrap?: { cols: number; rows: string[]; starts: number[] };
};
// One navigation grammar for every view — launcher, listings, pagers, diff:
// `q` and `esc` are one back-out key — one level up, exiting at the session
// root (a deep-linked preview IS its session's root); ←/h/backspace climb one
// level but never exit; arrows and paging keys only move; Ctrl-C/Ctrl-D close
// the app from anywhere. Text prompts (the search box, `/`, `:`) eat
// characters raw — q types there, and only esc (or ← where noted) drops the
// prompt.
const KEYMAP: Record<string, string> = {
  '\b': 'back',
  '/': 'search', // vim-like, pager only: find forward…
  ':': 'goto', // …and jump to a line
  '\n': 'enter',
  '\r': 'enter',
  '\x03': 'exit', // Ctrl-C: close the app from anywhere
  '\x04': 'exit', // Ctrl-D
  '\x1b': 'esc', // bare Esc backs out one level; escape sequences are consumed first
  '\x1b[1~': 'top', // Home (vt)
  '\x1b[4~': 'bottom', // End (vt)
  '\x1b[5~': 'pgup', // PgUp
  '\x1b[6~': 'pgdn', // PgDn
  '\x1b[7~': 'top', // Home (rxvt)
  '\x1b[8~': 'bottom', // End (rxvt)
  '\x1b[A': 'up',
  '\x1b[B': 'down',
  '\x1b[C': 'enter',
  '\x1b[D': 'back',
  '\x1b[F': 'bottom', // End (xterm)
  '\x1b[H': 'top', // Home (xterm)
  '\x1bOA': 'up', // application cursor mode variants
  '\x1bOB': 'down',
  '\x1bOC': 'enter',
  '\x1bOD': 'back',
  '\x1bOF': 'bottom',
  '\x1bOH': 'top',
  '\x7f': 'back', // Backspace
  ' ': 'pgdn',
  G: 'bottom',
  b: 'pgup',
  d: 'halfdn', // less: half window forward…
  g: 'top',
  h: 'back',
  j: 'down',
  k: 'up',
  l: 'enter',
  m: 'mode', // toggle between the files view and the modules/size view
  n: 'next', // repeat the last pager search…
  N: 'prev', // …and backwards
  q: 'esc', // q ≡ esc: one back-out key, exiting at the session root
  r: 'repo', // files view: hop to the package's github repo and back
  s: 'size',
  u: 'halfup', // …and half window back
  w: 'pgup', // less: one window back, like b
};
// CSI (`\x1b[…~`/letter), SGR mouse (`\x1b[<…M`/`m`) and SS3 (`\x1bO…`) sequences
// are consumed whole, mapped or not — an unrecognized PgUp must never fall
// through to bare Esc and quit. Units stay raw (KEYMAP applies at the consumer):
// search input needs the characters themselves, not their bindings.
const KEY_SEQ = /^\x1b(\[<[\d;]*[Mm]|\[[\d;]*[~A-Za-z]|O[A-Za-z])/;
// Binding lookup for one consumed unit. Modifier-tagged CSI variants
// (`\x1b[6;5~` Ctrl-PgDn, `\x1b[1;2A` Shift-↑) fold onto their plain keys, so
// paging and movement work however the terminal spells them.
const keyOf = (unit: string | undefined): string | undefined => {
  if (unit === undefined) return undefined;
  const got = KEYMAP[unit];
  if (got) return got;
  const mod = /^\x1b\[(\d+);\d+([~A-Z])$/.exec(unit);
  if (!mod) return undefined;
  return mod[2] === '~'
    ? KEYMAP[`\x1b[${mod[1]}~`]
    : mod[1] === '1'
      ? KEYMAP[`\x1b[${mod[2]}`]
      : undefined;
};
const tokenize = (raw: string): string[] => {
  const out: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '\x1b') {
      const seq = KEY_SEQ.exec(raw.slice(i));
      if (seq) {
        out.push(seq[0]);
        i += seq[0].length - 1;
        continue;
      }
    }
    out.push(raw[i]);
  }
  return out;
};
// Terminal-safe preview text: retain only SGRs emitted by bismar/highlightText;
// package bytes supply no terminal commands. Tabs expand to the same two cells
// the width math sees, and ordinary CRLF collapses to its caller-owned LF.
const displayText = (text: string): string => terminalAnsi(text, { multiline: true, tabs: 2 });
const ALT_ON = '\x1b[?1049h\x1b[?25l';
const ALT_OFF = '\x1b[?25h\x1b[?1049l';
// Click + wheel reporting in SGR encoding (1006: coordinates past column 223
// survive). Listing views hold the mouse; the pager releases it so native text
// selection — copying source — keeps working there.
const MOUSE_ON = '\x1b[?1000h\x1b[?1006h';
const MOUSE_OFF = '\x1b[?1006l\x1b[?1000l';
// An SGR mouse report: `\x1b[<button;col;rowM`. Wheel spins map onto the arrow
// keys and a left press carries its 1-based screen row; releases (`m`), drags,
// and other buttons decode to nothing but are still consumed.
const MOUSE_SEQ = /^\x1b\[<(\d+);\d+;(\d+)M$/;
const mouseOf = (unit: string): { key?: 'down' | 'up'; row?: number } | undefined => {
  const hit = MOUSE_SEQ.exec(unit);
  if (!hit) return undefined;
  const button = Number(hit[1]);
  if (button === 64) return { key: 'up' };
  if (button === 65) return { key: 'down' };
  return button === 0 ? { row: Number(hit[2]) } : {};
};
const statsTail = (stats: Stats): string => sizeTail(stats.loc, stats.min, stats.gz);
// Width-aware truncation: escape codes take no columns and must never be split.
const truncAnsi = (unsafe: string, max: number): string => {
  // Every TUI frame reaches this final row boundary. Individual fields are
  // sanitized before painting too; this catches forgotten plain fields such as
  // a filename, diff path, prompt error, or metadata crumb.
  const line = terminalAnsi(unsafe);
  if (stripAnsi(line).length <= max) return line;
  let width = 0;
  let out = '';
  for (let i = 0; i < line.length && width < max - 1; i++) {
    if (line[i] === '\x1b') {
      const end = line.indexOf('m', i);
      if (end < 0) break;
      out += line.slice(i, end + 1);
      i = end;
    } else {
      out += line[i];
      width++;
    }
  }
  return `${out}…${color.reset}`;
};
// Width-aware wrapping for pager rows: escape codes take no columns and must never
// be split; whatever codes are active at a break reopen on the continuation row.
const wrapAnsi = (unsafe: string, max: number): string[] => {
  const line = terminalAnsi(unsafe);
  if (stripAnsi(line).length <= max) return [line];
  const out: string[] = [];
  let chunk = '';
  let width = 0;
  let active = '';
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '\x1b') {
      const end = line.indexOf('m', i);
      if (end < 0) break;
      const code = line.slice(i, end + 1);
      chunk += code;
      active = code === color.reset ? '' : active + code;
      i = end;
      continue;
    }
    if (width === max) {
      out.push(chunk);
      chunk = active;
      width = 0;
    }
    chunk += line[i];
    width++;
  }
  // A trailing invisible chunk (a lone reset) belongs to the last real row.
  if (out.length && !stripAnsi(chunk).length) out[out.length - 1] += chunk;
  else out.push(chunk);
  return out;
};
// Listing layout, one owner: crumb + blank line above, blank line + hint
// footer below, entries on screen rows LIST_TOP…LIST_TOP+listRows()−1.
// Draws, page jumps, and click mapping all derive from this number.
const LIST_TOP = 3;
// The no-argument launcher: a bare `bismar` asks what to open — the current
// directory, or a registry search (searchRegistry: one request per submitted
// query, top ten hits to pick from). A version-pinned query (`serde@1.0.0`,
// `owner/repo@ref`) skips search and opens directly — search apis know nothing
// about versions — as does pypi, whose search api was retired in 2021.
const SEARCHES: { example: string; label: string; prefix: string }[] = [
  { example: 'preact', label: 'JS/NPM', prefix: 'npm:' },
  { example: '@std/bytes', label: 'JS/JSR', prefix: 'jsr:' },
  { example: 'serde', label: 'Rust/Cargo', prefix: 'crate:' },
  { example: 'railties', label: 'Ruby/Gems', prefix: 'gem:' },
  { example: 'requests', label: 'Python/PyPi', prefix: 'pypi:' },
  { example: 'paulmillr/qr', label: 'GitHub', prefix: 'gh:' },
  { example: 'inkscape/inkscape', label: 'GitLab', prefix: 'gitlab:' },
];
// The SEARCHES row for a prefix; ecosystems without a search box (composer)
// synthesize a row so profile listings can still name themselves.
const whichOf = (prefix: string): (typeof SEARCHES)[number] =>
  SEARCHES.find((reg) => reg.prefix === prefix) ?? {
    example: '',
    label: prefix.slice(0, -1),
    prefix,
  };
// State the launcher parks between opens: ← from a session root reopens the
// menu exactly where it was left — same option, query, and hits listing.
export type LauncherState = {
  cursor?: number;
  // `root` marks a CLI-seeded profile listing (`bismar gh:@user`): the session
  // began here, so there is no menu or prompt behind it to back into. `title`
  // is a profile listing's crumb (`github:@veorq`), doubling as the head of
  // the session crumb once a hit opens.
  results?: {
    cursor: number;
    hits: SearchHit[];
    root?: boolean;
    title?: string;
    which: (typeof SEARCHES)[number];
  };
  search?: { note: string; text: string; which: (typeof SEARCHES)[number] };
};
// Returns the chosen selector ('' means the current directory) plus whatever
// input units arrived after the choice — type-ahead belongs to the session that
// follows; undefined means the user quit at the menu. `state` is read on entry
// and written back on every exit; `typeahead` seeds the input queue (units a
// session handed back on its way here).
export const chooseTarget = async (
  dirLabel: string,
  io: InteractiveIo = {},
  state: LauncherState = {},
  typeahead: string[] = []
): Promise<{ leftover: string[]; selector: string; via?: string } | undefined> => {
  const input = io.input ?? process.stdin;
  const output = io.output ?? process.stdout;
  const colorOn = wantColor();
  const options = [
    `browse current directory (${terminalText(dirLabel)})`,
    ...SEARCHES.map((reg) => `search ${reg.label}${canSearch(reg.prefix) ? '' : ' (exact name)'}`),
  ];
  let cursor = state.cursor ?? 0;
  let search = state.search;
  // The pick stage: search hits list like any other listing, enter opens one.
  // `abort` cancels the background hit garnish when the listing goes away.
  let results = state.results ? { ...state.results, abort: new AbortController() } : undefined;
  let closed = false;
  const pending: string[] = [...typeahead];
  let wake: (() => void) | undefined;
  const onData = (chunk: unknown): void => {
    pending.push(...tokenize(String(chunk)));
    const cont = wake;
    wake = undefined;
    cont?.();
  };
  const render = (lines: string[]): void => {
    const max = (io.cols ?? (process.stdout.columns || 80)) - 1;
    output.write(`\x1b[H${lines.map((line) => truncAnsi(line, max)).join('\x1b[K\r\n')}\x1b[J`);
  };
  const listRows = (): number => Math.max(3, (io.rows ?? (process.stdout.rows || 24)) - 4);
  // Hits listing scroll offset, recomputed around the cursor like every other
  // listing; a fresh search resets it with its new results.
  let resOffset = 0;
  const draw = (): void => {
    if (results) {
      // Profile listings crumb as the profile itself (`github:@veorq`);
      // searches keep their query framing.
      const lines = [
        (results.title
          ? paintId(results.title, colorOn, 'module')
          : paint(`search ${results.which.label}`, color.bold, colorOn)) +
          paint(
            ` · ${results.hits.length} ${results.title ? 'listed' : 'matches'}`,
            color.dim,
            colorOn
          ),
        '',
      ];
      const visible = listRows();
      if (results.cursor < resOffset) resOffset = results.cursor;
      if (results.cursor >= resOffset + visible) resOffset = results.cursor - visible + 1;
      for (const [i, found] of results.hits.slice(resOffset, resOffset + visible).entries()) {
        // JS hits carry their garnish after the version: deps, then packed size.
        // Painted per segment so a zero-dep package can flag green (a clean,
        // dependency-free install) while the rest of the tail stays dim.
        const depStr =
          found.deps !== undefined ? `${found.deps} dep${found.deps === 1 ? '' : 's'}` : '';
        const parts = [
          found.version && paint(found.version, color.dim, colorOn),
          depStr && paint(depStr, found.deps === 0 ? color.green : color.dim, colorOn),
          found.tgzBytes && paint(`${fmtBytes(found.tgzBytes)} tgz`, color.dim, colorOn),
          found.desc && paint(found.desc, color.dim, colorOn),
        ].filter(Boolean);
        const tail = parts.length ? `  ${parts.join(paint(' · ', color.dim, colorOn))}` : '';
        lines.push(
          `${resOffset + i === results.cursor ? paint('▸ ', color.bold, colorOn) : '  '}${paint(found.name, color.yellow, colorOn)}${tail}`
        );
      }
      lines.push(
        '',
        paint(
          results.root ? '↑↓ move · enter open · q quit' : '↑↓ move · enter open · esc back',
          color.dim,
          colorOn
        )
      );
      render(lines);
      return;
    }
    if (search) {
      // The input stage: a one-line prompt, esc backs out to the menu. pypi
      // has no search behind it, so its prompt says what enter really does.
      const searchable = canSearch(search.which.prefix);
      render([
        paint(`search ${search.which.label}`, color.bold, colorOn) +
          paint(searchable ? '' : ' · exact package name, no search api', color.dim, colorOn),
        '',
        `name: ${terminalText(search.text)}`,
        search.note ? paint(search.note, color.red, colorOn) : '',
        paint(
          `${searchable ? 'enter search' : 'enter open'} · esc back · e.g. ${search.which.example}${
            canProfile(search.which.prefix) ? ' or @user' : ''
          }`,
          color.dim,
          colorOn
        ),
      ]);
      return;
    }
    const lines = [
      paint('bismar', color.bold, colorOn) + paint(' · what to open?', color.dim, colorOn),
      '',
    ];
    for (const [i, text] of options.entries())
      lines.push(`${i === cursor ? paint('▸ ', color.bold, colorOn) : '  '}${text}`);
    lines.push('', paint('↑↓ move · enter select · q quit', color.dim, colorOn));
    render(lines);
  };
  // JS hits garnish themselves behind the listing — dep counts and tarball
  // bytes land row by row as the metadata (or its per-version cache) answers.
  const garnish = (picks: NonNullable<typeof results>): void => {
    for (const found of picks.hits) {
      if (found.tgzBytes !== undefined) continue;
      void jsHitStats(picks.which.prefix, found, picks.abort.signal)
        .then((stats) => {
          if (!stats || closed || results !== picks) return;
          if (stats.version) found.version = stats.version;
          if (stats.deps !== undefined) found.deps = stats.deps;
          if (stats.tgzBytes) found.tgzBytes = stats.tgzBytes;
          draw();
        })
        .catch(() => {
          // Garnish only; the row stands without it.
        });
    }
  };
  input.setRawMode?.(true);
  input.on('data', onData);
  input.resume();
  // The menu owns the terminal from here; mute the startup progress line.
  progressOff();
  output.write(ALT_ON + MOUSE_ON);
  // Shrinking the terminal would scroll a taller stale frame off the top;
  // redraw on resize so the frame always fits the current window.
  const onResize = (): void => draw();
  process.stdout.on('resize', onResize);
  // A restored listing may have rows whose garnish got aborted mid-flight when
  // the launcher last closed; the per-version cache makes the refill cheap.
  if (results) garnish(results);
  try {
    for (;;) {
      draw();
      while (!pending.length)
        await new Promise<void>((res) => {
          wake = res;
        });
      const unit = pending.shift();
      const mouse = unit ? mouseOf(unit) : undefined;
      let key = unit ? (mouse ? mouse.key : keyOf(unit)) : undefined;
      // Ctrl-C/Ctrl-D close the launcher from any stage.
      if (key === 'exit') return undefined;
      if (results) {
        const picks = results;
        if (mouse?.row !== undefined) {
          const at = resOffset + mouse.row - LIST_TOP;
          if (mouse.row < LIST_TOP || at >= Math.min(picks.hits.length, resOffset + listRows()))
            continue;
          if (at !== picks.cursor) {
            picks.cursor = at;
            continue;
          }
          key = 'enter';
        }
        const jump = listRows();
        switch (key) {
          case 'esc':
          case 'back':
            // A CLI-seeded profile listing is the session root: no menu or
            // prompt lies behind it, so q/esc exit — like at every other root
            // view — while ← is a navigation key and stays put.
            if (picks.root) {
              if (key === 'esc') return undefined;
              break;
            }
            // Back to the prompt with the query kept for refining; stop the
            // garnish requests still in flight for the dropped listing.
            picks.abort.abort();
            results = undefined;
            break;
          case 'up':
            picks.cursor = Math.max(0, picks.cursor - 1);
            break;
          case 'down':
            picks.cursor = Math.min(picks.hits.length - 1, picks.cursor + 1);
            break;
          case 'pgup':
            picks.cursor = Math.max(0, picks.cursor - jump);
            break;
          case 'pgdn':
            picks.cursor = Math.min(picks.hits.length - 1, picks.cursor + jump);
            break;
          case 'halfup':
            picks.cursor = Math.max(0, picks.cursor - Math.ceil(jump / 2));
            break;
          case 'halfdn':
            picks.cursor = Math.min(picks.hits.length - 1, picks.cursor + Math.ceil(jump / 2));
            break;
          case 'top':
            picks.cursor = 0;
            break;
          case 'bottom':
            picks.cursor = picks.hits.length - 1;
            break;
          case 'enter': {
            const picked = picks.hits[picks.cursor];
            if (picked)
              return {
                leftover: pending.splice(0),
                selector: picks.which.prefix + picked.name,
                // A profile listing heads the session crumb it opens into.
                via: picks.title,
              };
            break;
          }
        }
        continue;
      }
      if (search) {
        // The prompt eats raw characters, not their bindings, like the pager's /.
        if (unit === '\r' || unit === '\n') {
          const box = search;
          const name = box.text.trim();
          if (!name) continue;
          // A typed canonical prefix stays single: `npm:preact` in the npm box.
          const bare = name.startsWith(box.which.prefix)
            ? name.slice(box.which.prefix.length)
            : name;
          // A bare `@user` lists that profile — repos, scope, or owned
          // packages — instead of running a name search.
          const profileUser =
            /^@[\w.-]+$/.test(bare) && canProfile(box.which.prefix) ? bare.slice(1) : '';
          // A version pin opens directly — search apis know nothing about
          // versions; so does a registry without a search api (pypi).
          if (!profileUser && (!canSearch(box.which.prefix) || bare.lastIndexOf('@') > 0))
            return { leftover: pending.splice(0), selector: box.which.prefix + bare };
          box.note = '';
          render([paint(`searching ${box.which.label} for ${bare}…`, color.dim, colorOn)]);
          try {
            const hits = profileUser
              ? await profileHits(box.which.prefix, profileUser)
              : await searchRegistry(box.which.prefix, bare);
            if (hits.length) {
              const picks = {
                abort: new AbortController(),
                cursor: 0,
                hits,
                title: profileUser ? displayLabel(`${box.which.prefix}@${profileUser}`) : undefined,
                which: box.which,
              };
              results = picks;
              resOffset = 0;
              garnish(picks);
            } else box.note = `no matches for ${bare}`;
          } catch (error) {
            // Stay in the prompt; rate limits and outages must not kill the launcher.
            box.note = (error as Error).message;
          }
          // Esc and ← both leave the prompt for the menu; backspace (also
          // mapped to 'back') must keep editing the query instead.
        } else if (unit === '\x1b' || unit === '\x1b[D' || unit === '\x1bOD') search = undefined;
        else if (unit === '\x7f' || unit === '\b') search.text = search.text.slice(0, -1);
        else if (unit && unit.length === 1 && unit >= ' ') search.text += unit;
        continue;
      }
      // Same click contract as every listing: select first, open on the second.
      if (mouse?.row !== undefined) {
        const at = mouse.row - LIST_TOP;
        if (at < 0 || at >= options.length) continue;
        if (at !== cursor) {
          cursor = at;
          continue;
        }
        key = 'enter';
      }
      switch (key) {
        // The menu is the launcher's root: q/esc exit; ← is unbound here —
        // navigation keys never exit.
        case 'esc':
          return undefined;
        case 'up':
          cursor = Math.max(0, cursor - 1);
          break;
        case 'down':
          cursor = Math.min(options.length - 1, cursor + 1);
          break;
        case 'pgup':
        case 'halfup':
          cursor = 0;
          break;
        case 'pgdn':
        case 'halfdn':
          cursor = options.length - 1;
          break;
        case 'top':
          cursor = 0;
          break;
        case 'bottom':
          cursor = options.length - 1;
          break;
        case 'enter':
          if (cursor === 0) return { leftover: pending.splice(0), selector: '' };
          search = { note: '', text: '', which: SEARCHES[cursor - 1] };
          break;
      }
    }
  } finally {
    // In-flight garnish must not outlive the launcher: it would keep the
    // process alive after a quit and draw over whatever comes next.
    closed = true;
    results?.abort.abort();
    // Park the stage for the next open (← from the session that follows).
    state.cursor = cursor;
    state.search = search;
    state.results = results && {
      cursor: results.cursor,
      hits: results.hits,
      root: results.root,
      title: results.title,
      which: results.which,
    };
    process.stdout.off('resize', onResize);
    output.write(MOUSE_OFF + ALT_OFF);
    input.off('data', onData);
    input.setRawMode?.(false);
    input.pause();
  }
};
// Diff navigator (`-d` on a terminal): a flat listing of the changed files
// between two resolved trees — A/M/D markers with size deltas — and enter pages
// through the file's unified line diff. A scope naming one exact file deep-links
// straight into that file's diff pager, like the navigator's file deep links.
// Same key and click contract as the other listings; like every view here,
// nothing is written to the filesystem.
export const runDiff = async (
  a: DiffSide,
  b: DiffSide,
  tree: TreeDiff,
  io: InteractiveIo = {}
): Promise<void> => {
  const input = io.input ?? process.stdin;
  const output = io.output ?? process.stdout;
  const colorOn = wantColor();
  const term = () => ({
    cols: io.cols ?? (process.stdout.columns || 80),
    rows: io.rows ?? (process.stdout.rows || 24),
  });
  // Scoped diffs (`/path` ref tails) drop the summary footer, like -ds: over
  // a handful of picked files its counts and totals just restate the rows.
  const scoped = !!(a.sel || b.sel);
  // Non-entry rows: title, two blanks, key bar — plus, unscoped, the
  // counts and sizes footer lines.
  const listRows = (): number => Math.max(3, term().rows - (scoped ? 4 : 6));
  const render = (lines: string[]): void => {
    const max = term().cols - 1;
    output.write(`\x1b[H${lines.map((line) => truncAnsi(line, max)).join('\x1b[K\r\n')}\x1b[J`);
  };
  const MARK: Record<DiffEntry['status'], [string, string]> = {
    added: ['A', color.green],
    modified: ['M', color.yellow],
    removed: ['D', color.red],
  };
  let cursor = 0;
  let offset = 0;
  let pager: Pager | undefined;
  // Rendered diffs memoize per path: reopening a file costs nothing.
  const views = new Map<string, string[]>();
  const drawList = (): void => {
    const visible = listRows();
    if (cursor < offset) offset = cursor;
    if (cursor >= offset + visible) offset = cursor - visible + 1;
    const lines = [
      paintId(a.label, colorOn, 'module') +
        paint(' → ', color.dim, colorOn) +
        paintId(b.label, colorOn, 'module') +
        paint(' · diff', color.dim, colorOn),
      '',
    ];
    for (const [i, entry] of tree.entries.slice(offset, offset + visible).entries()) {
      const active = offset + i === cursor;
      const [mark, markColor] = MARK[entry.status];
      lines.push(
        `${active ? paint('▸ ', color.bold, colorOn) : '  '}${paint(mark, markColor, colorOn)} ` +
          `${terminalText(entry.path)}${paint(`  ${statTail(entry)}`, color.dim, colorOn)}`
      );
    }
    // Summary as a footer, -ds's two lines in -ds's order: counts, then sizes.
    lines.push(
      '',
      ...(scoped ? [] : statSummary(tree, a, b).map((line) => paint(line, color.dim, colorOn))),
      paint('↑↓ move · enter diff · q quit', color.dim, colorOn)
    );
    render(lines);
  };
  const drawPager = (page: Pager): void => {
    const { cols, rows } = term();
    const visible = Math.max(3, rows - 3);
    const max = Math.max(1, cols - 1);
    if (page.wrap?.cols !== max) {
      const wrapRows: string[] = [];
      const starts: number[] = [];
      for (const line of page.lines) {
        starts.push(wrapRows.length);
        wrapRows.push(...wrapAnsi(line, max));
      }
      page.wrap = { cols: max, rows: wrapRows, starts };
    }
    const wrapped = page.wrap.rows;
    const maxOffset = Math.max(0, wrapped.length - visible);
    page.offset = Math.max(0, Math.min(page.offset, maxOffset));
    const pct = maxOffset ? Math.round((page.offset / maxOffset) * 100) : 100;
    render([
      paintId(page.title, colorOn, 'module') +
        paint(` · ${page.stat ?? `${page.lines.length} lines`}`, color.dim, colorOn),
      ...wrapped.slice(page.offset, page.offset + visible),
      // A diff color may span past the window's last line; close it.
      (colorOn ? color.reset : '') +
        paint(
          page.root
            ? `${pct}% · ↑↓/space scroll · ← files · q quit`
            : `${pct}% · ↑↓/space scroll · q back`,
          color.dim,
          colorOn
        ),
    ]);
  };
  // Header stat for a file diff: the file's own length (the newer side; the
  // old one for removals) and how many of its lines the diff touches. Counted
  // off the rendered hunks — per hunk a replaced pair counts once (the larger
  // of removed/added), so the number reads as file lines, not diff rows.
  // Binary payloads keep the default rendered-line count.
  const diffStat = (entry: DiffEntry, lines: string[]): string | undefined => {
    let text: string;
    try {
      text = readFileSync(join(entry.status === 'removed' ? a.dir : b.dir, entry.path), 'utf8');
    } catch {
      return undefined;
    }
    // Same binary rule as the diff render (diff.ts looksBinary): a NUL in the
    // first 8KB. Deeper NULs (micro-ftch keeps one in a string constant)
    // still diff as text, so they still deserve the stat.
    if (text.slice(0, 8192).includes('\0')) return undefined;
    const total = text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
    let changed = 0;
    let minus = 0;
    let plus = 0;
    let inHunk = false;
    const flush = (): void => {
      changed += Math.max(minus, plus);
      minus = plus = 0;
    };
    for (const raw of lines) {
      const line = stripAnsi(raw);
      if (line.startsWith('@@')) {
        flush();
        inHunk = true;
      } else if (inHunk && line.startsWith('+')) plus++;
      else if (inHunk && line.startsWith('-')) minus++;
    }
    flush();
    if (!changed || !total) return undefined;
    const pct = Math.min(100, Math.round((changed / total) * 100));
    return `${total} line${total === 1 ? '' : 's'} · ${changed} line${changed === 1 ? '' : 's'} changed (${pct}%)`;
  };
  const openEntry = async (entry: DiffEntry): Promise<void> => {
    let lines = views.get(entry.path);
    if (!lines) {
      lines = (await highlightedFileDiffLines(a.dir, b.dir, entry, colorOn)).map(displayText);
      views.set(entry.path, lines);
    }
    pager = { lines, offset: 0, stat: diffStat(entry, lines), title: entry.path };
  };
  // A scope naming one exact changed file deep-links like the navigator: the
  // session opens with that file's diff pager already up, and that pager is
  // the session root — q and esc exit, ← climbs into the one-row listing. A
  // directory scope (even one holding a single changed file) keeps the listing.
  const soleSel = a.sel ?? b.sel;
  if (soleSel && tree.entries.length === 1 && tree.entries[0].path === soleSel) {
    await openEntry(tree.entries[0]);
    if (pager) pager.root = true;
  }
  const pending: string[] = [];
  let wake: (() => void) | undefined;
  const onData = (chunk: unknown): void => {
    pending.push(...tokenize(String(chunk)));
    const cont = wake;
    wake = undefined;
    cont?.();
  };
  input.setRawMode?.(true);
  input.on('data', onData);
  input.resume();
  // The TUI owns the terminal from here; mute the startup progress line.
  progressOff();
  output.write(ALT_ON + MOUSE_ON);
  const draw = (): void => (pager ? drawPager(pager) : drawList());
  // Shrinking the terminal would scroll a taller stale frame off the top;
  // redraw on resize so the frame always fits the current window.
  const onResize = (): void => draw();
  process.stdout.on('resize', onResize);
  let mouseHeld = true;
  try {
    loop: for (;;) {
      // Release the mouse while the pager is up so native text selection —
      // copying diff lines — keeps working; take it back for the listing.
      if (mouseHeld === !!pager) {
        mouseHeld = !pager;
        output.write(mouseHeld ? MOUSE_ON : MOUSE_OFF);
      }
      draw();
      while (!pending.length)
        await new Promise<void>((res) => {
          wake = res;
        });
      const unit = pending.shift();
      const mouse = unit && !pager ? mouseOf(unit) : undefined;
      let key = unit ? (mouse ? mouse.key : keyOf(unit)) : undefined;
      if (key === 'exit') break;
      if (pager) {
        const page = pager;
        const jump = Math.max(3, term().rows - 3);
        switch (key) {
          case 'esc':
            // q/esc back out one level — from a deep-linked root diff that
            // is leaving the session, like the navigator's root preview.
            if (page.root) break loop;
            pager = undefined;
            break;
          case 'back':
            pager = undefined;
            break;
          case 'down':
          case 'enter':
            page.offset += 1;
            break;
          case 'up':
            page.offset -= 1;
            break;
          case 'pgdn':
            page.offset += jump;
            break;
          case 'pgup':
            page.offset -= jump;
            break;
          case 'halfdn':
            page.offset += Math.ceil(jump / 2);
            break;
          case 'halfup':
            page.offset -= Math.ceil(jump / 2);
            break;
          case 'top':
            page.offset = 0;
            break;
          case 'bottom':
            page.offset = Infinity;
            break;
        }
        continue;
      }
      // Same click contract as every listing: select first, open on the second.
      if (mouse?.row !== undefined) {
        const at = offset + mouse.row - LIST_TOP;
        if (mouse.row < LIST_TOP || at >= Math.min(tree.entries.length, offset + listRows()))
          continue;
        if (at !== cursor) {
          cursor = at;
          continue;
        }
        key = 'enter';
      }
      const jump = listRows();
      switch (key) {
        case 'esc':
          break loop;
        case 'up':
          cursor = Math.max(0, cursor - 1);
          break;
        case 'down':
          cursor = Math.min(tree.entries.length - 1, cursor + 1);
          break;
        case 'pgup':
          cursor = Math.max(0, cursor - jump);
          break;
        case 'pgdn':
          cursor = Math.min(tree.entries.length - 1, cursor + jump);
          break;
        case 'halfup':
          cursor = Math.max(0, cursor - Math.ceil(jump / 2));
          break;
        case 'halfdn':
          cursor = Math.min(tree.entries.length - 1, cursor + Math.ceil(jump / 2));
          break;
        case 'top':
          cursor = 0;
          break;
        case 'bottom':
          cursor = Math.max(0, tree.entries.length - 1);
          break;
        case 'enter': {
          const entry = tree.entries[cursor];
          if (entry) await openEntry(entry);
          break;
        }
      }
    }
  } finally {
    process.stdout.off('resize', onResize);
    output.write(MOUSE_OFF + ALT_OFF);
    input.off('data', onData);
    input.setRawMode?.(false);
    input.pause();
  }
};

// Standalone pager session: one text on the alternate screen with the full
// vim-flavored pager — scroll, `/` search (n/N repeat), `:` line jump. The
// terminal face for payloads that would otherwise dump into scrollback: bundle
// text (-b) and bundle diffs (-db); pipes get the raw text, never this. No
// mouse reporting, so native text selection (copying source) keeps working.
export const runPager = async (
  title: string,
  text: string,
  opts: { ansi?: boolean; footer?: string; io?: InteractiveIo } = {}
): Promise<void> => {
  const io = opts.io ?? {};
  const input = io.input ?? process.stdin;
  const output = io.output ?? process.stdout;
  const colorOn = wantColor();
  const term = () => ({
    cols: io.cols ?? (process.stdout.columns || 80),
    rows: io.rows ?? (process.stdout.rows || 24),
  });
  const render = (lines: string[]): void => {
    const max = term().cols - 1;
    output.write(`\x1b[H${lines.map((line) => truncAnsi(line, max)).join('\x1b[K\r\n')}\x1b[J`);
  };
  // Raw bundle text must not opt into ANSI merely because its bytes resemble
  // one of bismar's SGRs. Highlighted callers mark their composed colors as
  // trusted; everything else takes the plain-text boundary.
  const safeText = opts.ansi ? displayText(text) : terminalText(text, { multiline: true, tabs: 2 });
  const page: Pager = { lines: safeText.split('\n'), offset: 0, title };
  let ask: { kind: ':' | '/'; text: string } | undefined;
  let lastSearch = '';
  // The logical line currently at the top of the pager window.
  const topLineOf = (): number => {
    const starts = page.wrap?.starts ?? [0];
    let at = 0;
    for (const [i, start] of starts.entries())
      if (start <= page.offset) at = i;
      else break;
    return at;
  };
  // 0-based logical line -> wrapped-row offset; the draw clamp handles the end.
  const gotoLine = (line: number): void => {
    const starts = page.wrap?.starts ?? [0];
    page.offset = starts[Math.max(0, Math.min(starts.length - 1, line))] ?? 0;
  };
  // Case-sensitive substring over the text itself (colors stripped), wrapping
  // around either way like vim.
  const findNext = (dir: 1 | -1): void => {
    if (!lastSearch) return;
    const total = page.lines.length;
    const from = topLineOf();
    for (let step = 1; step <= total; step++) {
      const i = (((from + dir * step) % total) + total) % total;
      if (stripAnsi(page.lines[i]).includes(lastSearch)) return gotoLine(i);
    }
  };
  const submitAsk = (): void => {
    if (!ask) return;
    if (ask.kind === ':') {
      const line = Number.parseInt(ask.text, 10);
      if (Number.isFinite(line) && line > 0) gotoLine(line - 1);
    } else {
      // A bare `/` repeats the previous pattern, like vim.
      if (ask.text) lastSearch = ask.text;
      findNext(1);
    }
    ask = undefined;
  };
  const draw = (): void => {
    const { cols, rows } = term();
    const visible = Math.max(3, rows - 3);
    const max = Math.max(1, cols - 1);
    if (page.wrap?.cols !== max) {
      const wrapRows: string[] = [];
      const starts: number[] = [];
      for (const line of page.lines) {
        starts.push(wrapRows.length);
        wrapRows.push(...wrapAnsi(line, max));
      }
      page.wrap = { cols: max, rows: wrapRows, starts };
    }
    const wrapped = page.wrap.rows;
    const maxOffset = Math.max(0, wrapped.length - visible);
    page.offset = Math.max(0, Math.min(page.offset, maxOffset));
    const pct = maxOffset ? Math.round((page.offset / maxOffset) * 100) : 100;
    const foot = ask
      ? `${ask.kind}${terminalText(ask.text)}`
      : paint(
          `${pct}%${opts.footer ? ` · ${opts.footer}` : ''} · ↑↓/space scroll · / search · q quit`,
          color.dim,
          colorOn
        );
    render([
      paintId(page.title, colorOn, 'module') +
        paint(` · ${page.lines.length} lines`, color.dim, colorOn),
      ...wrapped.slice(page.offset, page.offset + visible),
      // A highlight color may span past the window's last line; close it.
      (colorOn ? color.reset : '') + foot,
    ]);
  };
  const pending: string[] = [];
  let wake: (() => void) | undefined;
  const onData = (chunk: unknown): void => {
    pending.push(...tokenize(String(chunk)));
    const cont = wake;
    wake = undefined;
    cont?.();
  };
  input.setRawMode?.(true);
  input.on('data', onData);
  input.resume();
  // The TUI owns the terminal from here; mute the startup progress line.
  progressOff();
  output.write(ALT_ON);
  // Shrinking the terminal would scroll a taller stale frame off the top;
  // redraw on resize so the frame always fits the current window.
  const onResize = (): void => draw();
  process.stdout.on('resize', onResize);
  try {
    for (;;) {
      draw();
      while (!pending.length)
        await new Promise<void>((res) => {
          wake = res;
        });
      const unit = pending.shift();
      const key = keyOf(unit);
      // Ctrl-C/Ctrl-D close from anywhere, prompt open or not.
      if (key === 'exit') return;
      // An open `/`/`:` prompt eats raw characters, not their bindings.
      if (ask) {
        if (unit === '\r' || unit === '\n') submitAsk();
        else if (unit === '\x1b') ask = undefined;
        else if (unit === '\x7f' || unit === '\b') ask.text = ask.text.slice(0, -1);
        else if (unit && unit.length === 1 && unit >= ' ' && unit !== '\x7f') ask.text += unit;
        continue;
      }
      const jump = Math.max(3, term().rows - 3);
      switch (key) {
        // A lone pager is its own session root: q/esc exit; ←/h are
        // navigation keys with nowhere to climb, so they stay put.
        case 'esc':
          return;
        case 'down':
        case 'enter':
          page.offset += 1;
          break;
        case 'up':
          page.offset -= 1;
          break;
        case 'pgdn':
          page.offset += jump;
          break;
        case 'pgup':
          page.offset -= jump;
          break;
        case 'halfdn':
          page.offset += Math.ceil(jump / 2);
          break;
        case 'halfup':
          page.offset -= Math.ceil(jump / 2);
          break;
        case 'top':
          page.offset = 0;
          break;
        case 'bottom':
          // Wrapping can make more rows than lines; the draw clamp finds the end.
          page.offset = Infinity;
          break;
        case 'search':
          ask = { kind: '/', text: '' };
          break;
        case 'goto':
          ask = { kind: ':', text: '' };
          break;
        case 'next':
          findNext(1);
          break;
        case 'prev':
          findNext(-1);
          break;
      }
    }
  } finally {
    process.stdout.off('resize', onResize);
    output.write(ALT_OFF);
    input.off('data', onData);
    input.setRawMode?.(false);
    input.pause();
  }
};

export const runInteractive = async (
  selector: string | undefined,
  opts: InteractiveOpts = {}
): Promise<void> => {
  const baseDir = resolve(opts.cwd ?? process.cwd());
  // The launcher runs before any context resolves: its choice is the selector.
  // Menu sessions loop: ← from a session's root reopens the launcher on the
  // parked stage (same option, query, and hits), so picks can be compared.
  // Profile sessions (`bismar gh:@user`) seed the launcher directly on its
  // results stage, pre-filled with the profile's packages.
  const menu =
    (opts.menu || opts.profile) && selector === undefined
      ? opts.profile
        ? ({
            results: {
              cursor: 0,
              hits: opts.profile.hits,
              root: true,
              title: displayLabel(`${opts.profile.prefix}@${opts.profile.user}`),
              which: whichOf(opts.profile.prefix),
            },
          } as LauncherState)
        : ({} as LauncherState)
      : undefined;
  let backChain: string[] = [];
  for (;;) {
    let chosen = selector;
    let dirOnly = false;
    let handoff: string[] = [];
    // A profile listing's crumb heads the session crumb of whatever it opens.
    let via = '';
    if (menu) {
      const picked = await chooseTarget(basename(baseDir) || baseDir, opts.io, menu, backChain);
      if (!picked) return;
      backChain = [];
      handoff = picked.leftover;
      via = picked.via ?? '';
      if (picked.selector) chosen = picked.selector;
      // Package-less directories still browse: their files are the surface.
      else dirOnly = !existsSync(join(baseDir, 'package.json'));
    }
    // Set when a session root takes ← back to the launcher instead of exiting.
    let toLauncher = false;
    const tmp = tempDir('size');
    try {
      let mods: Mod[] = [];
      let label = '';
      // Root of the shipped files for the files view: the package's own directory.
      let pkgRoot = '';
      // Non-empty for refs: the pinned display label doubles as the selector prefix.
      let refSel = '';
      // Non-empty for filesystem selectors: the file's own spelling measures it.
      let fileMode = '';
      // Non-empty for npm/jsr refs with a `/path` tail: a deep link into the
      // shipped files view, resolved by diff's scoped rule once the tree exists.
      let refFocus = '';
      // Navigator-only ecosystems (crates.io, rubygems, pypi, packagist, github,
      // the go proxy): fetch + extract, then browse shipped files. There is no JS
      // to enumerate or weigh, so the modules view, size measurement, and bundling
      // stay off; the session lives in the files view.
      const regSel = chosen && isRegistrySelector(chosen) ? chosen : '';
      const filesOnly = !!regSel || dirOnly;
      // The extract's ecosystem, for manifest reads that spell differently per
      // registry; unset for JS packages and plain directories.
      let regRef: RegistryRef | undefined;
      if (regSel) {
        regRef = parseRegistryRef(regSel);
        const got = await registryContext(tmp, regRef);
        label = got.label;
        pkgRoot = got.pkgDir;
        // Fixed-arity registry refs deep-link like npm ones (parseRegistryRef
        // keeps variable-arity names — go:, gitlab: — whole, path '').
        refFocus = regRef.path;
      } else if (dirOnly) {
        // Current directory chosen from the launcher, no package.json around:
        // browse the tree like a registry extract — files only, nothing to
        // enumerate, measure, or bundle.
        label = basename(baseDir) || baseDir;
        pkgRoot = baseDir;
      } else {
        // Same package resolution as browse mode: local by default, an explicit
        // npm/jsr ref or a filesystem path otherwise; deep module paths make no
        // sense for a navigator, so they are refused.
        const build = loadEsbuild().build;
        const sel = chosen ?? '';
        const asFile = (raw: string): boolean => isFile(resolve(baseDir, raw));
        // `./`, `../`, and absolute selectors always mean the filesystem; a bare
        // path takes file semantics only when it exists and names no public module.
        if (sel && explicitPath(sel)) {
          if (!asFile(sel)) err(`missing input file: ${bad(sel)}`);
          fileMode = sel;
        }
        if (!fileMode) {
          const hasPkg = existsSync(join(baseDir, 'package.json'));
          const noLocal = !!sel && !hasPkg && npmRef(sel);
          // Bare names never imply npm: outside a package they can only be a
          // mistake, so say where to go instead of "missing package.json".
          if (sel && !hasPkg && !noLocal) noPkgErr(sel, baseDir);
          const ctx: Ctx = noLocal ? noPkgCtx(baseDir, tmp) : resolveCtx(opts.cwd, tmp);
          mods = noLocal ? [] : readModules(ctx);
          label = ctx.pkg.name;
          pkgRoot = ctx.pkgDir;
          // Set for pinned refs: freshly enumerated exports cache in this dir's db.
          let refDbDir: string | undefined;
          if (sel && sel !== '.' && sel !== ctx.pkg.name) {
            const localSet = new Set(mods.map((mod) => mod.module));
            if (!npmRef(sel)) {
              if (
                ONLY_EXT.test(sel) &&
                !localSet.has(firstModule(ctx.pkg.name, sel)) &&
                asFile(sel)
              )
                // A bare JS file that names no public module: navigate the file.
                fileMode = sel;
              else {
                const use = npmHintUse(sel);
                err(
                  `interactive mode expects a package or file, not ${bad(sel)}${use ? `; ${use}` : ''}`
                );
              }
            } else {
              const ref = parseNpmRef(asRef(sel));
              // A `/path` tail deep-links the files view; the package itself
              // still browses whole (refContext ignores the path).
              refFocus = ref.path;
              const got = refContext(ctx.outDir, ref);
              mods = readModules(got.refCtx);
              pkgRoot = got.refCtx.pkgDir;
              // Pinned refs enumerated before (browse, --list, a past session) skip
              // the per-module metafile passes; sizes still stream in via runSize's
              // own cache.
              if (!got.refDir.startsWith(tmp)) {
                refDbDir = got.refDir;
                applyDbExports(refDbDir, mods);
              }
              label = got.label;
              // Measurement selectors need the explicit prefix: a bare unscoped
              // pinned label (`viem@2.55.10`) never reads as an npm ref, so every
              // row of such a package would fail to build. jsr labels carry
              // theirs already; scoped ones gain a harmless npm: spelling.
              refSel = asRef(got.label);
            }
          }
          if (!fileMode) {
            if (!mods.length) err(`no importable JS modules found in ${label || baseDir}`);
            const unfilled = mods.filter((mod) => !mod.exports.length);
            await fillExports(build, unfilled);
            if (refDbDir && unfilled.length) saveRefDb(refDbDir, { modules: toDbModules(mods) });
          }
        }
        if (fileMode) {
          // The file is the package: one module, exports enumerated, browsed and
          // measured through the same file-selector spelling `runSize` accepts.
          const ictx = inputCtx(opts.cwd, tmp, fileMode);
          mods = inputMods(ictx, fileMode);
          label = ictx.pkg.name;
          pkgRoot = dirname(resolve(baseDir, fileMode));
          await fillExports(build, mods);
        }
      }
      // Breadcrumbs, one grammar: labels display with the long registry name
      // (`github:veorq/oee@6b9abbad7dac`), and a session opened from a profile
      // listing keeps the profile as its head with the redundant owner/scope
      // collapsed (`github:@veorq · oee@6b9abbad7dac`). Selectors and row ids
      // keep their canonical spellings; only the crumb is prettified — into a
      // spelling that is still a valid selector.
      if (via) {
        const slash = label.indexOf('/');
        const colon = label.indexOf(':');
        label = `${via} · ${slash >= 0 ? label.slice(slash + 1) : colon >= 0 ? label.slice(colon + 1) : label}`;
      } else label = displayLabel(label);
      // `r` target: the github repo the browsed package's own manifest advertises
      // — package.json for JS, Cargo.toml/composer.json/core metadata/gemspec or
      // the import path itself for registry extracts. gh:/gitlab: are the repo.
      // The ecosystem that named it labels the way back.
      const home = ghRepoOf(pkgRoot, regRef?.prefix, regRef?.name);
      const ghRepo = home.repo;
      const colorOn = wantColor();
      const stats = new Map<string, Cell>();
      const sources = new Map<string, string[]>();
      const rootEntries: IEntry[] = filesOnly
        ? []
        : fileMode
          ? // One file, one module: it is its own package row.
            mods.map((mod) => ({
              kind: 'module' as const,
              mod,
              sel: fileMode,
              text: fileBase(mod),
            }))
          : [
              // `.` is the whole package, exactly like the selector it measures as.
              { kind: 'pkg', sel: refSel || '.', text: '.' },
              ...mods.map((mod) => ({
                kind: 'module' as const,
                mod,
                sel: refSel ? `${refSel}/${mod.module}` : mod.module,
                text: fileBase(mod),
              })),
            ];
      let current: IEntry | undefined;
      let list = rootEntries;
      let cursor = 0;
      let offset = 0;
      let rootCursor = 0;
      let pager: Pager | undefined;
      // Vim-flavored pager commands: `/pattern` searches forward (n/N repeat),
      // `:510` jumps to a line; the prompt buffers on the footer row.
      let ask: { kind: ':' | '/'; text: string } | undefined;
      let lastSearch = '';
      let closed = false;
      // Package-files view: the home view for every session, kept across toggles.
      // `m` switches JS packages to the modules view; files-only sessions stay here.
      let filesMode = true;
      let fileRel = '';
      let fileList: FEntry[] = [];
      let fileCursor = 0;
      let fileOffset = 0;
      const fileViews = new Map<string, string[]>();
      // `r` toggles between the package's shipped files and its github repository
      // (fetched on first use); the inactive side's position parks until swapped back.
      let repo: { dir: string; label: string } | undefined;
      let repoMode = false;
      let parked = { cursor: 0, offset: 0, rel: '' };
      const input = opts.io?.input ?? process.stdin;
      const output = opts.io?.output ?? process.stdout;
      const term = () => ({
        cols: opts.io?.cols ?? (process.stdout.columns || 80),
        rows: opts.io?.rows ?? (process.stdout.rows || 24),
      });
      const listRows = (): number => Math.max(3, term().rows - 4);
      // In-place frame swap: home the cursor, overwrite each line clearing its tail,
      // then clear whatever a taller previous frame left below. A `\x1b[2J` wipe per
      // frame blanks the screen between clear and rewrite — visible flicker, since
      // background measurement redraws after every finished row. Truncation keeps
      // every line on one row; a wrapped line would scroll and shift the whole frame.
      const render = (lines: string[]): void => {
        const max = term().cols - 1;
        output.write(`\x1b[H${lines.map((line) => truncAnsi(line, max)).join('\x1b[K\r\n')}\x1b[J`);
      };
      const tailOf = (entry: IEntry): string => {
        if (entry.kind === 'back') return '';
        const got = stats.get(entry.sel);
        const text =
          got === 'pending'
            ? 'measuring…'
            : got === 'failed'
              ? '(build failed)'
              : got
                ? statsTail(got)
                : '…';
        return paint(`  ${text}`, color.dim, colorOn);
      };
      // Shipped files under one directory, dirs first; never the dev-only trees.
      const FILE_SKIP = new Set(['.git', 'node_modules']);
      // The two files people open first — the readme and the package manifest —
      // lead the file group, right after the directories.
      const FILE_META = /^readme|^package\.json$/i;
      const fileRank = (ent: FEntry): number => (ent.dir ? 0 : FILE_META.test(ent.name) ? 1 : 2);
      // Footprint: recursive bytes + file count per directory — honest size
      // information for every ecosystem (unlike bundle stats, which are JS-only).
      // One walk per root memoizes every subdirectory along the way; lstat keeps
      // symlinks from reaching outside the tree, and dev-only dirs never count.
      const footprints = new Map<string, { bytes: number; files: number }>();
      const footprintOf = (path: string): { bytes: number; files: number } => {
        const got = footprints.get(path);
        if (got) return got;
        let bytes = 0;
        let files = 0;
        try {
          // Dirents classify for free; only regular files need the extra lstat
          // (for size) — that halves the syscalls of the walk.
          for (const ent of readdirSync(path, { withFileTypes: true })) {
            if (FILE_SKIP.has(ent.name)) continue;
            if (ent.isDirectory()) {
              const sub = footprintOf(join(path, ent.name));
              bytes += sub.bytes;
              files += sub.files;
            } else if (ent.isFile()) {
              bytes += lstatSync(join(path, ent.name), { throwIfNoEntry: false })?.size ?? 0;
              files += 1;
            }
          }
        } catch {
          // Unreadable directory: count what could be seen.
        }
        const res = { bytes, files };
        footprints.set(path, res);
        return res;
      };
      const footTail = (foot: { bytes: number; files: number }): string =>
        `${foot.files} file${foot.files === 1 ? '' : 's'}, ${fmtBytes(foot.bytes)}`;
      const filesRoot = (): string => (repoMode && repo ? repo.dir : pkgRoot);
      const listFiles = (rel: string): FEntry[] => {
        const out: FEntry[] = [];
        for (const name of readdirSync(join(filesRoot(), rel))) {
          if (FILE_SKIP.has(name)) continue;
          const path = join(filesRoot(), rel, name);
          try {
            // lstat, like the footprint walk: hardened extraction rejects
            // archive links, while local trees and old caches may still have
            // them. Never let a preview follow one outside its root.
            const st = lstatSync(path);
            if (st.isSymbolicLink()) continue;
            out.push({ dir: st.isDirectory(), name, path, size: st.size });
          } catch {
            // Vanished mid-walk: nothing to list.
          }
        }
        return out.sort((a, b) => fileRank(a) - fileRank(b) || a.name.localeCompare(b.name));
      };
      // Subdirs list `..` first, like the exports view; esc exits from the root.
      const filesOf = (rel: string): FEntry[] => [
        ...(rel ? [{ dir: true, name: '..', path: '', size: 0 }] : []),
        ...listFiles(rel),
      ];
      const fileDown = (ent: FEntry): void => {
        fileRel = fileRel ? `${fileRel}/${ent.name}` : ent.name;
        fileList = filesOf(fileRel);
        fileCursor = fileList.length > 1 ? 1 : 0;
        fileOffset = 0;
      };
      const fileUp = (): void => {
        const slash = fileRel.lastIndexOf('/');
        const child = slash < 0 ? fileRel : fileRel.slice(slash + 1);
        fileRel = slash < 0 ? '' : fileRel.slice(0, slash);
        fileList = filesOf(fileRel);
        // Land back on the directory just climbed out of.
        fileCursor = Math.max(
          0,
          fileList.findIndex((ent) => ent.dir && ent.name === child)
        );
        fileOffset = 0;
      };
      const swapSides = (): void => {
        const cur = { cursor: fileCursor, offset: fileOffset, rel: fileRel };
        ({ cursor: fileCursor, offset: fileOffset, rel: fileRel } = parked);
        parked = cur;
        repoMode = !repoMode;
        fileList = filesOf(fileRel);
        fileCursor = Math.min(fileCursor, Math.max(0, fileList.length - 1));
      };
      const drawFiles = (): void => {
        const visible = listRows();
        if (fileCursor < fileOffset) fileOffset = fileCursor;
        if (fileCursor >= fileOffset + visible) fileOffset = fileCursor - visible + 1;
        const side = repoMode && repo ? repo.label : label;
        const crumb =
          paintId(fileRel ? `${side}/${fileRel}` : side, colorOn, 'module') +
          paint(` · files · ${footTail(footprintOf(filesRoot()))}`, color.dim, colorOn);
        const lines = [crumb, ''];
        for (const [i, ent] of fileList.slice(fileOffset, fileOffset + visible).entries()) {
          const active = fileOffset + i === fileCursor;
          const text = terminalText(ent.dir && ent.name !== '..' ? `${ent.name}/` : ent.name);
          // Dirs keep their cyan; plain files stay unpainted so the two entry
          // points a package always has — its README and manifest — pop in red.
          const hot = !ent.dir && (ent.name === 'package.json' || /^readme(\.|$)/i.test(ent.name));
          const name = ent.dir
            ? paint(text, ent.name === '..' ? color.dim : color.cyan, colorOn)
            : hot
              ? paint(text, color.red, colorOn)
              : text;
          // Directories carry their footprint, files their own size; `..` stays bare.
          const tail =
            ent.dir && ent.name !== '..'
              ? paint(`  ${footTail(footprintOf(ent.path))}`, color.dim, colorOn)
              : ent.dir
                ? ''
                : paint(`  ${kb(ent.size)}kb`, color.dim, colorOn);
          lines.push(`${active ? paint('▸ ', color.bold, colorOn) : '  '}${name}${tail}`);
        }
        // Both hints name where the key lands: github on the way out, the
        // package's own ecosystem on the way back.
        const hop = ghRepo ? (repoMode ? ` · r get back to ${home.eco}` : ' · r github') : '';
        // q ≡ esc: inside a subtree (or on the repo side) it backs up first;
        // only the home root's q actually leaves.
        const qHint = fileRel || repoMode ? 'q back' : 'q quit';
        lines.push(
          '',
          paint(
            filesOnly
              ? `↑↓ move · enter preview · ← up${hop} · ${qHint}`
              : `↑↓ move · enter preview · ← up · m mode (bundles)${hop} · ${qHint}`,
            color.dim,
            colorOn
          )
        );
        render(lines);
      };
      const drawBrowse = (): void => {
        const visible = listRows();
        if (cursor < offset) offset = cursor;
        if (cursor >= offset + visible) offset = cursor - visible + 1;
        const crumb = current ? `${label}/${current.text}` : label;
        const lines = [paintId(crumb, colorOn, 'module'), ''];
        for (const [i, entry] of list.slice(offset, offset + visible).entries()) {
          const active = offset + i === cursor;
          const name = paint(
            entry.text,
            entry.kind === 'export'
              ? color.green
              : entry.kind === 'module'
                ? color.cyan
                : entry.kind === 'pkg'
                  ? color.yellow
                  : color.dim,
            colorOn
          );
          lines.push(`${active ? paint('▸ ', color.bold, colorOn) : '  '}${name}${tailOf(entry)}`);
        }
        lines.push(
          '',
          paint(
            current
              ? '↑↓ move · enter source · ← back · m mode (files) · q back'
              : '↑↓ move · enter open · m mode (files) · q quit',
            color.dim,
            colorOn
          )
        );
        render(lines);
      };
      const drawPager = (page: Pager): void => {
        const { cols, rows } = term();
        const visible = Math.max(3, rows - 3);
        // Long lines wrap instead of truncating; offsets scroll over wrapped rows.
        const max = Math.max(1, cols - 1);
        if (page.wrap?.cols !== max) {
          const wrapRows: string[] = [];
          const starts: number[] = [];
          for (const line of page.lines) {
            starts.push(wrapRows.length);
            wrapRows.push(...wrapAnsi(line, max));
          }
          page.wrap = { cols: max, rows: wrapRows, starts };
        }
        const wrapped = page.wrap.rows;
        const maxOffset = Math.max(0, wrapped.length - visible);
        page.offset = Math.max(0, Math.min(page.offset, maxOffset));
        const shown = wrapped.slice(page.offset, page.offset + visible);
        const pct = maxOffset ? Math.round((page.offset / maxOffset) * 100) : 100;
        const lines = [
          paintId(page.title, colorOn, 'auto') +
            paint(` · ${page.lines.length} lines`, color.dim, colorOn),
          ...shown,
          // A highlight token may span past the window's last line; close its color.
          // While a `/`/`:` prompt is open, the footer row is its input line.
          (colorOn ? color.reset : '') +
            (ask
              ? `${ask.kind}${terminalText(ask.text)}`
              : paint(
                  // A root preview exits on esc like q; ← still opens the
                  // listing underneath — the footer says which is which.
                  page.root
                    ? `${pct}% · ↑↓/space scroll · /search · :goto · ← files · q quit`
                    : `${pct}% · ↑↓/space scroll · /search · :goto · q back`,
                  color.dim,
                  colorOn
                )),
        ];
        render(lines);
      };
      // Click → listing index; the header, footer, and rows past the drawn slice miss.
      const clickAt = (row: number, off: number, len: number): number => {
        const at = off + row - LIST_TOP;
        return row >= LIST_TOP && at < Math.min(len, off + listRows()) ? at : -1;
      };
      const draw = (): void => {
        if (closed) return;
        if (pager) drawPager(pager);
        else if (filesMode) drawFiles();
        else drawBrowse();
      };
      // The logical line currently at the top of the pager window.
      const topLineOf = (page: Pager): number => {
        const starts = page.wrap?.starts ?? [0];
        let at = 0;
        for (const [i, start] of starts.entries())
          if (start <= page.offset) at = i;
          else break;
        return at;
      };
      // 0-based logical line -> wrapped-row offset; the draw clamp handles the end.
      const gotoLine = (page: Pager, line: number): void => {
        const starts = page.wrap?.starts ?? [0];
        page.offset = starts[Math.max(0, Math.min(starts.length - 1, line))] ?? 0;
      };
      // Case-sensitive substring over the file's own text (colors stripped),
      // wrapping around either way like vim.
      const findNext = (page: Pager, dir: 1 | -1): void => {
        if (!lastSearch) return;
        const total = page.lines.length;
        const from = topLineOf(page);
        for (let step = 1; step <= total; step++) {
          const i = (((from + dir * step) % total) + total) % total;
          if (stripAnsi(page.lines[i]).includes(lastSearch)) return gotoLine(page, i);
        }
      };
      const submitAsk = (page: Pager): void => {
        if (!ask) return;
        if (ask.kind === ':') {
          const line = Number.parseInt(ask.text, 10);
          if (Number.isFinite(line) && line > 0) gotoLine(page, line - 1);
        } else {
          // A bare `/` repeats the previous pattern, like vim.
          if (ask.text) lastSearch = ask.text;
          findNext(page, 1);
        }
        ask = undefined;
      };
      // Diagnostic notes normally go to stderr, which the alternate screen does not
      // capture: each line would scroll (and jitter) the TUI. The rows tell the story.
      const muteNotes = (): void => undefined;
      const bundleOf = (sel: string): Promise<Built | undefined> =>
        buildFirst({ cwd: opts.cwd, onNote: muteNotes, only: [sel], outDir: tmp });
      const measureOne = async (entry: IEntry): Promise<void> => {
        const got = stats.get(entry.sel);
        if (entry.kind === 'back' || got === 'pending' || (got && got !== 'failed')) return;
        stats.set(entry.sel, 'pending');
        draw();
        try {
          // onRow (unlike bundleOf's onBuilt) lets pinned-ref rows come straight
          // from the machine cache without touching esbuild.
          let row: Stats | undefined;
          await runSize({
            cwd: opts.cwd,
            onNote: muteNotes,
            onRow: (data) => {
              row ??= { gz: data.gzBytes, loc: data.loc, min: data.minBytes };
            },
            only: [entry.sel],
            outDir: tmp,
            silent: true,
            single: true,
          });
          if (!row) return err('no bundles found');
          stats.set(entry.sel, row);
        } catch {
          // Keep navigating; the row shows the failure and `s` retries it.
          stats.set(entry.sel, 'failed');
        }
      };
      // Sizes appear on their own: every new view queues its rows for background
      // measurement — a couple at a time, so navigation stays responsive while
      // stats fill in faster than a strict one-by-one pump.
      const queue: IEntry[] = [];
      let pump: Promise<void> = Promise.resolve();
      let pumping = false;
      const drain = async (): Promise<void> => {
        pumping = true;
        try {
          const worker = async (): Promise<void> => {
            for (;;) {
              const entry = queue.shift();
              if (!entry || closed) break;
              if (entry.kind === 'back' || stats.has(entry.sel)) continue;
              await measureOne(entry);
              draw();
            }
          };
          await Promise.all(Array.from({ length: Math.min(2, BUILD_POOL) }, worker));
        } finally {
          pumping = false;
        }
      };
      const autoMeasure = (entries: IEntry[]): void => {
        queue.push(...entries);
        if (!pumping) pump = drain();
      };
      const openSource = async (entry: IEntry): Promise<void> => {
        if (entry.kind === 'back') return;
        let lines = sources.get(entry.sel);
        if (!lines) {
          render([paint(`bundling ${entry.sel}…`, color.dim, colorOn)]);
          try {
            const built = await bundleOf(entry.sel);
            if (!built) return;
            let text = terminalText(decoder.decode(built.plain), { multiline: true, tabs: 2 });
            if (colorOn)
              // Highlight tokens carry their own resets, so line-splitting is safe.
              text = await highlightText(text, 'js').catch(() => text);
            lines = text.split('\n');
            sources.set(entry.sel, lines);
          } catch {
            // Stay in the browser; the row's failed marker tells the story.
            return;
          }
        }
        pager = { lines, offset: 0, title: entry.sel };
      };
      // Preview a shipped file as text — highlighted for known languages, never
      // bundled or executed. Binary content gets a stub instead of escape soup.
      const openFile = async (ent: FEntry): Promise<void> => {
        let lines = fileViews.get(ent.path);
        if (!lines) {
          let text: string;
          try {
            text = readFileSync(ent.path, 'utf8');
          } catch {
            return;
          }
          if (text.includes('\0')) text = `(binary file, ${kb(ent.size)}kb)`;
          else {
            text = terminalText(text, { multiline: true, tabs: 2 });
            const lang = colorOn ? languageFromFilename(ent.name) : undefined;
            if (lang) text = await highlightText(text, lang).catch(() => text);
          }
          lines = text.split('\n');
          fileViews.set(ent.path, lines);
        }
        // In-file view: the full previous path — session crumb, then the
        // file's own path — so the pager header reads as one address.
        const side = repoMode && repo ? repo.label : label;
        pager = { lines, offset: 0, title: `${side}/${fileRel ? `${fileRel}/` : ''}${ent.name}` };
      };
      const toRoot = (): void => {
        current = undefined;
        list = rootEntries;
        cursor = rootCursor;
        offset = 0;
      };
      const pending: string[] = [];
      let wake: (() => void) | undefined;
      const onData = (chunk: unknown): void => {
        pending.push(...tokenize(String(chunk)));
        const cont = wake;
        wake = undefined;
        cont?.();
      };
      // Deep link: a ref tail focuses the files view before the first draw — an
      // exact shipped file opens with its preview up, a directory opens on its
      // listing. A tail matching nothing is a typo'd path, never a silently
      // whole-package browse; erroring here leaves the terminal untouched (the
      // TUI is not up yet).
      if (refFocus) {
        const files = scoped(walkFiles(pkgRoot), refFocus);
        if (!files.size) {
          // The tail may have meant a module (`/decode`); its file is the
          // shipped spelling (`/decode.js`) — bridge the two grammars.
          const asMod = mods.find((mod) => mod.module === refFocus.replace(ONLY_EXT, ''));
          err(
            `no shipped file matches /${bad(refFocus)}; ` +
              (asMod ? `the module's file ships as /${fileBase(asMod)}` : 'drop the tail to browse')
          );
        }
        if (files.has(refFocus)) {
          const slash = refFocus.lastIndexOf('/');
          fileRel = slash < 0 ? '' : refFocus.slice(0, slash);
          const name = slash < 0 ? refFocus : refFocus.slice(slash + 1);
          const listing = filesOf(fileRel);
          const at = listing.findIndex((ent) => !ent.dir && ent.name === name);
          if (at >= 0) {
            fileCursor = at;
            await openFile(listing[at]);
            // The selector asked for this file: its preview is the session
            // root, so backing out of it (esc) means leaving, not browsing.
            if (pager) pager.root = true;
          }
        } else fileRel = refFocus.replace(/\/+$/, '');
      }
      input.setRawMode?.(true);
      input.on('data', onData);
      input.resume();
      // Type-ahead that arrived while the launcher menu was up belongs here.
      pending.push(...handoff);
      // Setup (installs, enumeration) reported through the startup progress line;
      // from here the TUI owns the terminal, so mute it for good.
      progressOff();
      output.write(ALT_ON + MOUSE_ON);
      // Shrinking the terminal would scroll a taller stale frame off the top;
      // redraw on resize so the frame always fits the current window.
      const onResize = (): void => draw();
      process.stdout.on('resize', onResize);
      // Stdin is raw and ours from here: mid-session fetches (the `r` repo
      // hop) must refuse oversized archives instead of prompting into the TUI.
      setBigArchivePolicy('refuse');
      let mouseHeld = true;
      // The home view needs its listing up front; JS sizes start measuring behind
      // it so the modules view is already filling in when toggled to.
      fileList = filesOf(fileRel);
      if (!filesOnly) autoMeasure(rootEntries);
      try {
        loop: for (;;) {
          // Every pager open/close funnels through here: release the mouse while
          // it is up, take it back for the listing views.
          if (mouseHeld === !!pager) {
            mouseHeld = !pager;
            output.write(mouseHeld ? MOUSE_ON : MOUSE_OFF);
          }
          draw();
          while (!pending.length)
            await new Promise<void>((res) => {
              wake = res;
            });
          const unit = pending.shift();
          // Reports queued just before the pager took over decode to nothing.
          const mouse = unit && !pager ? mouseOf(unit) : undefined;
          let key = unit ? (mouse ? mouse.key : keyOf(unit)) : undefined;
          // Ctrl-C/Ctrl-D close the whole app no matter which view is open.
          if (key === 'exit') break;
          if (pager) {
            const page = pager;
            // An open `/`/`:` prompt eats raw characters, not their bindings.
            if (ask) {
              if (unit === '\r' || unit === '\n') submitAsk(page);
              else if (unit === '\x1b') ask = undefined;
              else if (unit === '\x7f' || unit === '\b') ask.text = ask.text.slice(0, -1);
              else if (unit && unit.length === 1 && unit >= ' ' && unit !== '\x7f')
                ask.text += unit;
              continue;
            }
            const jump = Math.max(3, term().rows - 3);
            switch (key) {
              case 'esc':
                // q/esc back out one level — which from a deep-linked root
                // preview is leaving the session.
                if (page.root) break loop;
                pager = undefined;
                break;
              case 'back':
                pager = undefined;
                break;
              case 'down':
              case 'enter':
                page.offset += 1;
                break;
              case 'up':
                page.offset -= 1;
                break;
              case 'pgdn':
                page.offset += jump;
                break;
              case 'pgup':
                page.offset -= jump;
                break;
              case 'halfdn':
                page.offset += Math.ceil(jump / 2);
                break;
              case 'halfup':
                page.offset -= Math.ceil(jump / 2);
                break;
              case 'top':
                page.offset = 0;
                break;
              case 'bottom':
                // Wrapping can make more rows than lines; the draw clamp finds the end.
                page.offset = Infinity;
                break;
              case 'search':
                ask = { kind: '/', text: '' };
                break;
              case 'goto':
                ask = { kind: ':', text: '' };
                break;
              case 'next':
                findNext(page, 1);
                break;
              case 'prev':
                findNext(page, -1);
                break;
            }
            continue;
          }
          if (filesMode) {
            // A click selects its row; a click on the selected row opens it.
            if (mouse?.row !== undefined) {
              const at = clickAt(mouse.row, fileOffset, fileList.length);
              if (at < 0) continue;
              if (at !== fileCursor) {
                fileCursor = at;
                continue;
              }
              key = 'enter';
            }
            const ent = fileList[fileCursor];
            const jump = listRows();
            switch (key) {
              case 'mode':
                // Files-only sessions have no modules view to switch to.
                if (!filesOnly) filesMode = false;
                break;
              // q/esc mirror a filesystem "up": climb a directory, leave the
              // repo side for the package side, and exit from the home root.
              // Back (h) only climbs — at a root it is a no-op.
              case 'esc':
                if (fileRel) fileUp();
                else if (repoMode) swapSides();
                else break loop;
                break;
              case 'repo':
                // Jump to the package's github repository (fetched once per
                // session) and back: repos carry what npm tarballs strip.
                if (repoMode) {
                  swapSides();
                } else if (ghRepo) {
                  if (!repo) {
                    render([paint(`fetching gh:${ghRepo}…`, color.dim, colorOn)]);
                    try {
                      const got = await registryContext(tmp, parseRegistryRef(`gh:${ghRepo}`));
                      repo = { dir: got.pkgDir, label: displayLabel(got.label) };
                    } catch {
                      // Stay put: rate limits and vanished repos must not kill
                      // the session.
                      break;
                    }
                  }
                  swapSides();
                }
                break;
              case 'back':
                // ← keeps climbing past the files root into the launcher when
                // one opened this session; plain sessions stay put, as ever.
                if (fileRel) fileUp();
                else if (menu && !repoMode) {
                  toLauncher = true;
                  backChain = pending.splice(0);
                  break loop;
                }
                break;
              case 'up':
                fileCursor = Math.max(0, fileCursor - 1);
                break;
              case 'down':
                fileCursor = Math.min(fileList.length - 1, fileCursor + 1);
                break;
              case 'pgup':
                fileCursor = Math.max(0, fileCursor - jump);
                break;
              case 'pgdn':
                fileCursor = Math.min(fileList.length - 1, fileCursor + jump);
                break;
              case 'halfup':
                fileCursor = Math.max(0, fileCursor - Math.ceil(jump / 2));
                break;
              case 'halfdn':
                fileCursor = Math.min(fileList.length - 1, fileCursor + Math.ceil(jump / 2));
                break;
              case 'top':
                fileCursor = 0;
                break;
              case 'bottom':
                fileCursor = Math.max(0, fileList.length - 1);
                break;
              case 'enter':
                // Directories open, `..` climbs, files preview — nothing bundles here.
                if (!ent) break;
                if (ent.name === '..') fileUp();
                else if (ent.dir) fileDown(ent);
                else await openFile(ent);
                break;
            }
            continue;
          }
          // Same click contract as the files view: select first, open on the second.
          if (mouse?.row !== undefined) {
            const at = clickAt(mouse.row, offset, list.length);
            if (at < 0) continue;
            if (at !== cursor) {
              cursor = at;
              continue;
            }
            key = 'enter';
          }
          const entry = list[cursor];
          const page = listRows();
          switch (key) {
            // q/esc mirror a filesystem "up": one level back, out from the root.
            case 'esc':
              if (current) toRoot();
              else break loop;
              break;
            case 'up':
              cursor = Math.max(0, cursor - 1);
              break;
            case 'down':
              cursor = Math.min(list.length - 1, cursor + 1);
              break;
            case 'pgup':
              cursor = Math.max(0, cursor - page);
              break;
            case 'pgdn':
              cursor = Math.min(list.length - 1, cursor + page);
              break;
            case 'halfup':
              cursor = Math.max(0, cursor - Math.ceil(page / 2));
              break;
            case 'halfdn':
              cursor = Math.min(list.length - 1, cursor + Math.ceil(page / 2));
              break;
            case 'top':
              cursor = 0;
              break;
            case 'bottom':
              cursor = Math.max(0, list.length - 1);
              break;
            case 'back':
              if (current) toRoot();
              else if (menu) {
                // Same climb from the modules root: back out to the launcher.
                toLauncher = true;
                backChain = pending.splice(0);
                break loop;
              }
              break;
            case 'enter':
              // Filesystem feel: enter climbs `..`, opens directories (modules) and
              // opens files — exports, the `.` package row, and export-less CJS
              // modules page through their bundled source.
              if (entry?.kind === 'back') toRoot();
              else if (entry?.kind === 'module' && entry.mod?.exports.length) {
                rootCursor = cursor;
                current = entry;
                list = [
                  { kind: 'back', sel: '', text: '..' },
                  ...entry.mod.exports.map((name) => ({
                    kind: 'export' as const,
                    sel: `${entry.sel}/${name}`,
                    text: name,
                  })),
                ];
                cursor = list.length > 1 ? 1 : 0;
                offset = 0;
                autoMeasure(list);
              } else if (entry) await openSource(entry);
              break;
            case 'size':
              if (entry) await measureOne(entry);
              break;
            case 'mode':
              // Toggle back into the files view; its position survives round trips.
              filesMode = true;
              fileList = filesOf(fileRel);
              fileCursor = Math.min(fileCursor, Math.max(0, fileList.length - 1));
              break;
          }
        }
      } finally {
        // Let the in-flight background measure finish before tearing the screen
        // down; its draws are muted by `closed`, and the temp dir must outlive it.
        closed = true;
        queue.length = 0;
        await pump;
        setBigArchivePolicy('ask');
        process.stdout.off('resize', onResize);
        output.write(MOUSE_OFF + ALT_OFF);
        input.off('data', onData);
        input.setRawMode?.(false);
        input.pause();
      }
    } finally {
      rmTempDir(tmp);
    }
    if (!toLauncher) return;
  }
};
