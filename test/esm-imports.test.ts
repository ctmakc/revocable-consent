// The package is "type": "module" and ships tsc output as-is, so every
// relative import in src/ must carry an explicit extension — Node's ESM
// loader does not guess one, and `import 'revocable-consent'` would fail
// with ERR_MODULE_NOT_FOUND on the built dist/index.js.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));

describe('ESM import specifiers in src/', () => {
  const files = readdirSync(SRC).filter((f) => /\.(ts|mts|mjs)$/.test(f));
  it.each(files)('%s uses only extension-qualified relative imports', (f) => {
    const text = readFileSync(join(SRC, f), 'utf8');
    const specs = [...text.matchAll(/\bfrom\s+['"](\.{1,2}\/[^'"]+)['"]/g)].map((m) => m[1]);
    const bad = specs.filter((s) => !/\.(js|mjs)$/.test(s));
    expect(bad).toEqual([]);
  });
});
