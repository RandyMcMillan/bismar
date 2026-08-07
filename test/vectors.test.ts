// Vectors are committed, machine-independent fixtures. Generated artifacts embed
// absolute paths (run manifests, error-check probes), so any absolute path found
// here is a leaked artifact, not fixture material.
import { deepStrictEqual } from 'node:assert';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { test as should } from 'node:test';

const VECTORS = resolve('test/vectors');

should('vectors contain no machine-specific absolute paths', () => {
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name !== 'node_modules') walk(path);
      } else if (/(?:file:\/*)?\/(?:home|Users|root)\//.test(readFileSync(path, 'utf8')))
        offenders.push(relative(VECTORS, path));
    }
  };
  walk(VECTORS);
  deepStrictEqual(offenders, []);
});
