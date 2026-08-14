import { deepStrictEqual, strictEqual, throws } from 'node:assert';
import { randomUUID } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { test as it } from 'node:test';
import { deflateRawSync } from 'node:zlib';

import {
  extractTar,
  extractZip,
  privateCacheDir,
  tempDir,
  write,
  writePkg,
} from '../src/fs-modify.ts';

type TarEntry = { data?: string | Uint8Array; name: string; size?: number; type?: string };
const tarHeader = ({ data = '', name, size, type = '0' }: TarEntry): Buffer => {
  const bytes = typeof data === 'string' ? Buffer.from(data) : Buffer.from(data);
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  const octal = (value: number, at: number, length: number): void => {
    header.write(`${value.toString(8).padStart(length - 1, '0')}\0`, at, length, 'ascii');
  };
  octal(0o777, 100, 8);
  octal(0, 108, 8);
  octal(0, 116, 8);
  octal(size ?? bytes.length, 124, 12);
  octal(0, 136, 12);
  header.fill(0x20, 148, 156);
  header.write(type, 156, 1, 'ascii');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return header;
};
const tarOf = (entries: TarEntry[]): Buffer => {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    let actual = entry;
    if (Buffer.byteLength(entry.name) > 100) {
      const long = Buffer.from(`${entry.name}\0`);
      chunks.push(tarHeader({ data: long, name: '././@LongLink', type: 'L' }), long);
      chunks.push(Buffer.alloc((512 - (long.length % 512)) % 512));
      actual = { ...entry, name: 'long-name-placeholder' };
    }
    const data = Buffer.from(actual.data ?? '');
    chunks.push(tarHeader(actual), data);
    chunks.push(Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
};

type ZipEntry = { data: string; declaredSize?: number; mode?: number; name: string };
const zipOf = (entries: ZipEntry[]): Buffer => {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const plain = Buffer.from(entry.data);
    const data = deflateRawSync(plain);
    const size = entry.declaredSize ?? plain.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((entry.mode ?? 0o100644) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(Buffer.concat([local, name, data]));
    centrals.push(Buffer.concat([central, name]));
    offset += locals.at(-1)!.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
};

it('tar extraction creates only private regular files and directories', () => {
  const dir = tempDir('check');
  try {
    extractTar(
      tarOf([
        { name: 'pkg/', type: '5' },
        { data: 'safe\n', name: 'pkg/file.txt' },
      ]),
      join(dir, 'out')
    );
    strictEqual(readFileSync(join(dir, 'out', 'pkg', 'file.txt'), 'utf8'), 'safe\n');
    strictEqual(lstatSync(join(dir, 'out', 'pkg')).mode & 0o777, 0o700);
    strictEqual(lstatSync(join(dir, 'out', 'pkg', 'file.txt')).mode & 0o777, 0o600);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

it('tar extraction rejects traversal, links, special files, deep paths, and expansion', () => {
  const cases: Array<[TarEntry, RegExp]> = [
    [{ data: 'x', name: '../outside' }, /unsafe tar member/],
    [{ data: 'x', name: '/absolute' }, /unsafe tar member/],
    [{ data: 'x', name: 'safe/.. /outside' }, /unsafe tar member/],
    [{ data: 'x', name: 'file:stream' }, /unsafe tar member/],
    [{ data: 'x', name: 'NUL.txt' }, /unsafe tar member/],
    [{ name: 'link', type: '2' }, /refusing symlink in tar/],
    [{ name: 'hard', type: '1' }, /refusing hard link in tar/],
    [{ name: 'pipe', type: '6' }, /refusing FIFO in tar/],
    [{ data: '', name: Array(101).fill('d').join('/'), type: '5' }, /deeper than 100/],
    [{ name: 'huge.bin', size: 256 * 1024 * 1024 + 1 }, /member larger than/],
  ];
  const root = tempDir('check');
  try {
    for (const [entry, expected] of cases)
      throws(() => extractTar(tarOf([entry]), join(root, randomUUID())), expected);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

it('archive extraction refuses a pre-existing symlink anywhere in its destination', () => {
  const dir = tempDir('check');
  try {
    mkdirSync(join(dir, 'out'));
    symlinkSync(dir, join(dir, 'out', 'sole'));
    throws(
      () => extractTar(tarOf([{ data: 'x', name: 'file' }]), join(dir, 'out')),
      /symlink in extracted archive/
    );
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

it('zip extraction rejects Unix symlinks, excessive paths, and declared expansion', () => {
  const root = tempDir('check');
  try {
    throws(
      () =>
        extractZip(
          zipOf([{ data: '../outside', mode: 0o120777, name: 'link' }]),
          join(root, 'link')
        ),
      /special file in zip/
    );
    throws(
      () =>
        extractZip(zipOf([{ data: '', name: Array(101).fill('d').join('/') }]), join(root, 'deep')),
      /deeper than 100/
    );
    throws(
      () =>
        extractZip(
          zipOf([{ data: 'tiny', declaredSize: 256 * 1024 * 1024 + 1, name: 'bomb' }]),
          join(root, 'bomb')
        ),
      /member larger than/
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

it('cache and package writes atomically replace private files and clean failed temps', () => {
  const dir = tempDir('check');
  try {
    const cache = join(dir, 'cache.json');
    write(cache, 'old');
    write(cache, 'new');
    strictEqual(readFileSync(cache, 'utf8'), 'new');
    strictEqual(lstatSync(cache).mode & 0o777, 0o600);
    writePkg(join(dir, 'package.json'), '{}\n');
    strictEqual(lstatSync(join(dir, 'package.json')).mode & 0o777, 0o600);

    const blocked = join(dir, 'blocked.json');
    mkdirSync(blocked);
    throws(() => write(blocked, 'nope'));
    deepStrictEqual(
      readdirSync(dir).filter((name) => name.includes('.tmp')),
      []
    );
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

it('predictable cache roots never follow a planted temp-directory symlink', (t) => {
  const name = `bismar-root-${randomUUID()}`;
  const desired = join(tmpdir(), name);
  const outside = mkdtempSync(join(tmpdir(), 'cache-root-escape-'));
  let fallback = '';
  try {
    try {
      symlinkSync(outside, desired, 'junction');
    } catch {
      return t.skip('directory symlinks unavailable');
    }
    const dir = privateCacheDir(name, 'v2');
    fallback = dirname(dir);
    deepStrictEqual(dir === desired || dir.startsWith(`${desired}${sep}`), false, dir);
    write(join(dir, 'entry.json'), '{}\n');
    deepStrictEqual(readdirSync(outside), []);
  } finally {
    rmSync(desired, { force: true, recursive: true });
    if (fallback) rmSync(fallback, { force: true, recursive: true });
    rmSync(outside, { force: true, recursive: true });
  }
});
