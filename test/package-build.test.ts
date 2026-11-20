// The package ships as native ESM ("type": "module"). Node's ESM loader does
// not guess file extensions, so every relative import in src/ must name the
// file it means (`./consent.js`), or the built dist/index.js cannot be loaded
// by a consumer at all. Vitest resolves extensionless imports on its own, so
// only a real build + a real Node import catches this.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC = join(ROOT, 'src');

describe('relative import specifiers in src/', () => {
  it('all carry an explicit .js / .mjs extension (Node ESM requires it)', () => {
    const offenders: string[] = [];
    for (const f of readdirSync(SRC)) {
      if (!/\.(ts|mjs)$/.test(f)) continue;
      const text = readFileSync(join(SRC, f), 'utf8');
      for (const m of text.matchAll(/\bfrom\s+'(\.{1,2}\/[^']+)'/g)) {
        if (!/\.(m?js)$/.test(m[1])) offenders.push(`${f}: ${m[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('built package', () => {
  let out: string;
  beforeAll(async () => {
    out = mkdtempSync(join(tmpdir(), 'revocable-consent-build-'));
    const tsc = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
    await run(process.execPath, [tsc, '-p', join(ROOT, 'tsconfig.build.json'), '--outDir', out], {
      cwd: ROOT,
    });
  }, 120_000);
  afterAll(() => {
    if (out) rmSync(out, { recursive: true, force: true });
  });

  it('dist/index.js loads under plain Node ESM and exposes the public API', async () => {
    // Import in a child Node process, outside Vitest's resolver.
    const entry = pathToFileURL(join(out, 'index.js')).href;
    const { stdout } = await run(process.execPath, [
      '--input-type=module',
      '-e',
      `const m = await import(${JSON.stringify(entry)}); console.log(Object.keys(m).sort().join(','));`,
    ]);
    const names = stdout.trim().split(',');
    for (const name of ['revokeConsent', 'appendLedgerEntry', 'verifySignedUrl', 'transition', 'scopeAllows']) {
      expect(names).toContain(name);
    }
  }, 60_000);
});
