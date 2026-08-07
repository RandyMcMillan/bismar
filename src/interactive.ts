/**
Interactive mode (`-i`): ranger-style package navigation. Sessions open in the
files view — shipped files browse like a filesystem and preview as text; `r`
jumps to the github repository the manifest names. `m` switches JS packages to
the modules view (`f` returns), where modules are directories, exports are files, and every
row measures itself in the background (same in-memory engine as --size);
`enter` there bundles and pages through the source. Listings take the mouse too
— click to select, click again to open, wheel to scroll; the pager keeps it
native so text selection works. Draws with plain ANSI on the alternate screen;
nothing is ever written to the filesystem.
@module
 */
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { highlightText } from './vendor/speed-highlight/terminal.js';
import { color, paint, progressOff, stripAnsi, wantColor } from './env.ts';
import { rmTempDir, tempDir } from './fs-modify.ts';
import {
  bad,
  err,
  explicitPath,
  firstModule,
  fmtBytes,
  kb,
  ONLY_EXT,
  paintId,
  readJson,
} from './public.ts';
import { isRegistrySelector, parseRegistryRef, registryContext } from './registries.ts';
import { asRef, isNpmSelector, noPkgErr, npmHintUse, parseNpmRef, saveRefDb } from './refs.ts';
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

const decoder = new TextDecoder();
export type InteractiveIo = {
  cols?: number;
  input?: NodeJS.ReadableStream & { setRawMode?: (on: boolean) => void };
  output?: { write: (text: string) => boolean };
  rows?: number;
};
export type InteractiveOpts = { cwd?: string; io?: InteractiveIo };
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
  title: string;
  // Draw-time wrap memo: logical lines re-wrap only when the width changes;
  // starts[i] is the wrapped-row index where logical line i begins.
  wrap?: { cols: number; rows: string[]; starts: number[] };
};
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
  f: 'files', // modules view: back to the files home view
  m: 'modules', // files view: switch to the modules/size view
  g: 'top',
  h: 'back',
  j: 'down',
  k: 'up',
  l: 'enter',
  n: 'next', // repeat the last pager search…
  N: 'prev', // …and backwards
  q: 'quit',
  r: 'repo', // files view: jump to the package's github repo and back
  s: 'size',
  u: 'halfup', // …and half window back
  w: 'pgup', // less: one window back, like b
};
// CSI (`\x1b[…~`/letter), SGR mouse (`\x1b[<…M`/`m`) and SS3 (`\x1bO…`) sequences
// are consumed whole, mapped or not — an unrecognized PgUp must never fall
// through to bare Esc and quit. Units stay raw (KEYMAP applies at the consumer):
// search input needs the characters themselves, not their bindings.
const KEY_SEQ = /^\x1b(\[<[\d;]*[Mm]|\[[\d;]*[~A-Za-z]|O[A-Za-z])/;
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
// Terminal-safe preview text: a tab renders wider than the one column the width
// math counts, and a stray \r rewinds the cursor into the previous text
// (vscode-jsonrpc ships tab-indented, CRLF-ish files inside typescript).
const displayText = (text: string): string => text.replace(/\t/g, '  ').replace(/\r/g, '');
// repository spellings seen in the wild: "github:u/r", bare "u/r" shorthand,
// "git+https://github.com/u/r.git", "git://github.com/u/r.git",
// {url: "https://github.com/u/r"}, monorepo urls with /tree/... tails.
const GH_REPO = /(?:^github:|github\.com[/:])([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/#].*)?$/;
const ghRepoOf = (pkgFile: string): string => {
  try {
    const raw = readJson<{ repository?: unknown }>(pkgFile).repository;
    const url =
      typeof raw === 'string'
        ? raw
        : raw && typeof raw === 'object' && typeof (raw as { url?: unknown }).url === 'string'
          ? (raw as { url: string }).url
          : '';
    const m = GH_REPO.exec(url);
    if (m) return `${m[1]}/${m[2]}`;
    return /^[\w.-]+\/[\w.-]+$/.test(url) ? url : '';
  } catch {
    // No manifest (registry extracts) or an unparseable one: no repo jump on offer.
    return '';
  }
};
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
const truncAnsi = (line: string, max: number): string => {
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
const wrapAnsi = (line: string, max: number): string[] => {
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
export const runInteractive = async (
  selector: string | undefined,
  opts: InteractiveOpts = {}
): Promise<void> => {
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
    // Navigator-only ecosystems (crates.io, rubygems, pypi, packagist, github,
    // the go proxy): fetch + extract, then browse shipped files. There is no JS
    // to enumerate or weigh, so the modules view, size measurement, and bundling
    // stay off; the session lives in the files view.
    const regSel = selector && isRegistrySelector(selector) ? selector : '';
    const filesOnly = !!regSel;
    if (regSel) {
      const got = await registryContext(tmp, parseRegistryRef(regSel));
      label = got.label;
      pkgRoot = got.pkgDir;
    } else {
      // Same package resolution as browse mode: local by default, an explicit
      // npm/jsr ref or a filesystem path otherwise; deep module paths make no
      // sense for a navigator, so they are refused.
      const build = loadEsbuild().build;
      const baseDir = resolve(opts.cwd ?? process.cwd());
      const sel = selector ?? '';
      const asFile = (raw: string): boolean => isFile(resolve(baseDir, raw));
      // `./`, `../`, and absolute selectors always mean the filesystem; a bare
      // path takes file semantics only when it exists and names no public module.
      if (sel && explicitPath(sel)) {
        if (!asFile(sel)) err(`missing input file: ${bad(sel)}`);
        fileMode = sel;
      }
      if (!fileMode) {
        const hasPkg = existsSync(join(baseDir, 'package.json'));
        const noLocal = !!sel && !hasPkg && isNpmSelector(sel, '');
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
          if (!isNpmSelector(sel, ctx.pkg.name)) {
            if (ONLY_EXT.test(sel) && !localSet.has(firstModule(ctx.pkg.name, sel)) && asFile(sel))
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
            if (ref.path)
              err(`interactive mode expects a bare package; drop /${ref.path} from ${bad(sel)}`);
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
            refSel = got.label;
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
    // `r` target: the github repo advertised by the browsed package's manifest.
    // Registry extracts have no package.json worth trusting; gh: is the repo.
    const ghRepo = filesOnly ? '' : ghRepoOf(join(pkgRoot, 'package.json'));
    const colorOn = wantColor();
    const stats = new Map<string, Cell>();
    const sources = new Map<string, string[]>();
    const rootEntries: IEntry[] = filesOnly
      ? []
      : fileMode
        ? // One file, one module: it is its own package row.
          mods.map((mod) => ({ kind: 'module' as const, mod, sel: fileMode, text: fileBase(mod) }))
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
    // Listing layout, one owner: crumb + blank line above, blank line + hint
    // footer below, entries on screen rows LIST_TOP…LIST_TOP+listRows()−1.
    // Draws, page jumps, and click mapping all derive from these two numbers.
    const LIST_TOP = 3;
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
    // The files people open first — changelogs, licenses, readmes, manifests —
    // lead the file group, right after the directories.
    const FILE_META = /^(changelog|license|readme)|^(jsr|package)\.json$/i;
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
          const st = statSync(path);
          out.push({ dir: st.isDirectory(), name, path, size: st.size });
        } catch {
          // Broken symlink: nothing to preview.
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
        const name = paint(
          ent.dir && ent.name !== '..' ? `${ent.name}/` : ent.name,
          ent.dir ? (ent.name === '..' ? color.dim : color.cyan) : color.green,
          colorOn
        );
        // Directories carry their footprint, files their own size; `..` stays bare.
        const tail =
          ent.dir && ent.name !== '..'
            ? paint(`  ${footTail(footprintOf(ent.path))}`, color.dim, colorOn)
            : ent.dir
              ? ''
              : paint(`  ${kb(ent.size)}kb`, color.dim, colorOn);
        lines.push(`${active ? paint('▸ ', color.bold, colorOn) : '  '}${name}${tail}`);
      }
      const hop = ghRepo ? (repoMode ? ' · r package' : ' · r repo') : '';
      lines.push(
        '',
        paint(
          filesOnly
            ? '↑↓ move · enter preview · ← up · q quit'
            : `↑↓ move · enter preview · ← up${hop} · m modules · q quit`,
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
            ? '↑↓ move · enter source · ← back · f files · q quit'
            : '↑↓ move · enter open · f files · q quit',
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
            ? `${ask.kind}${ask.text}`
            : paint(`${pct}% · ↑↓/space scroll · /search · :goto · q back`, color.dim, colorOn)),
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
          let text = displayText(decoder.decode(built.plain));
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
    type PreviewLang =
      | ''
      | 'go'
      | 'html'
      | 'js'
      | 'json'
      | 'md'
      | 'php'
      | 'rb'
      | 'rs'
      | 'toml'
      | 'ts'
      | 'yaml';
    const LANGS: [RegExp, PreviewLang][] = [
      [/\.[mc]?jsx?$/i, 'js'],
      [/\.[mc]?tsx?$/i, 'ts'],
      [/\.json$/i, 'json'],
      [/\.(md|markdown)$/i, 'md'],
      [/\.html?$/i, 'html'],
      [/\.rb$/i, 'rb'],
      [/\.rs$/i, 'rs'],
      [/\.go$/i, 'go'],
      [/\.php$/i, 'php'],
      [/\.toml$/i, 'toml'],
      [/\.ya?ml$/i, 'yaml'],
    ];
    const langOf = (name: string): PreviewLang => LANGS.find(([re]) => re.test(name))?.[1] ?? '';
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
          text = displayText(text);
          const lang = colorOn ? langOf(ent.name) : '';
          if (lang) text = await highlightText(text, lang).catch(() => text);
        }
        lines = text.split('\n');
        fileViews.set(ent.path, lines);
      }
      pager = { lines, offset: 0, title: fileRel ? `${fileRel}/${ent.name}` : ent.name };
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
    input.setRawMode?.(true);
    input.on('data', onData);
    input.resume();
    // Setup (installs, enumeration) reported through the startup progress line;
    // from here the TUI owns the terminal, so mute it for good.
    progressOff();
    output.write(ALT_ON + MOUSE_ON);
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
        let key = unit ? (mouse ? mouse.key : KEYMAP[unit]) : undefined;
        // Ctrl-C/Ctrl-D close the whole app no matter which view is open.
        if (key === 'exit') break;
        if (pager) {
          const page = pager;
          // An open `/`/`:` prompt eats raw characters, not their bindings.
          if (ask) {
            if (unit === '\r' || unit === '\n') submitAsk(page);
            else if (unit === '\x1b') ask = undefined;
            else if (unit === '\x7f' || unit === '\b') ask.text = ask.text.slice(0, -1);
            else if (unit && unit.length === 1 && unit >= ' ' && unit !== '\x7f') ask.text += unit;
            continue;
          }
          const jump = Math.max(3, term().rows - 3);
          switch (key) {
            case 'quit':
            case 'back':
            case 'esc':
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
            case 'quit':
              break loop;
            case 'modules':
              // Files-only sessions have no modules view to switch to.
              if (!filesOnly) filesMode = false;
              break;
            // Esc mirrors a filesystem "up": climb a directory, leave the repo
            // side for the package side, and exit from the home root. Back (h)
            // only climbs — at a root it is a no-op.
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
                    repo = { dir: got.pkgDir, label: got.label };
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
              if (fileRel) fileUp();
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
          case 'quit':
            break loop;
          // Esc mirrors a filesystem "up": one level back, and out from the root.
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
          case 'files':
            // Toggle into the files view; its position survives round trips.
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
      output.write(MOUSE_OFF + ALT_OFF);
      input.off('data', onData);
      input.setRawMode?.(false);
      input.pause();
    }
  } finally {
    rmTempDir(tmp);
  }
};
