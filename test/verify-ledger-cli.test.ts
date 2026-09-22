// The CLI is the auditor's tool, so it gets tested the way an auditor uses it:
// as a process, on a file, by exit code.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { computeEntryHash, GENESIS_PREV_HASH, GENESIS_PREV_SEQ } from '../src/ledger-core.mjs';

const run = promisify(execFile);
const CLI = fileURLToPath(new URL('../bin/verify-ledger.mjs', import.meta.url));

function buildChain(n: number) {
  const rows: Record<string, unknown>[] = [];
  let prev_seq = GENESIS_PREV_SEQ;
  let prev_hash = GENESIS_PREV_HASH;
  for (let i = 1; i <= n; i++) {
    const entry = {
      seq: i,
      prev_seq,
      contribution_id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      entry_type: i === 1 ? 'published' : 'withdrawn',
      actor: 'operator',
      payload: { title: `Item ${i}`, collection: 'demo' },
      prev_hash,
    };
    const hash = computeEntryHash(entry as never);
    rows.push({ ...entry, hash });
    prev_seq = i;
    prev_hash = hash;
  }
  return rows;
}

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'revocable-consent-cli-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function cli(args: string[]) {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args]);
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

describe('verify-ledger CLI', () => {
  it('exits 0 on a valid chain', async () => {
    const path = join(dir, 'valid.json');
    writeFileSync(path, JSON.stringify(buildChain(3)));
    const r = await cli(['--file', path]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/OK — 3 entries/);
  });

  it('exits 1 and names the entry on a tampered chain', async () => {
    const rows = buildChain(3);
    (rows[1] as { payload: unknown }).payload = { title: 'REWRITTEN', collection: 'demo' };
    const path = join(dir, 'tampered.json');
    writeFileSync(path, JSON.stringify(rows));
    const r = await cli(['--file', path]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/FAIL at seq=2/);
    expect(r.stderr).toMatch(/hash mismatch/);
  });

  it('exits 1 when an entry was removed from the middle', async () => {
    const rows = buildChain(3);
    const path = join(dir, 'gap.json');
    writeFileSync(path, JSON.stringify([rows[0], rows[2]]));
    const r = await cli(['--file', path]);
    expect(r.code).toBe(1);
  });

  it('exits 2 with usage when called wrong', async () => {
    expect((await cli([])).code).toBe(2);
    expect((await cli(['--file', join(dir, 'nope.json')])).code).not.toBe(0);
  });

  it('reads a chain from stdin', async () => {
    const rows = buildChain(2);
    const { stdout } = await run('bash', [
      '-c',
      `printf %s ${JSON.stringify(JSON.stringify(rows))} | ${process.execPath} ${CLI} --file -`,
    ]);
    expect(stdout).toMatch(/OK — 2 entries/);
  });
});
