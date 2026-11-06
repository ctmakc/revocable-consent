// Input handling of the verify-ledger CLI: accepted export shapes and the
// exit-2 usage paths. All offline — the --postgres cases are rejected before
// any connection is attempted.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeEntryHash, GENESIS_PREV_HASH } from '../src/ledger-core.mjs';

const CLI = fileURLToPath(new URL('../bin/verify-ledger.mjs', import.meta.url));

function cli(args: string[], env: Record<string, string | undefined> = {}) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    const childEnv = { ...process.env, ...env };
    for (const [k, v] of Object.entries(env)) if (v === undefined) delete childEnv[k];
    execFile(process.execPath, [CLI, ...args], { env: childEnv }, (err, stdout, stderr) => {
      const code = err ? ((err as { code?: number }).code ?? 1) : 0;
      resolve({ code, stdout, stderr });
    });
  });
}

function oneEntryChain() {
  const e = {
    seq: 1,
    prev_seq: 0,
    contribution_id: null,
    entry_type: 'published',
    actor: 'operator',
    payload: { title: 'x' },
    prev_hash: GENESIS_PREV_HASH,
  };
  return [{ ...e, hash: computeEntryHash(e as never) }];
}

let dir: string;
const file = (name: string, content: string) => {
  const p = join(dir, name);
  writeFileSync(p, content);
  return p;
};
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'rc-cli-input-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('verify-ledger CLI — input shapes', () => {
  it('accepts an object wrapping the chain as { rows: [...] }', async () => {
    const r = await cli(['--file', file('rows.json', JSON.stringify({ rows: oneEntryChain() }))]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('OK — 1 entries');
  });

  it('accepts an object wrapping the chain as { entries: [...] }', async () => {
    const r = await cli(['--file', file('entries.json', JSON.stringify({ entries: oneEntryChain() }))]);
    expect(r.code).toBe(0);
  });

  it('an empty array is a valid (empty) chain', async () => {
    const r = await cli(['--file', file('empty.json', '[]')]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('OK — 0 entries');
  });
});

describe('verify-ledger CLI — usage errors exit 2', () => {
  it('unparseable JSON', async () => {
    const r = await cli(['--file', file('bad.json', '{not json')]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/could not parse .*bad\.json as JSON/);
  });

  it('JSON that is not a chain', async () => {
    const r = await cli(['--file', file('obj.json', '{"foo": 1}')]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('expected a JSON array of ledger entries');
  });

  it('--file with no path', async () => {
    const r = await cli(['--file']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('--file needs a path');
  });

  it('--postgres without DATABASE_URL', async () => {
    const r = await cli(['--postgres'], { DATABASE_URL: undefined });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('DATABASE_URL is not set');
  });

  it('--postgres with an unsafe table name is refused before connecting', async () => {
    const r = await cli(['--postgres', '--table', 'ledger; DROP TABLE x'], {
      DATABASE_URL: 'postgres://nobody@127.0.0.1:1/none',
    });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('invalid table name');
  });

  it.skip('bug: an export row without a "hash" field crashes with a TypeError stack trace (exit 1, "chain broken") instead of a clean FAIL/usage message', async () => {
    const [row] = oneEntryChain();
    const { hash: _drop, ...noHash } = row;
    const r = await cli(['--file', file('nohash.json', JSON.stringify([noHash]))]);
    expect(r.stderr).not.toContain('TypeError');
    expect(r.stderr).toMatch(/^verify-ledger: /);
  });
});
