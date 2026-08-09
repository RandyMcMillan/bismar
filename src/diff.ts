/**
Recursive package diff (`-d`): resolves two selectors to package trees on disk
(installs and downloads delegate to refs.ts/registries.ts, which own the
caches), walks both trees, classifies shipped files as added/removed/modified,
and renders Myers line diffs as unified hunks or a stat table. The diffing
itself is pure reads; nothing here writes.

Output is unified-diff shaped for reading, not patching: `\ No newline at end
of file` markers are not emitted.
@module
 */
import { lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { color, csvRow, paint } from './env.ts';
import { bad, err, explicitPath, kb } from './public.ts';
import { asRef, explicitRef, installedRef, npmHintUse, parseNpmRef } from './refs.ts';
import { isRegistrySelector, jsHitStats, parseRegistryRef, registryContext } from './registries.ts';

export type DiffStatus = 'added' | 'modified' | 'removed';
export type DiffEntry = { aBytes: number; bBytes: number; path: string; status: DiffStatus };
// aTotal/bTotal are whole-tree shipped bytes, unchanged files included, so the
// footer can say what each side weighs — not just the delta.
export type TreeDiff = { aTotal: number; bTotal: number; entries: DiffEntry[]; same: number };
export type DiffSide = { archiveBytes?: number; dir: string; label: string };

// Resolve one diff selector to a directory: registry refs fetch + extract,
// npm/jsr refs install, explicit paths mean the disk. Bare names never imply
// npm, same as everywhere else in the selector grammar.
export const diffTarget = async (outDir: string, raw: string, cwd: string): Promise<DiffSide> => {
  if (isRegistrySelector(raw)) {
    const got = await registryContext(outDir, parseRegistryRef(raw));
    return { archiveBytes: got.archiveBytes, dir: got.pkgDir, label: got.label };
  }
  if (raw === '.' || explicitPath(raw)) {
    const dir = resolve(cwd, raw);
    if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory())
      err(`missing diff directory: ${bad(raw)}`);
    return { dir, label: raw };
  }
  if (explicitRef(raw)) {
    const ref = parseNpmRef(asRef(raw));
    if (ref.path) err(`--diff compares whole packages; drop /${ref.path} from ${bad(raw)}`);
    const got = installedRef(outDir, ref);
    // Packed-tarball garnish for the footer: one cached metadata + HEAD
    // round-trip per pinned version, quiet on any failure — never an error.
    const archiveBytes = await jsHitStats(ref.jsr ? 'jsr:' : 'npm:', {
      desc: '',
      name: ref.bare,
      version: got.pkg.version ?? '',
    })
      .then((stats) => stats?.tgzBytes)
      .catch(() => undefined);
    return { archiveBytes, dir: got.pkgDir, label: got.label };
  }
  const use = npmHintUse(raw);
  return err(`--diff expects package refs or directories, not ${bad(raw)}${use ? `; ${use}` : ''}`);
};

// The two accepted argument shapes, normalized to two selectors: `-d <a> <b>`
// diffs two packages, `-d <pkg> <v1> <v2>` diffs two versions of one package.
// There is deliberately no `pkg@v1..v2` range grammar — versions are plain
// arguments, never parsed out of the selector.
export const diffPair = (paths: string[]): [string, string] => {
  if (paths.length === 2) return [paths[0], paths[1]];
  const [pkg, v1, v2] = paths;
  if (pkg === '.' || explicitPath(pkg))
    err(`directories have no versions: ${bad(pkg)}; pass two directories instead`);
  for (const version of [v1, v2])
    if (explicitPath(version) || version.includes(':'))
      err(`expected a version, not ${bad(version)}; use bismar -d <pkg> <v1> <v2>`);
  // A pinned package plus two more versions contradicts itself; the version
  // grammar of the constructed selectors is checked downstream per ecosystem.
  const pinned = isRegistrySelector(pkg)
    ? parseRegistryRef(pkg).version
    : explicitRef(pkg)
      ? parseNpmRef(asRef(pkg)).version
      : '';
  if (pinned) err(`already pinned: ${bad(pkg)}; drop @${pinned} — the two versions follow`);
  return [`${pkg}@${v1}`, `${pkg}@${v2}`];
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
export const diffTrees = (aDir: string, bDir: string): TreeDiff => {
  const a = walkFiles(aDir);
  const b = walkFiles(bDir);
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
const looksBinary = (buf: Uint8Array): boolean => buf.subarray(0, 8192).includes(0);
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
    lines.push(
      `Binary files a/${p} and b/${p} differ (${kb(entry.aBytes)}kb → ${kb(entry.bBytes)}kb)`
    );
    return lines;
  }
  lines.push(
    paint(`--- ${entry.status === 'added' ? '/dev/null' : `a/${p}`}`, color.bold, on),
    paint(`+++ ${entry.status === 'removed' ? '/dev/null' : `b/${p}`}`, color.bold, on)
  );
  for (const hunk of hunksOf(diffLines(aBuf.toString('utf8'), bBuf.toString('utf8')))) {
    lines.push(paint(hunkHeader(hunk), color.cyan, on));
    for (const op of hunk.ops) lines.push(opLine(op, on));
  }
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
const fmtPair = (aBytes: number, bBytes: number): string =>
  `${kb(aBytes)}kb → ${kb(bBytes)}kb (${fmtDelta(bBytes - aBytes)})`;
// The row's size tail, shared by the stat table and the interactive listing.
export const statTail = (entry: DiffEntry): string =>
  entry.status === 'modified' ? fmtPair(entry.aBytes, entry.bBytes) : fmtDelta(deltaOf(entry));
// The footer, two lines: change counts, then sizes — whole-tree unpacked bytes
// on each side plus, when both sides came off a registry, the packed archive
// sizes. Local directories have no archive, so the packed tail stays off for
// them. The interactive header joins the lines back with · to stay on one row.
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
export const statHuman = (tree: TreeDiff, on: boolean, a?: DiffSide, b?: DiffSide): string[] => [
  ...tree.entries.map(
    (entry) => `${markOf(entry, on)} ${entry.path}` + paint(`  ${statTail(entry)}`, color.dim, on)
  ),
  '',
  ...statSummary(tree, a, b).map((line) => paint(line, color.dim, on)),
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
