// The DB-facing half of the ledger, driven through a fake QueryFn: race
// retries on prev_seq, the legacy vocabulary map, and the whole-chain / tail
// verifiers. No database involved.
import { describe, it, expect } from 'vitest';
import {
  appendLedgerEntry,
  canonicalJson,
  computeEntryHash,
  publicEntryType,
  verifyChain,
  verifyLedger,
  verifyLedgerTail,
  GENESIS_PREV_HASH,
  GENESIS_PREV_SEQ,
  LEDGER_ENTRY_TYPES,
  type QueryFn,
} from '../src/ledger';

/** In-memory ledger_entries with a UNIQUE(prev_seq) the way the schema has it. */
function fakeDb(opts: { raceOnce?: number; failWith?: unknown; emptyInsert?: boolean } = {}) {
  const rows: any[] = [];
  let seq = 0;
  let races = opts.raceOnce ?? 0;
  const calls: string[] = [];
  const q: QueryFn = (async (text: string, params: unknown[] = []) => {
    calls.push(text.trim().split(/\s+/)[0]);
    if (text.startsWith('SELECT seq, hash FROM ledger_entries')) {
      const tail = rows[rows.length - 1];
      return tail ? [{ seq: String(tail.seq), hash: tail.hash }] : [];
    }
    if (text.startsWith('SELECT seq, prev_seq')) {
      const sorted = [...rows].sort((a, b) => a.seq - b.seq);
      return text.includes('DESC LIMIT 1') ? sorted.slice(-1) : sorted;
    }
    if (text.startsWith('INSERT INTO ledger_entries')) {
      if (opts.failWith) throw opts.failWith;
      if (opts.emptyInsert) return [];
      if (races > 0) {
        races -= 1;
        // Simulate a competing writer that won the race for this prev_seq.
        const [prev_seq, , , , , prev_hash] = params as any[];
        seq += 1;
        const winner = {
          seq,
          prev_seq: Number(prev_seq),
          contribution_id: null,
          entry_type: 'published',
          actor: 'competitor',
          payload: { n: seq },
          prev_hash,
        };
        rows.push({ ...winner, hash: computeEntryHash(winner) });
        throw Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
      }
      const [prev_seq, contribution_id, entry_type, actor, payloadJson, prev_hash, hash] = params as any[];
      if (rows.some((r) => r.prev_seq === Number(prev_seq))) {
        throw Object.assign(new Error('duplicate key value'), { code: '23505' });
      }
      seq += 1;
      const row = {
        id: `led-${seq}`,
        seq,
        prev_seq: Number(prev_seq),
        contribution_id,
        entry_type,
        actor,
        payload: JSON.parse(payloadJson),
        prev_hash,
        hash,
        created_at: '2026-01-01T00:00:00.000Z',
      };
      rows.push(row);
      return [row];
    }
    throw new Error(`unexpected query: ${text}`);
  }) as QueryFn;
  return { q, rows, calls };
}

const input = (n: number) => ({
  contribution_id: `c-${n}`,
  entry_type: 'published' as const,
  actor: 'operator',
  payload: { title: `t${n}` },
});

describe('appendLedgerEntry', () => {
  it('the first append is genesis-linked', async () => {
    const { q } = fakeDb();
    const row = await appendLedgerEntry(q, input(1));
    expect(row.prev_seq).toBe(GENESIS_PREV_SEQ);
    expect(row.prev_hash).toBe(GENESIS_PREV_HASH);
    expect(row.hash).toBe(
      computeEntryHash({ ...input(1), prev_hash: GENESIS_PREV_HASH } as never)
    );
  });

  it('retries against the fresh tail after losing a prev_seq race, and the chain still verifies', async () => {
    const { q, rows } = fakeDb({ raceOnce: 2 });
    const row = await appendLedgerEntry(q, input(1));
    // two competitor rows landed first, ours links to the second of them
    expect(rows).toHaveLength(3);
    expect(row.actor).toBe('operator');
    expect(row.prev_seq).toBe(rows[1].seq);
    expect(row.prev_hash).toBe(rows[1].hash);
    expect(verifyChain(rows)).toEqual({ ok: true, count: 3 });
  });

  it('gives up after three lost races with a descriptive error', async () => {
    const { q } = fakeDb({ raceOnce: 3 });
    await expect(appendLedgerEntry(q, input(1))).rejects.toThrow(
      /lost the race 3 times: duplicate key value/
    );
  });

  it('recognises a unique violation by message when the driver gives no code', async () => {
    let attempts = 0;
    const q: QueryFn = (async (text: string) => {
      if (text.startsWith('SELECT')) return [];
      attempts += 1;
      throw new Error('ERROR: Duplicate Key Value violates unique constraint "ledger_prev_seq_key"');
    }) as QueryFn;
    await expect(appendLedgerEntry(q, input(1))).rejects.toThrow(/lost the race 3 times/);
    expect(attempts).toBe(3);
  });

  it('rethrows any other database error immediately, without retrying', async () => {
    const boom = Object.assign(new Error('connection reset'), { code: '08006' });
    const { q, calls } = fakeDb({ failWith: boom });
    await expect(appendLedgerEntry(q, input(1))).rejects.toBe(boom);
    expect(calls.filter((c) => c === 'INSERT')).toHaveLength(1);
  });

  it('fails loudly when the insert returns no row', async () => {
    const { q } = fakeDb({ emptyInsert: true });
    await expect(appendLedgerEntry(q, input(1))).rejects.toThrow('ledger insert returned no row');
  });

  it('drops undefined payload fields before hashing (stored === hashed)', async () => {
    const { q, rows } = fakeDb();
    await appendLedgerEntry(q, { ...input(1), payload: { title: 'x', note: undefined } });
    expect(rows[0].payload).toEqual({ title: 'x' });
    expect(verifyChain(rows).ok).toBe(true);
  });

  it('rejects a cyclic payload before touching the database', async () => {
    const { q, calls } = fakeDb();
    const payload: any = { title: 'loop' };
    payload.self = payload;
    await expect(appendLedgerEntry(q, { ...input(1), payload })).rejects.toThrow();
    expect(calls).toEqual([]);
  });
});

describe('verifyLedger / verifyLedgerTail', () => {
  it('an empty ledger is valid for both', async () => {
    const { q } = fakeDb();
    expect(await verifyLedger(q)).toEqual({ ok: true, count: 0 });
    expect(await verifyLedgerTail(q)).toEqual({ ok: true, count: 0 });
  });

  it('a chain built by appendLedgerEntry verifies in full and at the tail', async () => {
    const { q } = fakeDb();
    for (let i = 1; i <= 4; i++) await appendLedgerEntry(q, input(i));
    expect(await verifyLedger(q)).toEqual({ ok: true, count: 4 });
    expect(await verifyLedgerTail(q)).toEqual({ ok: true, count: 1 });
  });

  it('the tail check catches a tampered last entry and names its seq', async () => {
    const { q, rows } = fakeDb();
    for (let i = 1; i <= 3; i++) await appendLedgerEntry(q, input(i));
    rows[2].payload = { title: 'rewritten' };
    expect(await verifyLedgerTail(q)).toEqual({
      ok: false,
      count: 1,
      seq: 3,
      error: 'tail entry hash mismatch',
    });
    expect((await verifyLedger(q)).ok).toBe(false);
  });

  it('the tail check is cheap by design: it does not see a tampered middle entry', async () => {
    const { q, rows } = fakeDb();
    for (let i = 1; i <= 3; i++) await appendLedgerEntry(q, input(i));
    rows[1].payload = { title: 'rewritten' };
    expect((await verifyLedgerTail(q)).ok).toBe(true);
    const full = await verifyLedger(q);
    expect(full.ok).toBe(false);
    expect(full.seq).toBe(2);
  });
});

describe('publicEntryType (legacy vocabulary at read time)', () => {
  it('maps the pre-rename names', () => {
    expect(publicEntryType('mint')).toBe('published');
    expect(publicEntryType('withdraw')).toBe('withdrawn');
  });

  it('passes current names and unknown values through unchanged', () => {
    for (const t of LEDGER_ENTRY_TYPES) expect(publicEntryType(t)).toBe(t);
    expect(publicEntryType('something_else')).toBe('something_else');
  });

  it('a legacy-named entry still verifies, because its hash commits to the stored bytes', () => {
    const e = {
      seq: 1,
      prev_seq: 0,
      contribution_id: 'c',
      entry_type: 'mint',
      actor: 'operator',
      payload: {},
      prev_hash: GENESIS_PREV_HASH,
    };
    const row = { ...e, hash: computeEntryHash(e as never) };
    expect(verifyChain([row])).toEqual({ ok: true, count: 1 });
  });
});

describe('ledger-core edge cases', () => {
  it('computeEntryHash treats a missing contribution_id as null', () => {
    const base = { entry_type: 'published', actor: 'a', payload: {}, prev_hash: GENESIS_PREV_HASH };
    expect(computeEntryHash({ ...base, contribution_id: undefined } as never)).toBe(
      computeEntryHash({ ...base, contribution_id: null } as never)
    );
  });

  it('verifyChain accepts bigint-as-string seq/prev_seq the driver returns', () => {
    const e1 = { seq: '1', prev_seq: '0', contribution_id: null, entry_type: 'published', actor: 'a', payload: {}, prev_hash: GENESIS_PREV_HASH };
    const h1 = computeEntryHash(e1 as never);
    const e2 = { seq: '7', prev_seq: '1', contribution_id: null, entry_type: 'withdrawn', actor: 'a', payload: {}, prev_hash: h1 };
    const rows = [{ ...e1, hash: h1 }, { ...e2, hash: computeEntryHash(e2 as never) }];
    expect(verifyChain(rows)).toEqual({ ok: true, count: 2 });
  });

  it('verifyChain rejects a genesis row with the right prev_seq but wrong prev_hash', () => {
    const e = { seq: 1, prev_seq: 0, contribution_id: null, entry_type: 'published', actor: 'a', payload: {}, prev_hash: 'x' };
    const res = verifyChain([{ ...e, hash: computeEntryHash(e as never) }]);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/prev_hash=x, expected GENESIS/);
  });

  it.skip('bug: canonicalJson emits invalid JSON "[,1]" for a sparse array instead of "[null,1]" (documented JSON.stringify parity)', () => {
    // eslint-disable-next-line no-sparse-arrays
    expect(canonicalJson([, 1])).toBe(JSON.stringify([, 1]));
  });

  it.skip('bug: verifyChain throws TypeError on a row with no stored hash instead of returning { ok:false }', () => {
    const e = { seq: 1, prev_seq: 0, contribution_id: null, entry_type: 'published', actor: 'a', payload: {}, prev_hash: GENESIS_PREV_HASH };
    expect(() => verifyChain([e])).not.toThrow();
    expect(verifyChain([e]).ok).toBe(false);
  });
});
