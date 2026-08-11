/**
Recursive package diff (`-d`): resolves two selectors to package trees on disk
(installs and downloads delegate to refs.ts/registries.ts, which own the
caches; tarball extraction, `npm pack`, and the measured-side tarball installs
to fs-modify.ts), walks both trees,
classifies shipped files as added/removed/modified, and renders Myers line
diffs as unified hunks or a stat table. The diffing itself is pure reads.

Output is unified-diff shaped for reading, not patching: `\ No newline at end
of file` markers are not emitted.
@module
 */
import { lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { color, csvRow, paint, progressShow } from './env.ts';
import { extractArchive, npmInstall, npmPack, writePkg } from './fs-modify.ts';
import { bad, err, explicitPath, kb, readPkg, slug } from './public.ts';
import { asRef, explicitRef, installedRef, npmHintUse, parseNpmRef } from './refs.ts';
import { isRegistrySelector, jsHitStats, parseRegistryRef, registryContext } from './registries.ts';

export type DiffStatus = 'added' | 'modified' | 'removed';
export type DiffEntry = { aBytes: number; bBytes: number; path: string; status: DiffStatus };
// aTotal/bTotal are whole-tree shipped bytes, unchanged files included, so the
// footer can say what each side weighs — not just the delta.
export type TreeDiff = { aTotal: number; bTotal: number; entries: DiffEntry[]; same: number };
export type DiffSide = {
  archiveBytes?: number;
  // Pinned npm/jsr refs keep their measurement cache beside the install.
  cacheDir?: string;
  dir: string;
  label: string;
  localDir?: boolean;
  // The `/path` tail of a ref selector: bundle modes measure/build that
  // module or export; tree modes compare just that shipped file or subtree.
  sel?: string;
  // The archive an extracted side came from; measuredSide installs from it.
  tarball?: string;
};

// `.tgz`/`.tar.gz` always means a tarball on disk, even bare — no package name
// ends that way, and `npm pack` output is what people hold in their hands.
const TGZ = /\.(?:tgz|tar\.gz)$/i;
// npm tarballs (registry downloads, `npm pack` output) wrap the package in a
// single root directory — usually `package/`, but the name is not guaranteed.
const extractedTgz = (outDir: string, file: string, label: string): DiffSide => {
  const bytes = readFileSync(file);
  const dir = join(outDir, `tgz-${slug(label)}`);
  extractArchive(bytes, dir);
  const entries = readdirSync(dir, { withFileTypes: true });
  const root = entries.length === 1 && entries[0].isDirectory() ? join(dir, entries[0].name) : dir;
  return { archiveBytes: bytes.length, dir: root, label, tarball: file };
};

// Resolve one diff selector to a directory: registry refs fetch + extract,
// npm/jsr refs install, tarballs extract, explicit paths mean the disk. Bare
// names never imply npm, same as everywhere else in the selector grammar.
// A `/path` tail on a ref scopes the diff. `bundle` marks the measured modes
// (-db/-dbm/-dbs), where the tail selects a module/export to build; in tree
// modes it names a shipped file or subtree (`-ds npm:qr@0.5/dom.js`).
export const diffTarget = async (
  outDir: string,
  raw: string,
  cwd: string,
  bundle = false
): Promise<DiffSide> => {
  if (isRegistrySelector(raw)) {
    const got = await registryContext(outDir, parseRegistryRef(raw));
    return { archiveBytes: got.archiveBytes, dir: got.pkgDir, label: got.label };
  }
  if (TGZ.test(raw)) {
    const file = resolve(cwd, raw);
    if (!statSync(file, { throwIfNoEntry: false })?.isFile()) err(`missing tarball: ${bad(raw)}`);
    return extractedTgz(outDir, file, raw);
  }
  if (raw === '.' || explicitPath(raw)) {
    const dir = resolve(cwd, raw);
    if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory())
      err(`missing diff directory: ${bad(raw)}`);
    return { dir, label: raw, localDir: true };
  }
  if (explicitRef(raw)) {
    const ref = parseNpmRef(asRef(raw));
    // Tree modes only walk files, so packages with no JS entry (binary
    // packages: os/cpu fields, no exports/main) stay diffable; bundle modes
    // keep the strict read — they are about to resolve that entry.
    const got = installedRef(outDir, ref, !bundle);
    // Packed-tarball garnish for the footer: one cached metadata + HEAD
    // round-trip per pinned version, quiet on any failure — never an error.
    const archiveBytes = await jsHitStats(ref.jsr ? 'jsr:' : 'npm:', {
      desc: '',
      name: ref.bare,
      version: got.pkg.version ?? '',
    })
      .then((stats) => stats?.tgzBytes)
      .catch(() => undefined);
    return {
      archiveBytes,
      cacheDir: got.refDir,
      dir: got.pkgDir,
      // The selection rides in the label too, so headers and the no-change
      // message name what was actually built.
      label: ref.path ? `${got.label}/${ref.path}` : got.label,
      sel: ref.path || undefined,
    };
  }
  const use = npmHintUse(raw);
  return err(`--diff expects package refs or directories, not ${bad(raw)}${use ? `; ${use}` : ''}`);
};

// A local directory diffed against a shipped package would drown the compare in
// files npm never publishes — tests, sources, CI config. When exactly one side
// is a local directory with a manifest, pack it the way `npm publish` selects
// files (`npm pack`, scripts ignored) and diff the packed tree instead; the
// tarball also gives that side its packed footer bytes. Dir-vs-dir compares
// stay whole-tree: there both sides mean "what's on disk".
const packable = (side: DiffSide): boolean =>
  !!side.localDir &&
  !!statSync(join(side.dir, 'package.json'), { throwIfNoEntry: false })?.isFile();
// Standalone shipped-size listings always mean the publishable package tree.
// Diff keeps its historical dir-vs-dir behavior below and only packs the local
// side when it faces an already-shipped package.
export const packLocalSide = (outDir: string, side: DiffSide): DiffSide => {
  if (!packable(side)) return side;
  const label = `${side.label} (npm pack)`;
  return extractedTgz(outDir, npmPack(side.dir, join(outDir, `pack-${slug(side.label)}`)), label);
};
export const packLocalSides = (outDir: string, a: DiffSide, b: DiffSide): [DiffSide, DiffSide] => {
  if (packable(a) === packable(b)) return [a, b];
  return [packLocalSide(outDir, a), packLocalSide(outDir, b)];
};

// Measured diff sides (-db/-dbm/-dbs) bundle each side's code, so every side
// must resolve its declared dependencies: a bare tarball extract has no
// node_modules, esbuild then reports the deps unresolvable, and the measuring
// engine's external fallback would silently exclude their bytes from that side
// only — asymmetric against a ref side, which installs. Refs stay as installed
// (cacheDir marks them); local dirs measure in place, where their own
// node_modules answers, same as `bismar -bs` run inside them; tarball extracts
// install their archive into the run dir first (fs-modify owns the mutation).
export const measuredSide = (outDir: string, side: DiffSide): DiffSide => {
  if (side.cacheDir || !side.tarball) return side;
  // A tarball without a manifest declares no deps; its extract measures as-is.
  if (!statSync(join(side.dir, 'package.json'), { throwIfNoEntry: false })?.isFile()) return side;
  const name = readPkg(join(side.dir, 'package.json')).name;
  progressShow(`installing ${side.label}`);
  const dir = join(outDir, `install-${slug(side.label)}`);
  writePkg(
    join(dir, 'package.json'),
    `${JSON.stringify({ dependencies: { [name]: `file:${side.tarball}` }, private: true }, null, 2)}\n`
  );
  npmInstall(dir);
  return { ...side, dir: join(dir, 'node_modules', name) };
};

// Shipped files only, like the navigator's files view: dev-only trees are
// skipped, and symlinks are skipped whole (registry archives extract through
// the system tar and can ship links aimed anywhere).
const SKIP = new Set(['.git', 'node_modules']);
const walk = (root: string, rel: string, out: Map<string, number>): void => {
  for (const ent of readdirSync(join(root, rel), { withFileTypes: true })) {
    if (SKIP.has(ent.name)) continue;
    const sub = rel ? `${rel}/${ent.name}` : ent.name;
    if (ent.isDirectory()) walk(root, sub, out);
    else if (ent.isFile())
      out.set(sub, lstatSync(join(root, sub), { throwIfNoEntry: false })?.size ?? 0);
  }
};
// One walk, shared with the import-surface lister (surface.ts): rel path → bytes.
export const walkFiles = (root: string): Map<string, number> => {
  const out = new Map<string, number>();
  walk(root, '', out);
  return out;
};
// A `/path` ref tail scopes a side's walk: the exact shipped file, or a
// directory's whole subtree. Filtering the maps (not the merged entries)
// keeps the footer totals honest — they weigh the scope, not the package.
const scoped = (files: Map<string, number>, sel?: string): Map<string, number> => {
  if (!sel) return files;
  const dir = `${sel.replace(/\/+$/, '')}/`;
  const out = new Map<string, number>();
  for (const [path, bytes] of files) if (path === sel || path.startsWith(dir)) out.set(path, bytes);
  return out;
};
export const diffTrees = (aDir: string, bDir: string, aSel?: string, bSel?: string): TreeDiff => {
  const a = scoped(walkFiles(aDir), aSel);
  const b = scoped(walkFiles(bDir), bSel);
  const entries: DiffEntry[] = [];
  let same = 0;
  for (const [path, aBytes] of a) {
    const bBytes = b.get(path);
    if (bBytes === undefined) entries.push({ aBytes, bBytes: 0, path, status: 'removed' });
    // Equal sizes still need a content compare; package files are small enough
    // to read whole.
    else if (
      aBytes !== bBytes ||
      !readFileSync(join(aDir, path)).equals(readFileSync(join(bDir, path)))
    )
      entries.push({ aBytes, bBytes, path, status: 'modified' });
    else same++;
  }
  for (const [path, bBytes] of b)
    if (!a.has(path)) entries.push({ aBytes: 0, bBytes, path, status: 'added' });
  const sum = (sizes: Map<string, number>): number =>
    [...sizes.values()].reduce((total, bytes) => total + bytes, 0);
  return {
    aTotal: sum(a),
    bTotal: sum(b),
    entries: entries.sort((x, y) => x.path.localeCompare(y.path)),
    same,
  };
};

export type DiffOp = { kind: '+' | '-' | ' '; text: string };
const asOps = (lines: string[], kind: DiffOp['kind']): DiffOp[] =>
  lines.map((text) => ({ kind, text }));
// Myers O(ND) over lines. Edit scripts past MAX_D fall back to whole-block
// replacement — still a valid diff, just not minimal — so pathological pairs
// (two unrelated minified bundles) stay fast and small in memory.
const MAX_D = 2000;
const myers = (a: string[], b: string[]): DiffOp[] => {
  const n = a.length;
  const m = b.length;
  if (!n || !m) return [...asOps(a, '-'), ...asOps(b, '+')];
  // Per-depth snapshots of the furthest-x frontier: k ∈ {-d, -d+2, …, d} lives
  // at index (k+d)/2, so memory is O(D²), not O((N+M)·D).
  const trace: number[][] = [];
  let prev: number[] = [];
  let found = -1;
  for (let d = 0; d <= Math.min(n + m, MAX_D) && found < 0; d++) {
    const v: number[] = [];
    for (let k = -d; k <= d; k += 2) {
      const i = (k + d) / 2;
      const down = k === -d || (k !== d && prev[i - 1] < prev[i]);
      let x = d === 0 ? 0 : down ? prev[i] : prev[i - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v.push(x);
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
    trace.push(v);
    prev = v;
  }
  if (found < 0) return [...asOps(a, '-'), ...asOps(b, '+')];
  const ops: DiffOp[] = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const k = x - y;
    const pv = trace[d - 1];
    const j = (k + d) / 2;
    const down = k === -d || (k !== d && pv[j - 1] < pv[j]);
    const prevK = down ? k + 1 : k - 1;
    const prevX = pv[(prevK + d - 1) / 2];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ kind: ' ', text: a[x - 1] });
      x--;
      y--;
    }
    if (down) ops.push({ kind: '+', text: b[--y] });
    else ops.push({ kind: '-', text: a[--x] });
  }
  while (x > 0 && y > 0) {
    ops.push({ kind: ' ', text: a[x - 1] });
    x--;
    y--;
  }
  return ops.reverse();
};
// A trailing newline separates lines instead of opening an empty last one.
const toLines = (text: string): string[] =>
  text === '' ? [] : (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n');
export const diffLines = (aText: string, bText: string): DiffOp[] => {
  const a = toLines(aText);
  const b = toLines(bText);
  // Trim the common prefix and suffix before Myers: real edits are local, and
  // the trim keeps D proportional to the change, not the file.
  let lo = 0;
  while (lo < a.length && lo < b.length && a[lo] === b[lo]) lo++;
  let aHi = a.length;
  let bHi = b.length;
  while (aHi > lo && bHi > lo && a[aHi - 1] === b[bHi - 1]) {
    aHi--;
    bHi--;
  }
  return [
    ...asOps(a.slice(0, lo), ' '),
    ...myers(a.slice(lo, aHi), b.slice(lo, bHi)),
    ...asOps(a.slice(aHi), ' '),
  ];
};

export type Hunk = { aLen: number; aStart: number; bLen: number; bStart: number; ops: DiffOp[] };
export const hunksOf = (ops: DiffOp[], context = 3): Hunk[] => {
  // Keep every change plus `context` lines around it; overlapping keep ranges
  // merge nearby changes into one hunk on their own.
  const keep = new Array<boolean>(ops.length).fill(false);
  for (const [i, op] of ops.entries())
    if (op.kind !== ' ')
      for (let j = Math.max(0, i - context); j <= Math.min(ops.length - 1, i + context); j++)
        keep[j] = true;
  const hunks: Hunk[] = [];
  let aLine = 0;
  let bLine = 0;
  let cur: Hunk | undefined;
  for (const [i, op] of ops.entries()) {
    if (keep[i]) {
      if (!cur) {
        cur = { aLen: 0, aStart: aLine + 1, bLen: 0, bStart: bLine + 1, ops: [] };
        hunks.push(cur);
      }
      cur.ops.push(op);
      if (op.kind !== '+') cur.aLen++;
      if (op.kind !== '-') cur.bLen++;
    } else cur = undefined;
    if (op.kind !== '+') aLine++;
    if (op.kind !== '-') bLine++;
  }
  return hunks;
};

// An empty side reports the line before the hunk, like git's `-0,0`.
const hunkHeader = (hunk: Hunk): string =>
  `@@ -${hunk.aLen ? hunk.aStart : hunk.aStart - 1},${hunk.aLen} +${
    hunk.bLen ? hunk.bStart : hunk.bStart - 1
  },${hunk.bLen} @@`;
const opLine = (op: DiffOp, on: boolean): string =>
  op.kind === '+'
    ? paint(`+${op.text}`, color.green, on)
    : op.kind === '-'
      ? paint(`-${op.text}`, color.red, on)
      : ` ${op.text}`;
const textHunks = (aText: string, bText: string, on: boolean): string[] => {
  const lines: string[] = [];
  for (const hunk of hunksOf(diffLines(aText, bText))) {
    lines.push(paint(hunkHeader(hunk), color.cyan, on));
    for (const op of hunk.ops) lines.push(opLine(op, on));
  }
  return lines;
};
// Unified diff for two in-memory artifacts (`-db`): unlike a tree diff there is
// one named text on each side, so only the standard file headers and hunks apply.
export const renderTextUnified = (
  aText: string,
  bText: string,
  aLabel: string,
  bLabel: string,
  on: boolean
): string[] => [
  paint(`--- ${aLabel}`, color.bold, on),
  paint(`+++ ${bLabel}`, color.bold, on),
  ...textHunks(aText, bText, on),
];
const looksBinary = (buf: Uint8Array): boolean => buf.subarray(0, 8192).includes(0);
// Small modified binaries diff as xxd-style rows through the ordinary line
// machinery. The cap keeps the pathological case unreachable: in a large
// executable a single inserted byte shifts every later row, so the "diff"
// degenerates into two complete dumps that the Myers walk then chews on.
const HEX_DIFF_MAX = 65536;
const HEX_ROW = 16;
// No offset column: printed offsets would mark even re-aligned rows as
// changed. Hunk headers carry row numbers; byte offset ≈ (row − 1) × 16.
const hexdump = (buf: Uint8Array): string => {
  let out = '';
  for (let off = 0; off < buf.length; off += HEX_ROW) {
    const row = buf.subarray(off, off + HEX_ROW);
    let hex = '';
    let ascii = '';
    for (const byte of row) {
      hex += `${byte.toString(16).padStart(2, '0')} `;
      ascii += byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : '.';
    }
    out += `${hex.padEnd(HEX_ROW * 3)} |${ascii}|\n`;
  }
  return out;
};
// Binaries above the cap get numbers instead of a dump: one pass over bytes
// already in memory, counting equal-at-equal-offset bytes and the first
// mismatch. The percentage reads as ~0 for shifted content — honest, if blunt.
// Rendered as its own line under the "Binary files … differ" header.
const binarySummary = (aBuf: Uint8Array, bBuf: Uint8Array): string => {
  const n = Math.min(aBuf.length, bBuf.length);
  let equal = 0;
  let first = -1;
  for (let i = 0; i < n; i++) {
    if (aBuf[i] === bBuf[i]) equal++;
    else if (first < 0) first = i;
  }
  // Equal prefix: the shorter side ends where the sizes diverge.
  if (first < 0) first = n;
  const total = Math.max(aBuf.length, bBuf.length);
  const pct = total ? Math.floor((equal / total) * 100) : 0;
  return `first change at byte ${first}, ${pct}% of bytes match`;
};
export const fileDiffLines = (
  aDir: string,
  bDir: string,
  entry: DiffEntry,
  on: boolean
): string[] => {
  const p = entry.path;
  const lines = [paint(`diff --bismar a/${p} b/${p}`, color.bold, on)];
  const aBuf = entry.status === 'added' ? Buffer.alloc(0) : readFileSync(join(aDir, p));
  const bBuf = entry.status === 'removed' ? Buffer.alloc(0) : readFileSync(join(bDir, p));
  if (looksBinary(aBuf) || looksBinary(bBuf)) {
    // Modified only: hexdumping a whole added/removed file against /dev/null
    // is noise, and its summary would always read "byte 0, 0% match".
    if (entry.status === 'modified' && aBuf.length <= HEX_DIFF_MAX && bBuf.length <= HEX_DIFF_MAX) {
      lines.push(paint(`--- a/${p}`, color.bold, on), paint(`+++ b/${p}`, color.bold, on));
      lines.push(...textHunks(hexdump(aBuf), hexdump(bBuf), on));
      return lines;
    }
    lines.push(
      `Binary files a/${p} and b/${p} differ (${kb(entry.aBytes)} → ${kb(entry.bBytes)}kb)`
    );
    // Its own line: appended to the header it pushes past every terminal width.
    if (entry.status === 'modified') lines.push(binarySummary(aBuf, bBuf));
    return lines;
  }
  lines.push(
    paint(`--- ${entry.status === 'added' ? '/dev/null' : `a/${p}`}`, color.bold, on),
    paint(`+++ ${entry.status === 'removed' ? '/dev/null' : `b/${p}`}`, color.bold, on)
  );
  lines.push(...textHunks(aBuf.toString('utf8'), bBuf.toString('utf8'), on));
  return lines;
};
export const renderUnified = (aDir: string, bDir: string, tree: TreeDiff, on: boolean): string[] =>
  tree.entries.flatMap((entry) => fileDiffLines(aDir, bDir, entry, on));

const MARK: Record<DiffStatus, string> = { added: 'A', modified: 'M', removed: 'D' };
const MARK_COLOR: Record<DiffStatus, string> = {
  added: color.green,
  modified: color.yellow,
  removed: color.red,
};
const deltaOf = (entry: DiffEntry): number => entry.bBytes - entry.aBytes;
const fmtDelta = (bytes: number): string => `${bytes < 0 ? '-' : '+'}${kb(Math.abs(bytes))}kb`;
const fmtPct = (aBytes: number, bBytes: number): string => {
  const pct = (Math.abs(bBytes - aBytes) / aBytes) * 100;
  if (pct < 0.5) return '~0%';
  return `${bBytes < aBytes ? '-' : '+'}${Math.round(pct)}%`;
};
const fmtPair = (aBytes: number, bBytes: number): string =>
  // The shared unit rides the pair's last number, and the parenthesized delta
  // is relative: `5.41 → 5.28kb (-2%)`. Rounded; below half a percent reads
  // `~0%` rather than a flat 0 that would claim nothing changed. An empty a
  // side has no meaningful ratio — those keep the byte delta.
  aBytes
    ? `${kb(aBytes)} → ${kb(bBytes)}kb (${fmtPct(aBytes, bBytes)})`
    : `${kb(aBytes)} → ${kb(bBytes)}kb (${fmtDelta(bBytes - aBytes)})`;
// The row's size tail, shared by the stat table and the interactive listing.
export const statTail = (entry: DiffEntry): string =>
  entry.status === 'modified' ? fmtPair(entry.aBytes, entry.bBytes) : fmtDelta(deltaOf(entry));
// The footer, two lines: change counts, then sizes — whole-tree unpacked bytes
// on each side plus, when both sides came off a registry, the packed archive
// sizes. Local directories have no archive, so the packed tail stays off for
// them. The interactive header puts counts on its title row, sizes on the next.
export const statSummary = (tree: TreeDiff, a?: DiffSide, b?: DiffSide): string[] => {
  const count = (status: DiffStatus): number =>
    tree.entries.filter((entry) => entry.status === status).length;
  const packed =
    a?.archiveBytes && b?.archiveBytes
      ? ` · ${fmtPair(a.archiveBytes, b.archiveBytes)} packed`
      : '';
  return [
    `${tree.entries.length} files changed: ${count('added')} added, ${count('removed')} removed, ` +
      `${count('modified')} modified · ${tree.same} unchanged`,
    `${fmtPair(tree.aTotal, tree.bTotal)} unpacked${packed}`,
  ];
};
const markOf = (entry: DiffEntry, on: boolean): string =>
  paint(MARK[entry.status], MARK_COLOR[entry.status], on);
// Scoped diffs (`/path` ref tails) drop the footer: over a handful of picked
// files its counts and totals just restate the rows.
export const statHuman = (tree: TreeDiff, on: boolean, a?: DiffSide, b?: DiffSide): string[] => [
  ...tree.entries.map(
    (entry) => `${markOf(entry, on)} ${entry.path}` + paint(`  ${statTail(entry)}`, color.dim, on)
  ),
  ...(a?.sel || b?.sel
    ? []
    : ['', ...statSummary(tree, a, b).map((line) => paint(line, color.dim, on))]),
];
// `-dl`: just the changed files, name-status style — no sizes, no content.
export const statNames = (tree: TreeDiff, on: boolean): string[] =>
  tree.entries.map((entry) => `${markOf(entry, on)} ${entry.path}`);
// Headerless machine rows: status, path, a bytes, b bytes, signed delta.
export const statCsv = (tree: TreeDiff): string[] =>
  tree.entries.map((entry) => {
    const delta = deltaOf(entry);
    return csvRow([
      MARK[entry.status],
      entry.path,
      `${entry.aBytes}b`,
      `${entry.bBytes}b`,
      `${delta < 0 ? '' : '+'}${delta}b`,
    ]);
  });

// Bundle measurement diffs are keyed by the public identity a consumer selects,
// independent of where either package was installed for this run. The metric
// picks the one number a run reports: `-dbms` compares min+gzip — what a
// consumer actually ships — while `-dbs` compares the plain bundle's bytes,
// the unminified code itself. "Changed" depends on the metric too: two sides
// may gzip identically while their plain bundles differ.
export type BundleMetric = 'gzBytes' | 'plainBytes';
export type BundleRow = {
  export: string;
  gzBytes: number;
  module: string;
  plainBytes: number;
};
export type BundleStatEntry = {
  a?: BundleRow;
  b?: BundleRow;
  export: string;
  module: string;
  status: DiffStatus;
};
export type BundleStat = { entries: BundleStatEntry[]; metric: BundleMetric; same: number };
const bundleKey = (row: BundleRow): string => JSON.stringify([row.module, row.export]);
export const diffBundleRows = (
  aRows: BundleRow[],
  bRows: BundleRow[],
  metric: BundleMetric = 'gzBytes'
): BundleStat => {
  const a = new Map(aRows.map((row) => [bundleKey(row), row]));
  const b = new Map(bRows.map((row) => [bundleKey(row), row]));
  const entries: BundleStatEntry[] = [];
  let same = 0;
  for (const [key, left] of a) {
    const right = b.get(key);
    if (!right)
      entries.push({ a: left, export: left.export, module: left.module, status: 'removed' });
    else if (left[metric] !== right[metric])
      entries.push({
        a: left,
        b: right,
        export: left.export,
        module: left.module,
        status: 'modified',
      });
    else same++;
  }
  for (const [key, right] of b)
    if (!a.has(key))
      entries.push({ b: right, export: right.export, module: right.module, status: 'added' });
  entries.sort((x, y) => x.module.localeCompare(y.module) || x.export.localeCompare(y.export));
  return { entries, metric, same };
};

const bundleLabel = (entry: BundleStatEntry): string =>
  entry.export && entry.export !== 'all' ? `${entry.module}/${entry.export}` : entry.module;
const bundleDelta = (entry: BundleStatEntry, metric: BundleMetric): number =>
  (entry.b?.[metric] ?? 0) - (entry.a?.[metric] ?? 0);
// statTail's exact spelling, metric-flavored: modified rows show the a → b
// pair with the parenthesized delta, single-sided rows sign their whole size.
// Only the -m metric earns a suffix: "gzip" marks the number as min+gzip,
// while unminified sizes read like -ds rows and need no tag.
const bundleTail = (entry: BundleStatEntry, metric: BundleMetric): string =>
  `${
    entry.status === 'modified'
      ? fmtPair(entry.a![metric], entry.b![metric])
      : fmtDelta(bundleDelta(entry, metric))
  }${metric === 'gzBytes' ? ' gzip' : ''}`;
// Same dress as -ds stat rows: A/M/D marks in the same colors, dim size tail.
export const bundleStatHuman = (stat: BundleStat, on: boolean): string[] => {
  const count = (status: DiffStatus): number =>
    stat.entries.filter((entry) => entry.status === status).length;
  return [
    ...stat.entries.map(
      (entry) =>
        `${paint(MARK[entry.status], MARK_COLOR[entry.status], on)} ${bundleLabel(entry)}` +
        paint(`  ${bundleTail(entry, stat.metric)}`, color.dim, on)
    ),
    '',
    paint(
      `${stat.entries.length} exports changed: ${count('added')} added, ` +
        `${count('removed')} removed, ${count('modified')} modified · ${stat.same} unchanged`,
      color.dim,
      on
    ),
  ];
};
// Headerless machine rows, statCsv's shape: status, id, a bytes, b bytes,
// signed delta — all in the stat's metric (min+gzip under -m, plain without).
export const bundleStatCsv = (stat: BundleStat): string[] =>
  stat.entries.map((entry) => {
    const delta = bundleDelta(entry, stat.metric);
    return csvRow([
      MARK[entry.status],
      entry.module,
      entry.export,
      `${entry.a?.[stat.metric] ?? 0}b`,
      `${entry.b?.[stat.metric] ?? 0}b`,
      `${delta < 0 ? '' : '+'}${delta}b`,
    ]);
  });
