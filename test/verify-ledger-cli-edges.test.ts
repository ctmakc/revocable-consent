// Input-handling paths of the auditor CLI. Every case here exits before any
// connection is attempted: --postgres is only exercised on its usage errors.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeEntryHash, GENESIS_PREV_HASH } from '../src/ledger-core.mjs';

const CLI = fileURLToPath(new URL('../bin/verify-ledger.mjs', import.meta.url));

function chain(n: number) {
  const rows: Record<string, unknown>[] = [];
  let prev_seq = 0;
  let prev_hash = GENESIS_PREV_HASH;
  for (let i = 1; i <= n; i++) {
    const e = { seq: i, prev_seq, contribution_id: null, entry_type: 'published', actor: 'op', payload: { i }, prev_hash };
    const hash = computeEntryHash(e as never);
    rows.push({ ...e, hash });
    prev_seq = i;
    prev_hash = hash;
  }
  return rows;
}

function cli(args: string[], opts: { stdin?: string; env?: Record<string, string | undefined> } = {}) {
  const env = { ...process.env, ...opts.env };
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete env[k];
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    const child = execFile(process.execPath, [CLI, ...args], { env }, (err, stdout, stderr) => {
      const code = err ? ((err as { code?: number }).code ?? 1) : 0;
      resolve({ code: typeof code === 'number' ? code : 1, stdout, stderr });
    });
    child.stdin!.end(opts.stdin ?? '');
  });
}

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'rc-cli-edges-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('verify-ledger CLI — input shapes', () => {
  it('accepts an object wrapping the entries as { rows: [...] }', async () => {
    const p = join(dir, 'rows.json');
    writeFileSync(p, JSON.stringify({ rows: chain(2) }));
    const r = await cli(['--file', p]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/OK — 2 entries/);
  });

  it('accepts an object wrapping the entries as { entries: [...] }', async () => {
    const r = await cli(['--file', '-'], { stdin: JSON.stringify({ entries: chain(1) }) });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/OK — 1 entries/);
  });

  it('an empty array is a valid (empty) chain', async () => {
    const r = await cli(['--file', '-'], { stdin: '[]' });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/OK — 0 entries/);
  });

  it('exits 2 on input that is not JSON', async () => {
    const r = await cli(['--file', '-'], { stdin: 'not json' });
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/could not parse stdin as JSON/);
  });

  it('exits 2 on JSON that holds no entry array', async () => {
    const r = await cli(['--file', '-'], { stdin: '{"foo": 1}' });
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/expected a JSON array/);
  });

  it('exits 2 when --file has no path', async () => {
    const r = await cli(['--file']);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/--file needs a path/);
  });

  it('names the broken link when the genesis entry is missing', async () => {
    const rows = chain(3).slice(1);
    const r = await cli(['--file', '-'], { stdin: JSON.stringify(rows) });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/FAIL at seq=2: genesis entry/);
  });

  it.skip('bug: a row without `hash` crashes the CLI with a TypeError stack instead of a FAIL line (verifyChain throws)', async () => {
    const rows = chain(1).map(({ hash: _h, ...rest }) => rest);
    const r = await cli(['--file', '-'], { stdin: JSON.stringify(rows) });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/verify-ledger: FAIL at seq=1/);
    expect(r.stderr).not.toMatch(/TypeError/);
  });

  it.skip('bug: the documented psql export of an EMPTY ledger (json_agg → NULL → empty output) is rejected with exit 2, while the library treats an empty ledger as valid', async () => {
    for (const stdin of ['\n', 'null\n']) {
      const r = await cli(['--file', '-'], { stdin });
      expect(r.code, JSON.stringify(stdin)).toBe(0);
    }
  });
});

describe('verify-ledger CLI — --postgres usage errors (no connection attempted)', () => {
  it('exits 2 when DATABASE_URL is not set', async () => {
    const r = await cli(['--postgres'], { env: { DATABASE_URL: undefined } });
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/DATABASE_URL is not set/);
  });

  it('refuses a table name that is not a plain identifier (no SQL injection via --table)', async () => {
    const r = await cli(['--postgres', '--table', 'ledger_entries; DROP TABLE x'], {
      // never contacted: the name check runs first
      env: { DATABASE_URL: 'postgres://user:pass@127.0.0.1:1/none' },
    });
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/invalid table name/);
  });
});
