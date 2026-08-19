// The only shipped place allowed to mutate the filesystem or run `npm install`.
// Every mutation happens inside a `bismar-*` OS temp dir, assembled here — mostly via
// symlinks; npm runs only on a cold esbuild cache. bismar never writes into user repos.
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { gunzipSync, inflateRawSync } from 'node:zlib';

// Source/manifest writes, plus the verbatim registry archives kept for `-b`.
const EXTS = ['.cjs', '.js', '.json', '.mjs', '.ts', '.crate', '.gem', '.gz', '.zip', '.whl'];
// Never lifecycle scripts or lockfiles: installs land in throwaway bismar temp dirs.
// Audit and funding checks are extra registry roundtrips with no reader here.
// --force waives npm's os/cpu gate (EBADPLATFORM): these installs only feed
// inspection and measurement, never execution, so a foreign-platform binary
// package — `bismar -d npm:@esbuild/darwin-arm64@0.28.{1,2}` from linux — is
// as diffable as any other.
const NPM_INSTALL_ARGS = [
  'install',
  '--force',
  '--prefer-offline',
  '--ignore-scripts',
  '--no-package-lock',
  '--no-audit',
  '--no-fund',
] as const;
// Kept in sync with the esbuild dependency of bismar.
const RUN_ESBUILD_SPEC = '^0.28.1';

const err = (msg: string): never => {
  throw new Error(msg);
};
const inBismarTmp = (path: string): boolean => {
  if (!isAbsolute(path)) return false;
  const rel = relative(tmpdir(), path);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return false;
  return (rel.split(/[\\/]/)[0] || '').startsWith('bismar-');
};
const tempParts = (path: string): string[] =>
  relative(tmpdir(), path).split(/[\\/]/).filter(Boolean);
// A lexical `/tmp/bismar-*` prefix is not enough on a shared machine: a
// predictable intermediate component could be a link planted before bismar
// starts. Check every existing ancestor without following it. The final path is
// allowed to be a link because safe unlink/replacement and our run-dependency
// links operate on link entries themselves; directory consumers validate it.
const assertTempAncestors = (path: string): void => {
  const parts = tempParts(path);
  let current = tmpdir();
  for (let i = 0; i < parts.length - 1; i++) {
    current = join(current, parts[i]);
    const st = lstatSync(current, { throwIfNoEntry: false });
    if (!st) break;
    if (!st.isDirectory() || st.isSymbolicLink())
      err(`refusing unsafe bismar temp ancestor: ${current}`);
  }
};
export const assertTemp = (path: string, checkExt = false): string => {
  if (!isAbsolute(path)) err(`expected absolute path: ${path}`);
  if (!inBismarTmp(path)) err(`expected bismar temp path: ${path}`);
  assertTempAncestors(path);
  if (checkExt && !EXTS.some((ext) => basename(path).endsWith(ext)))
    err(`refusing unexpected extension: ${path}`);
  return path;
};

// Every directory bismar creates is keeper-private: 0700 keeps other users on
// shared machines out of the persistent caches (bismar-refs, bismar-esbuild-*),
// which would otherwise inherit umask-default modes. The mode caps at 0700 —
// umask can only clear bits further. mkdtemp'd run dirs get 0700 from
// mkdtemp(3) already; this makes the recursive mkdir paths match.
const mkdir = (dir: string): string => {
  // Promotion to a top-level bismar-* cache has the OS temp directory itself
  // as its already-existing parent; it is the trusted anchor, not a cache dir.
  if (!relative(tmpdir(), dir)) return dir;
  assertTemp(dir);
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  let current = tmpdir();
  for (const part of tempParts(dir)) {
    current = join(current, part);
    let st = lstatSync(current, { throwIfNoEntry: false });
    if (!st) {
      try {
        // One component at a time: recursive mkdir would follow a planted
        // intermediate link before we could inspect it.
        mkdirSync(current, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      st = lstatSync(current, { throwIfNoEntry: false });
    }
    if (!st) throw new Error(`missing bismar temp directory after creation: ${current}`);
    if (!st.isDirectory() || st.isSymbolicLink())
      err(`refusing unsafe bismar temp directory: ${current}`);
    if (uid !== undefined && st.uid !== uid)
      err(`refusing bismar temp directory owned by another user: ${current}`);
    // Existing caches from older versions may have inherited a loose umask;
    // close them before descending or creating another component.
    chmodSync(current, 0o700);
  }
  return dir;
};

const privateRoots = new Map<string, string>();
/**
 * Resolve a predictable machine-cache root only when every component is a
 * keeper-private directory owned by this process. If another user pre-created
 * the name (or planted a link), fall back to an unguessable mkdtemp root for
 * this process instead of following or trusting it.
 */
export const privateCacheDir = (name: string, ...children: string[]): string => {
  if (!/^bismar-[a-zA-Z0-9._-]+$/.test(name)) err(`invalid bismar cache name: ${name}`);
  if (children.some((part) => !part || part === '.' || part === '..' || /[\\/]/.test(part)))
    err(`invalid bismar cache child: ${children.join('/')}`);
  const base = tmpdir();
  const key = `${base}\0${name}`;
  let root = privateRoots.get(key);
  if (root) {
    try {
      mkdir(root);
    } catch {
      privateRoots.delete(key);
      root = undefined;
    }
  }
  if (!root) {
    const desired = join(base, name);
    try {
      root = mkdir(desired);
    } catch {
      root = mkdtempSync(join(base, `${name}-safe-`));
      chmodSync(root, 0o700);
    }
    privateRoots.set(key, root);
  }
  return mkdir(join(root, ...children));
};

export type TempKind = 'bundle' | 'check' | 'diff' | 'size' | 'version';
export const tempDir = (kind: TempKind): string => mkdtempSync(join(tmpdir(), `bismar-${kind}-`));
export const rmTempDir = (dir: string): boolean => (
  rmSync(assertTemp(dir), { force: true, recursive: true }),
  true
);

export const write = (file: string, data: string | Uint8Array): string => (
  atomicWrite(assertTemp(file, true), data),
  file
);
// Persistent cache values must never be observable half-written. A private,
// same-directory temporary keeps rename atomic (and on the same filesystem);
// the finally also cleans up failed replacements such as a directory target.
const atomicWrite = (file: string, data: string | Uint8Array): void => {
  const parent = mkdir(dirname(file));
  const temp = join(parent, `.${basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temp, data, { flag: 'wx', mode: 0o600 });
    renameSync(temp, file);
  } finally {
    rmSync(temp, { force: true });
  }
};
// The network-request log (BISMAR_LOG=file.txt): the one user-directed write
// bismar makes outside its own temp dirs — an explicit opt-in, append-only.
// Logging is garnish: a bad path must not break the request it observed.
export const appendLog = (file: string, line: string): void => {
  try {
    appendFileSync(file, line);
  } catch {
    // Unwritable log target; the fetch itself proceeds.
  }
};
export const writePkg = (file: string, data: string | Uint8Array): string => {
  if (basename(file) !== 'package.json') err(`expected package.json path: ${file}`);
  atomicWrite(assertTemp(file), data);
  return file;
};
export const rm = (file: string): boolean => (
  rmSync(assertTemp(file, true), { force: true }),
  true
);

// jsr refs install through npm's registry-scope mechanism: a per-install-dir
// .npmrc routes the @jsr alias scope to jsr's npm-compatible registry. The file
// content is fixed here (env-overridable for offline tests and proxies) and only
// ever lands inside bismar temp dirs.
export const writeJsrNpmrc = (dir: string): string => {
  const registry = process.env.BISMAR_JSR_REGISTRY || 'https://npm.jsr.io';
  const file = join(assertTemp(dir), '.npmrc');
  atomicWrite(file, `@jsr:registry=${registry}\n`);
  return file;
};

// Moves a completed install from a per-run dir into the machine-level cache; both
// ends must be bismar temp paths. Returns false when a concurrent run won the race
// (or the rename failed any other way) — callers then just keep using `from`.
export const promoteTemp = (from: string, to: string): boolean => {
  assertTemp(from);
  assertTemp(to);
  try {
    mkdir(dirname(to));
    renameSync(from, to);
    return true;
  } catch {
    return false;
  }
};

// Hidden `bismar --clear` sweep: removes every bismar-* dir at the tmpdir root —
// ref installs, esbuild caches, and stale run dirs left by crashed runs. Sizes
// come from lstat, so symlinked run deps never count (or reach into) user repos.
export const clearTempCaches = (): { bytes: number; dirs: number } => {
  const root = tmpdir();
  let bytes = 0;
  let dirs = 0;
  const sizeOf = (path: string): number => {
    try {
      const st = lstatSync(path, { throwIfNoEntry: false });
      if (!st) return 0;
      if (st.isDirectory())
        return readdirSync(path).reduce((sum, ent) => sum + sizeOf(join(path, ent)), 0);
      return st.size;
    } catch {
      // A concurrent run may remove entries mid-walk; count what remains.
      return 0;
    }
  };
  for (const ent of readdirSync(root)) {
    if (!ent.startsWith('bismar-')) continue;
    const dir = join(root, ent);
    if (!lstatSync(dir, { throwIfNoEntry: false })?.isDirectory()) continue;
    bytes += sizeOf(dir);
    rmSync(assertTemp(dir), { force: true, recursive: true });
    dirs++;
  }
  return { bytes, dirs };
};

// Archives are attacker-controlled and expand before the normal package walkers
// get a chance to apply their own limits. Keep these caps independent of the
// compressed-download prompt: even an approved small zip/tgz can be a bomb.
const MAX_ARCHIVE_MEMBERS = 65_000;
const MAX_ARCHIVE_PATH_BYTES = 4_096;
const MAX_ARCHIVE_PATH_DEPTH = 100;
const MAX_ARCHIVE_TREE_PATH_BYTES = 32 * 1024 * 1024;
const MAX_ARCHIVE_FILE_BYTES = 256 * 1024 * 1024;
const MAX_ARCHIVE_TOTAL_BYTES = 512 * 1024 * 1024;
const MAX_TAR_STREAM_BYTES = MAX_ARCHIVE_TOTAL_BYTES;
const MAX_TAR_METADATA_BYTES = 1024 * 1024;
const MAX_TAR_METADATA_TOTAL_BYTES = 8 * 1024 * 1024;
const MAX_TAR_PAX_RECORDS = MAX_ARCHIVE_MEMBERS;
const utf8 = new TextDecoder('utf-8', { fatal: true });

const decodeUtf8 = (bytes: Uint8Array, what: string): string => {
  try {
    return utf8.decode(bytes);
  } catch {
    return err(`invalid ${what}: filename is not UTF-8`);
  }
};
const archivePath = (raw: string, kind: 'tar' | 'zip', directory = false): string => {
  let name = raw;
  if (directory && name.endsWith('/')) name = name.slice(0, -1);
  while (name.startsWith('./')) name = name.slice(2);
  if (directory && (name === '' || name === '.')) return '';
  const parts = name.split('/');
  // Apply the stricter Windows namespace rules on every platform, so a cache
  // produced on POSIX can never become dangerous when copied to Windows. NTFS
  // alternate streams use `:`, trailing dots/spaces alias another component,
  // and DOS device names remain reserved even when followed by an extension.
  const windowsUnsafe = parts.some(
    (part) =>
      part.includes(':') ||
      /[. ]$/.test(part) ||
      /^(?:con|prn|aux|nul|conin\$|conout\$|clock\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part)
  );
  if (
    !name ||
    name.includes('\0') ||
    name.includes('\\') ||
    name.startsWith('/') ||
    /^[a-zA-Z]:($|\/)/.test(name) ||
    windowsUnsafe ||
    parts.some((part) => !part || part === '.' || part === '..')
  )
    err(`refusing unsafe ${kind} member path: ${raw}`);
  if (Buffer.byteLength(name) > MAX_ARCHIVE_PATH_BYTES)
    err(`refusing ${kind} member path longer than ${MAX_ARCHIVE_PATH_BYTES} bytes: ${raw}`);
  if (parts.length > MAX_ARCHIVE_PATH_DEPTH)
    err(`refusing ${kind} member path deeper than ${MAX_ARCHIVE_PATH_DEPTH}: ${raw}`);
  return parts.join('/');
};
type ArchiveTreeNode = { explicit: boolean; kind: 'dir' | 'file' };
type ArchiveTree = { nodes: Map<string, ArchiveTreeNode>; pathBytes: number };
// Count the logical tree, not just archive headers. Recursive mkdir would
// otherwise let a few hundred depth-100 members materialize tens of thousands
// of unbudgeted parent directories before the post-extraction walk noticed.
const registerArchiveMember = (
  tree: ArchiveTree,
  name: string,
  directory: boolean,
  kind: 'tar' | 'zip'
): void => {
  const parts = name.split('/');
  let path = '';
  for (let i = 0; i < parts.length; i++) {
    path = path ? `${path}/${parts[i]}` : parts[i];
    const last = i === parts.length - 1;
    const wanted: ArchiveTreeNode['kind'] = last && !directory ? 'file' : 'dir';
    const explicit = last;
    const prior = tree.nodes.get(path);
    if (prior) {
      if (prior.kind !== wanted) err(`refusing ${kind} member path conflict: ${name}`);
      if (explicit && prior.explicit) err(`refusing duplicate ${kind} member: ${name}`);
      if (explicit) prior.explicit = true;
      continue;
    }
    if (tree.nodes.size >= MAX_ARCHIVE_MEMBERS)
      err(`refusing ${kind} tree with more than ${MAX_ARCHIVE_MEMBERS} members`);
    const pathBytes = Buffer.byteLength(path);
    if (tree.pathBytes > MAX_ARCHIVE_TREE_PATH_BYTES - pathBytes)
      err(`refusing ${kind} tree with more than ${MAX_ARCHIVE_TREE_PATH_BYTES} path bytes`);
    tree.pathBytes += pathBytes;
    tree.nodes.set(path, { explicit, kind: wanted });
  }
};
const archiveSize = (size: number, name: string, total: number, kind: 'tar' | 'zip'): number => {
  if (!Number.isSafeInteger(size) || size < 0) err(`invalid ${kind} size for ${name}`);
  if (size > MAX_ARCHIVE_FILE_BYTES)
    err(`refusing ${kind} member larger than ${MAX_ARCHIVE_FILE_BYTES} bytes: ${name}`);
  if (total > MAX_ARCHIVE_TOTAL_BYTES - size)
    err(`refusing ${kind} archive larger than ${MAX_ARCHIVE_TOTAL_BYTES} unpacked bytes`);
  return total + size;
};
const ensureArchiveDir = (path: string): void => {
  const st = lstatSync(path, { throwIfNoEntry: false });
  if (st && !st.isDirectory()) err(`refusing non-directory in extracted archive: ${path}`);
  if (!st) mkdir(path);
};
const validateExtractedTree = (root: string): void => {
  const rootStat = lstatSync(root, { throwIfNoEntry: false });
  if (!rootStat?.isDirectory()) err(`expected archive extraction directory: ${root}`);
  const pending: Array<{ depth: number; path: string }> = [{ depth: 0, path: root }];
  let members = 0;
  let total = 0;
  while (pending.length) {
    const current = pending.pop()!;
    chmodSync(current.path, 0o700);
    for (const ent of readdirSync(current.path)) {
      if (++members > MAX_ARCHIVE_MEMBERS)
        err(`refusing archive with more than ${MAX_ARCHIVE_MEMBERS} members`);
      const path = join(current.path, ent);
      const st = lstatSync(path);
      if (st.isSymbolicLink()) err(`refusing symlink in extracted archive: ${path}`);
      if (st.isDirectory()) {
        if (current.depth + 1 > MAX_ARCHIVE_PATH_DEPTH)
          err(`refusing archive tree deeper than ${MAX_ARCHIVE_PATH_DEPTH}`);
        pending.push({ depth: current.depth + 1, path });
      } else if (st.isFile()) {
        total = archiveSize(st.size, path, total, 'tar');
        chmodSync(path, 0o600);
      } else {
        err(`refusing special file in extracted archive: ${path}`);
      }
    }
  }
};
const prepareArchiveDir = (dir: string): string => {
  mkdir(assertTemp(dir));
  // This also protects nested extraction (a gem's data.tar.gz) from a tree that
  // was swapped or pre-populated with a link before the next layer is opened.
  validateExtractedTree(dir);
  // Budgets are per extraction. Requiring an empty destination prevents a
  // caller from stacking several individually valid 512 MiB/65k-member trees
  // into one result (the gem shell is removed before its data layer starts).
  if (readdirSync(dir).length) err(`refusing non-empty archive extraction directory: ${dir}`);
  return dir;
};

const tarString = (header: Buffer, at: number, length: number, what: string): string => {
  const field = header.subarray(at, at + length);
  const nul = field.indexOf(0);
  return decodeUtf8(nul < 0 ? field : field.subarray(0, nul), what);
};
const tarNumber = (field: Uint8Array, what: string): number => {
  if (field[0] & 0x80) {
    if (field[0] & 0x40) return err(`invalid negative tar ${what}`);
    let value = BigInt(field[0] & 0x7f);
    for (let i = 1; i < field.length; i++) value = (value << 8n) | BigInt(field[i]);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) return err(`tar ${what} is too large`);
    return Number(value);
  }
  const text = Buffer.from(field)
    .toString('ascii')
    .replace(/[\0 ]+$/g, '')
    .trimStart();
  if (!text) return 0;
  if (!/^[0-7]+$/.test(text)) return err(`invalid tar ${what}`);
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value)) return err(`tar ${what} is too large`);
  return value;
};
const paxRecords = (data: Buffer, countRecord: () => void): Map<'path' | 'size', string> => {
  if (data.length > MAX_TAR_METADATA_BYTES) err('refusing oversized tar PAX metadata');
  const records = new Map<'path' | 'size', string>();
  let at = 0;
  while (at < data.length) {
    const space = data.indexOf(0x20, at);
    if (space < 0) err('invalid tar PAX record');
    const lengthText = data.toString('ascii', at, space);
    if (!/^[1-9][0-9]*$/.test(lengthText)) err('invalid tar PAX record length');
    const length = Number(lengthText);
    const end = at + length;
    if (!Number.isSafeInteger(length) || end > data.length || data[end - 1] !== 0x0a)
      err('invalid tar PAX record length');
    const record = data.subarray(space + 1, end - 1);
    const equal = record.indexOf(0x3d);
    if (equal < 1) err('invalid tar PAX record');
    const key = decodeUtf8(record.subarray(0, equal), 'tar PAX key');
    const value = decodeUtf8(record.subarray(equal + 1), 'tar PAX value');
    countRecord();
    if (key.startsWith('GNU.sparse.') || key === 'SCHILY.realsize')
      err('refusing sparse tar member');
    // Only these attributes affect extraction. Ignoring everything else keeps
    // repeated global headers from accumulating attacker-chosen Map entries.
    if (key === 'path' || key === 'size') records.set(key, value);
    at = end;
  }
  return records;
};
const paxSize = (value: string, name: string): number => {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) err(`invalid tar PAX size for ${name}`);
  const size = Number(value);
  if (!Number.isSafeInteger(size)) err(`tar PAX size is too large for ${name}`);
  return size;
};

// Extracts crates, sdists, repository tarballs, and both layers of a .gem.
// Parsing here instead of delegating to platform tar is deliberate: a member is
// validated before any filesystem effect and links/devices never materialize.
export const extractTar = (bytes: Uint8Array, dir: string): void => {
  dir = prepareArchiveDir(dir);
  const input = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let buf = input;
  if (input.length > 2 && input[0] === 0x1f && input[1] === 0x8b) {
    try {
      buf = gunzipSync(input, { maxOutputLength: MAX_TAR_STREAM_BYTES });
    } catch (error) {
      const detail = error instanceof Error ? `: ${error.message}` : '';
      err(`tar decompression failed${detail}`);
    }
  }
  if (buf.length > MAX_TAR_STREAM_BYTES)
    err(`refusing tar stream larger than ${MAX_TAR_STREAM_BYTES} bytes`);
  let at = 0;
  let headers = 0;
  let total = 0;
  let globalPax = new Map<string, string>();
  let nextPax = new Map<string, string>();
  let longName: string | undefined;
  let metadataBytes = 0;
  let paxRecordCount = 0;
  const tree: ArchiveTree = { nodes: new Map(), pathBytes: 0 };
  while (at + 512 <= buf.length) {
    const header = buf.subarray(at, at + 512);
    if (header.every((byte) => byte === 0)) break;
    if (++headers > MAX_ARCHIVE_MEMBERS)
      err(`refusing tar with more than ${MAX_ARCHIVE_MEMBERS} members`);
    const expected = tarNumber(header.subarray(148, 156), 'checksum');
    let checksum = 0;
    for (let i = 0; i < 512; i++) checksum += i >= 148 && i < 156 ? 0x20 : header[i];
    if (checksum !== expected) err('invalid tar header checksum');
    const prefix = tarString(header, 345, 155, 'tar prefix');
    const shortName = tarString(header, 0, 100, 'tar member name');
    const headerName = prefix ? `${prefix}/${shortName}` : shortName;
    const headerSize = tarNumber(header.subarray(124, 136), 'member size');
    const type = String.fromCharCode(header[156] || 0);
    at += 512;
    if (type === 'x' || type === 'g' || type === 'L') {
      if (headerSize > buf.length - at) err(`truncated tar metadata member: ${headerName}`);
      if (headerSize > MAX_TAR_METADATA_BYTES) err('refusing oversized tar metadata member');
      if (metadataBytes > MAX_TAR_METADATA_TOTAL_BYTES - headerSize)
        err(`refusing more than ${MAX_TAR_METADATA_TOTAL_BYTES} bytes of tar metadata`);
      metadataBytes += headerSize;
      const data = buf.subarray(at, at + headerSize);
      if (type === 'L') {
        const nul = data.indexOf(0);
        longName = decodeUtf8(nul < 0 ? data : data.subarray(0, nul), 'GNU tar long name');
      } else {
        const parsed = paxRecords(data, () => {
          if (++paxRecordCount > MAX_TAR_PAX_RECORDS)
            err(`refusing tar with more than ${MAX_TAR_PAX_RECORDS} PAX records`);
        });
        if (type === 'g') globalPax = new Map([...globalPax, ...parsed]);
        else nextPax = new Map([...nextPax, ...parsed]);
      }
      const padded = Math.ceil(headerSize / 512) * 512;
      if (padded > buf.length - at) err(`truncated tar metadata member: ${headerName}`);
      at += padded;
      continue;
    }
    const pax = new Map([...globalPax, ...nextPax]);
    const rawName = pax.get('path') ?? longName ?? headerName;
    const size = pax.has('size') ? paxSize(pax.get('size')!, rawName) : headerSize;
    nextPax = new Map();
    longName = undefined;
    const directory = type === '5';
    if (type !== '\0' && type !== '0' && !directory) {
      const special: Record<string, string> = {
        '1': 'hard link',
        '2': 'symlink',
        '3': 'character device',
        '4': 'block device',
        '6': 'FIFO',
      };
      err(
        `refusing ${special[type] ?? `unsupported type ${JSON.stringify(type)}`} in tar: ${rawName}`
      );
    }
    if (directory && size !== 0) err(`refusing tar directory with data: ${rawName}`);
    if (!directory) total = archiveSize(size, rawName, total, 'tar');
    if (size > buf.length - at) err(`truncated tar member: ${rawName}`);
    const padded = Math.ceil(size / 512) * 512;
    if (padded > buf.length - at) err(`truncated tar member padding: ${rawName}`);
    const name = archivePath(rawName, 'tar', directory);
    if (name) {
      registerArchiveMember(tree, name, directory, 'tar');
      const path = join(dir, name);
      if (directory) ensureArchiveDir(path);
      else {
        ensureArchiveDir(dirname(path));
        if (lstatSync(path, { throwIfNoEntry: false }))
          err(`refusing duplicate tar member: ${name}`);
        writeFileSync(path, buf.subarray(at, at + size), { flag: 'wx', mode: 0o600 });
      }
    }
    at += padded;
  }
  validateExtractedTree(dir);
};

// Minimal zip reader for wheels, Go modules and Packagist dists. It uses central
// sizes only as an early check; inflate has its own output ceiling and the exact
// result is checked before a private regular file is created.
export const extractZip = (bytes: Uint8Array, dir: string): void => {
  dir = prepareArchiveDir(dir);
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const range = (at: number, length: number, what: string): void => {
    if (!Number.isSafeInteger(at) || at < 0 || length < 0 || at > buf.length - length)
      err(`invalid zip: truncated ${what}`);
  };
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--)
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  if (eocd < 0) err('invalid zip: no end-of-central-directory record');
  range(eocd, 22, 'end-of-central-directory record');
  if (eocd + 22 + buf.readUInt16LE(eocd + 20) !== buf.length)
    err('invalid zip: bad end-of-central-directory record');
  const count = buf.readUInt16LE(eocd + 10);
  const diskCount = buf.readUInt16LE(eocd + 8);
  const cdSize = buf.readUInt32LE(eocd + 12);
  let at = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || at === 0xffffffff || cdSize === 0xffffffff)
    err('zip64 archives are not supported');
  if (count !== diskCount || buf.readUInt16LE(eocd + 4) || buf.readUInt16LE(eocd + 6))
    err('multi-disk zip archives are not supported');
  if (count > MAX_ARCHIVE_MEMBERS)
    err(`refusing zip with more than ${MAX_ARCHIVE_MEMBERS} members`);
  range(at, cdSize, 'central directory');
  const cdEnd = at + cdSize;
  if (cdEnd > eocd) err('invalid zip: central directory overlaps trailer');
  const tree: ArchiveTree = { nodes: new Map(), pathBytes: 0 };
  let total = 0;
  for (let i = 0; i < count; i++) {
    range(at, 46, 'central directory entry');
    if (buf.readUInt32LE(at) !== 0x02014b50) err('invalid zip: bad central directory entry');
    const madeBy = buf.readUInt16LE(at + 4) >>> 8;
    const flags = buf.readUInt16LE(at + 8);
    const method = buf.readUInt16LE(at + 10);
    const csize = buf.readUInt32LE(at + 20);
    const usize = buf.readUInt32LE(at + 24);
    const nameLen = buf.readUInt16LE(at + 28);
    const extraLen = buf.readUInt16LE(at + 30);
    const commentLen = buf.readUInt16LE(at + 32);
    const external = buf.readUInt32LE(at + 38);
    const local = buf.readUInt32LE(at + 42);
    const entryLength = 46 + nameLen + extraLen + commentLen;
    range(at, entryLength, 'central directory entry');
    const nameBytes = buf.subarray(at + 46, at + 46 + nameLen);
    const rawName = decodeUtf8(nameBytes, 'zip member name');
    at += entryLength;
    if (csize === 0xffffffff || usize === 0xffffffff || local === 0xffffffff)
      err('zip64 archives are not supported');
    if (flags & 1) err(`refusing encrypted zip member: ${rawName}`);
    const unixType = madeBy === 3 ? (external >>> 16) & 0o170000 : 0;
    if (unixType && unixType !== 0o100000 && unixType !== 0o040000)
      err(`refusing special file in zip: ${rawName}`);
    const directory = rawName.endsWith('/') || unixType === 0o040000 || Boolean(external & 0x10);
    const name = archivePath(rawName, 'zip', directory);
    if (!name) continue;
    registerArchiveMember(tree, name, directory, 'zip');
    const path = join(dir, name);
    if (directory) {
      if (usize || csize) err(`refusing zip directory with data: ${rawName}`);
      ensureArchiveDir(path);
      continue;
    }
    total = archiveSize(usize, name, total, 'zip');
    range(local, 30, 'local file header');
    if (buf.readUInt32LE(local) !== 0x04034b50) err('invalid zip: bad local file header');
    if (buf.readUInt16LE(local + 8) !== method)
      err(`invalid zip: compression method mismatch for ${name}`);
    const localNameLen = buf.readUInt16LE(local + 26);
    const localExtraLen = buf.readUInt16LE(local + 28);
    const dataAt = local + 30 + localNameLen + localExtraLen;
    range(local + 30, localNameLen + localExtraLen, 'local file header');
    range(dataAt, csize, `data for ${name}`);
    if (!buf.subarray(local + 30, local + 30 + localNameLen).equals(nameBytes))
      err(`invalid zip: local filename mismatch for ${name}`);
    const raw = buf.subarray(dataAt, dataAt + csize);
    const data = (() => {
      try {
        return method === 0
          ? raw
          : method === 8
            ? inflateRawSync(raw, { maxOutputLength: usize + 1 })
            : err(`unsupported zip compression method ${method} for ${name}`);
      } catch (error) {
        const detail = error instanceof Error ? `: ${error.message}` : '';
        return err(`zip decompression failed for ${name}${detail}`);
      }
    })();
    if (data.length !== usize) err(`invalid zip: uncompressed size mismatch for ${name}`);
    ensureArchiveDir(dirname(path));
    if (lstatSync(path, { throwIfNoEntry: false })) err(`refusing duplicate zip member: ${name}`);
    writeFileSync(path, data, { flag: 'wx', mode: 0o600 });
  }
  if (at !== cdEnd) err('invalid zip: central directory size mismatch');
  validateExtractedTree(dir);
};

// Zip or tar, by magic bytes: registries mix formats (packagist dists are zips,
// old pypi sdists too) and filenames lie more often than content does.
export const extractArchive = (bytes: Uint8Array, dir: string): void =>
  bytes.length > 3 && bytes[0] === 0x50 && bytes[1] === 0x4b
    ? extractZip(bytes, dir)
    : extractTar(bytes, dir);

export const npmInstall = (dir: string, refresh = false): void => {
  assertTemp(dir);
  try {
    // `refresh` swaps offline-first for a revalidating fetch: npm's cached
    // packument can predate a just-published version, and --prefer-offline
    // would keep answering ETARGET for it forever.
    const args = refresh
      ? NPM_INSTALL_ARGS.map((arg) => (arg === '--prefer-offline' ? '--prefer-online' : arg))
      : [...NPM_INSTALL_ARGS];
    // --loglevel=error beats the quiet npm_config_loglevel env, so failures stay explained.
    execFileSync('npm', [...args, '--loglevel=error'], {
      cwd: dir,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const stderr = String((error as { stderr?: unknown }).stderr || '').trim();
    err(`npm install failed${stderr ? `:\n${stderr}` : ''}`);
  }
};

// `npm pack` into a bismar temp dir — the one faithful implementation of npm's
// publish file selection (files field, .npmignore/.gitignore, the always/never
// lists). Reads the source dir, writes only the destination tarball;
// --ignore-scripts keeps prepack/prepare from running, so the tree is packed
// as it sits on disk. Returns the tarball path.
export const npmPack = (srcDir: string, destDir: string): string => {
  mkdir(assertTemp(destDir));
  try {
    execFileSync(
      'npm',
      ['pack', '--ignore-scripts', '--pack-destination', destDir, '--loglevel=error'],
      { cwd: srcDir, stdio: ['ignore', 'ignore', 'pipe'] }
    );
  } catch (error) {
    const stderr = String((error as { stderr?: unknown }).stderr || '').trim();
    err(`npm pack failed${stderr ? `:\n${stderr}` : ''}`);
  }
  // npm prints the tarball name, but scoped names came out wrong in some npm
  // versions — the fresh destination dir holding exactly one tarball is surer.
  const made = readdirSync(destDir).filter((ent) => ent.endsWith('.tgz'));
  if (made.length !== 1) err(`npm pack left ${made.length} tarballs in ${destDir}`);
  return join(destDir, made[0]);
};

// Creates a directory symlink inside a bismar temp dir; existing links are left alone.
const linkDir = (target: string, linkPath: string): void => {
  assertTemp(linkPath);
  if (existsSync(linkPath)) return;
  mkdir(dirname(linkPath));
  try {
    symlinkSync(target, linkPath, 'junction');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
};
const esbuildCacheValid = (dir: string): boolean => {
  try {
    const pkgText = readFileSync(join(dir, 'node_modules', 'esbuild', 'package.json'), 'utf8');
    const pkg = JSON.parse(pkgText);
    const marker = JSON.parse(readFileSync(join(dir, '.bismar-cache.json'), 'utf8'));
    return (
      marker?.v === 2 &&
      marker?.spec === RUN_ESBUILD_SPEC &&
      marker?.version === pkg?.version &&
      marker?.manifestSha256 === createHash('sha256').update(pkgText).digest('hex') &&
      pkg?.name === 'esbuild' &&
      typeof pkg?.version === 'string'
    );
  } catch {
    return false;
  }
};
const cachedEsbuildDir = (root: string): string | undefined => {
  try {
    for (const ent of readdirSync(root, { withFileTypes: true })) {
      // Never follow a planted cache-root symlink. Valid cache candidates are
      // complete directories atomically promoted by this version of bismar.
      if (!ent.isDirectory() || ent.name.startsWith('.prime-')) continue;
      const dir = join(root, ent.name);
      if (esbuildCacheValid(dir)) return dir;
    }
  } catch {
    // Missing/unreadable cache: prime a private candidate below.
  }
  return undefined;
};
// One esbuild install per machine and pinned range, primed by npm on first use.
// Cold installs happen in a private candidate and appear in the shared cache
// only through a directory rename, so crashes and concurrent runs cannot expose
// or tear down a half-installed node_modules tree.
export const esbuildCacheModules = (): string => {
  const root = privateCacheDir('bismar-esbuild-v2');
  const warm = cachedEsbuildDir(root);
  if (warm) return join(warm, 'node_modules');
  const stage = mkdtempSync(join(root, '.prime-'));
  let keepStage = false;
  try {
    writePkg(
      join(stage, 'package.json'),
      `${JSON.stringify({ dependencies: { esbuild: RUN_ESBUILD_SPEC }, private: true }, null, 2)}\n`
    );
    npmInstall(stage);
    const manifest = readFileSync(join(stage, 'node_modules', 'esbuild', 'package.json'), 'utf8');
    const installed = JSON.parse(manifest);
    const manifestSha256 = createHash('sha256').update(manifest).digest('hex');
    atomicWrite(
      join(stage, '.bismar-cache.json'),
      `${JSON.stringify({
        manifestSha256,
        spec: RUN_ESBUILD_SPEC,
        v: 2,
        version: installed.version,
      })}\n`
    );
    const identity = createHash('sha256')
      .update(`${RUN_ESBUILD_SPEC}\0${installed.version}\0${manifestSha256}`)
      .digest('hex');
    let target = join(root, identity);
    if (existsSync(target)) {
      if (esbuildCacheValid(target)) return join(target, 'node_modules');
      // An invalid exact-name candidate is never overwritten or trusted. A
      // unique complete candidate remains discoverable on the next warm run.
      target = join(root, `${identity}-${randomUUID()}`);
    }
    if (promoteTemp(stage, target)) return join(target, 'node_modules');
    const winner = cachedEsbuildDir(root);
    if (winner) return join(winner, 'node_modules');
    // An unusual rename failure should not discard a complete private install;
    // this invocation can safely use it even though it was not machine-cached.
    keepStage = true;
    return join(stage, 'node_modules');
  } finally {
    if (!keepStage && existsSync(stage)) rmTempDir(stage);
  }
};
// Assembles the run dir's node_modules via symlinks (matching how npm links `file:`
// deps), so the hot path never spawns npm. Falls back to a real install on any failure.
// `extras` are allowlisted bare package names linked from the project's own
// node_modules; their manifest specs stay `file:` paths, so even the fallback install
// never fetches third-party code from a registry.
export const installRunDeps = (
  cwd: string,
  name: string,
  dir: string,
  extras: readonly string[] = []
): void => {
  const extraDeps = Object.fromEntries(
    extras.map((dep) => [dep, `file:${join(cwd, 'node_modules', dep)}`])
  );
  writePkg(
    join(assertTemp(dir), 'package.json'),
    `${JSON.stringify(
      {
        dependencies: { ...extraDeps, [name]: `file:${cwd}`, esbuild: RUN_ESBUILD_SPEC },
        private: true,
        type: 'module',
      },
      null,
      2
    )}\n`
  );
  const modules = join(dir, 'node_modules');
  const linked = (dep: string): boolean => existsSync(join(modules, dep));
  if (linked(name) && linked('esbuild') && extras.every(linked)) return;
  try {
    const cache = esbuildCacheModules();
    linkDir(cwd, join(modules, name));
    for (const dep of extras) linkDir(join(cwd, 'node_modules', dep), join(modules, dep));
    linkDir(join(cache, 'esbuild'), join(modules, 'esbuild'));
    const scoped = join(cache, '@esbuild');
    if (existsSync(scoped))
      for (const ent of readdirSync(scoped))
        linkDir(join(scoped, ent), join(modules, '@esbuild', ent));
  } catch {
    npmInstall(dir);
  }
};

export const __TEST: {
  inBismarTmp: (path: string) => boolean;
  npmInstallArgs: () => string[];
} = {
  inBismarTmp: inBismarTmp,
  npmInstallArgs: () => [...NPM_INSTALL_ARGS],
};
