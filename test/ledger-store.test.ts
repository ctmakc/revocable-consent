// The DB-facing half of ledger.ts (append with race retry, full and tail
// verification, legacy vocabulary) driven through a fake `query` function.
// No database, no network.
import { describe, it, expect } from 'vitest';
import {
  appendLedgerEntry,
  verifyLedger,
  verifyLedgerTail,
  publicEntryType,
  LEDGER_ENTRY_TYPES,
  GENESIS_PREV_HASH,
  GENESIS_PREV_SEQ,
  type QueryFn,
  type AppendInput,
} from '../src/ledger';
import { canonicalJson, computeEntryHash, verifyChain } from '../src/ledger-core.mjs';

const INPUT: AppendInput = {
  contribution_id: '00000000-0000-4000-8000-000000000001',
  entry_type: 'published',
  actor: 'operator',
  payload: { title: 'Song', collection: 'demo', scope_uses: ['public-display'] },
};

/**
 * In-memory ledger table. `beforeInsert` lets a test inject a racing writer or
 * a driver error on a given attempt. Rows come back with seq as a STRING, the
 * way node-postgres returns bigint.
 */
function fakeDb(
  opts: {
    beforeInsert?: (attempt: number, rows: any[]) => void;
    insertReturnsNothing?: boolean;
  } = {}
) {
  const rows: any[] = [];
  const queries: string[] = [];
  let seq = 0;
  let attempt = 0;
  const insertRaw = (r: Omit<any, 'seq' | 'id'>) => {
    if (rows.some((x) => Number(x.prev_seq) === Number(r.prev_seq))) {
      const err: any = new Error('duplicate key value violates unique constraint "ledger_entries_prev_seq_key"');
      err.code = '23505';
      throw err;
    }
    seq += 1;
    const row = { id: `id-${seq}`, seq: String(seq), created_at: new Date(0).toISOString(), ...r };
    rows.push(row);
    return row;
  };
  const q: QueryFn = (async (text: string, params: unknown[] = []) => {
    queries.push(text.trim().split(/\s+/).slice(0, 2).join(' '));
    if (text.startsWith('SELECT seq, hash FROM ledger_entries')) {
      const tail = rows[rows.length - 1];
      return tail ? [{ seq: tail.seq, hash: tail.hash }] : [];
    }
    if (text.startsWith('SELECT seq, prev_seq')) {
      const sorted = [...rows].sort((a, b) => Number(a.seq) - Number(b.seq));
      return /DESC LIMIT 1/.test(text) ? sorted.slice(-1) : sorted;
    }
    if (text.startsWith('INSERT INTO ledger_entries')) {
      opts.beforeInsert?.(attempt++, rows);
      if (opts.insertReturnsNothing) return [];
      const [prev_seq, contribution_id, entry_type, actor, payloadJson, prev_hash, hash] = params as any[];
      return [
        insertRaw({
          prev_seq: String(prev_seq),
          contribution_id,
          entry_type,
          actor,
          payload: JSON.parse(payloadJson),
          prev_hash,
          hash,
        }),
      ];
    }
    throw new Error(`unexpected query: ${text}`);
  }) as QueryFn;

  /** Simulate another writer appending a valid entry behind our back. */
  const racingAppend = () => {
    const tail = rows[rows.length - 1];
    const entry = {
      prev_seq: tail ? tail.seq : String(GENESIS_PREV_SEQ),
      contribution_id: null,
      entry_type: 'withdrawn',
      actor: 'other-writer',
      payload: { title: 'raced' },
      prev_hash: tail ? tail.hash : GENESIS_PREV_HASH,
    };
    insertRaw({ ...entry, hash: computeEntryHash(entry) });
  };

  return { q, rows, queries, racingAppend };
}

describe('publicEntryType (legacy vocabulary mapped at read time)', () => {
  it('maps the legacy spellings to the current vocabulary', () => {
    expect(publicEntryType('mint')).toBe('published');
    expect(publicEntryType('withdraw')).toBe('withdrawn');
  });

  it('passes the current vocabulary through unchanged', () => {
    for (const t of LEDGER_ENTRY_TYPES) expect(publicEntryType(t)).toBe(t);
  });

  it('passes unknown values through rather than inventing a mapping', () => {
    expect(publicEntryType('something_else')).toBe('something_else');
    expect(publicEntryType('')).toBe('');
  });

  it.skip('bug: publicEntryType leaks Object.prototype members ("toString", "constructor") as functions instead of returning the string', () => {
    // LEGACY_ENTRY_TYPE is a plain object literal, so `LEGACY_ENTRY_TYPE[t] ?? t`
    // finds inherited members. The DB CHECK constraint keeps such values out of
    // ledger_entries, but the exported function is typed `=> string` and a
    // caller mapping arbitrary input gets a function back.
    expect(publicEntryType('toString')).toBe('toString');
    expect(publicEntryType('constructor')).toBe('constructor');
    expect(publicEntryType('__proto__')).toBe('__proto__');
  });

  it('the shipped vocabulary is exactly the four documented entry types', () => {
    expect([...LEDGER_ENTRY_TYPES].sort()).toEqual(
      ['consent_revoked', 'media_deleted', 'published', 'withdrawn'].sort()
    );
  });

  it('a legacy-spelled entry still verifies: the hash commits to the stored bytes', () => {
    const entry = {
      seq: 1,
      prev_seq: 0,
      contribution_id: null,
      entry_type: 'mint',
      actor: 'admin',
      payload: { title: 'old' },
      prev_hash: GENESIS_PREV_HASH,
    };
    const row = { ...entry, hash: computeEntryHash(entry) };
    expect(verifyChain([row]).ok).toBe(true);
    // ...and renaming it in place (an UPDATE) is detected as tampering
    expect(verifyChain([{ ...row, entry_type: publicEntryType('mint') }]).ok).toBe(false);
  });
});

describe('appendLedgerEntry', () => {
  it('links the first entry to genesis', async () => {
    const { q, rows } = fakeDb();
    const row = await appendLedgerEntry(q, INPUT);
    expect(Number(row.prev_seq)).toBe(GENESIS_PREV_SEQ);
    expect(row.prev_hash).toBe(GENESIS_PREV_HASH);
    expect(row.hash).toBe(computeEntryHash({ ...INPUT, prev_hash: GENESIS_PREV_HASH }));
    expect(verifyChain(rows)).toEqual({ ok: true, count: 1 });
  });

  it('links each entry to the current tail, including bigint-as-string seq', async () => {
    const { q, rows } = fakeDb();
    const a = await appendLedgerEntry(q, INPUT);
    const b = await appendLedgerEntry(q, { ...INPUT, entry_type: 'withdrawn' });
    expect(typeof a.seq).toBe('string');
    expect(Number(b.prev_seq)).toBe(Number(a.seq));
    expect(b.prev_hash).toBe(a.hash);
    expect(verifyChain(rows)).toEqual({ ok: true, count: 2 });
  });

  it('retries against the fresh tail after losing a race (UNIQUE prev_seq)', async () => {
    const db = fakeDb({
      beforeInsert: (attempt) => {
        if (attempt === 0) db.racingAppend(); // another writer wins the first attempt
      },
    });
    const row = await appendLedgerEntry(db.q, INPUT);
    expect(db.rows).toHaveLength(2);
    expect(db.rows[0].actor).toBe('other-writer');
    expect(row.prev_hash).toBe(db.rows[0].hash);
    expect(verifyChain(db.rows)).toEqual({ ok: true, count: 2 });
    // tail read twice: once per attempt
    expect(db.queries.filter((x) => x === 'SELECT seq,')).toHaveLength(2);
  });

  it('gives up after three lost races with an explanatory error', async () => {
    const db = fakeDb({ beforeInsert: () => db.racingAppend() });
    await expect(appendLedgerEntry(db.q, INPUT)).rejects.toThrow(
      /lost the race 3 times: duplicate key value/
    );
    expect(db.rows.every((r) => r.actor === 'other-writer')).toBe(true);
    expect(verifyChain(db.rows).ok).toBe(true);
  });

  it('recognises a unique violation by message when the driver gives no code', async () => {
    let calls = 0;
    const db = fakeDb({
      beforeInsert: () => {
        calls += 1;
        if (calls === 1) throw new Error('ERROR: Duplicate Key Value violates unique constraint');
      },
    });
    await appendLedgerEntry(db.q, INPUT);
    expect(calls).toBe(2);
    expect(db.rows).toHaveLength(1);
  });

  it('does NOT retry other database errors', async () => {
    let calls = 0;
    const db = fakeDb({
      beforeInsert: () => {
        calls += 1;
        const err: any = new Error('new row violates check constraint');
        err.code = '23514';
        throw err;
      },
    });
    await expect(appendLedgerEntry(db.q, INPUT)).rejects.toThrow(/check constraint/);
    expect(calls).toBe(1);
  });

  it('fails loudly when the INSERT returns no row', async () => {
    const { q } = fakeDb({ insertReturnsNothing: true });
    await expect(appendLedgerEntry(q, INPUT)).rejects.toThrow(/returned no row/);
  });

  it('rejects a cyclic payload before touching the database', async () => {
    const { q, queries } = fakeDb();
    const payload: any = { title: 'loop' };
    payload.self = payload;
    await expect(appendLedgerEntry(q, { ...INPUT, payload })).rejects.toThrow();
    expect(queries).toEqual([]);
  });

  it('drops undefined payload fields before hashing, so the stored row re-verifies', async () => {
    const { q, rows } = fakeDb();
    await appendLedgerEntry(q, { ...INPUT, payload: { title: 'x', licence: undefined } });
    expect(rows[0].payload).toEqual({ title: 'x' });
    expect(verifyChain(rows).ok).toBe(true);
  });

  it('sends the same normalised payload JSON it hashed', async () => {
    let sent: string | undefined;
    const db = fakeDb({
      beforeInsert: () => {},
    });
    const spy: QueryFn = (async (text: string, params?: unknown[]) => {
      if (text.startsWith('INSERT')) sent = (params as string[])[4];
      return db.q(text, params);
    }) as QueryFn;
    const row = await appendLedgerEntry(spy, {
      ...INPUT,
      payload: { b: 1, a: new Date('2026-01-01T00:00:00Z') } as any,
    });
    expect(JSON.parse(sent!)).toEqual({ b: 1, a: '2026-01-01T00:00:00.000Z' });
    expect(row.hash).toBe(
      computeEntryHash({ ...INPUT, payload: JSON.parse(sent!), prev_hash: GENESIS_PREV_HASH })
    );
  });
});

describe('verifyLedger / verifyLedgerTail', () => {
  async function seeded(n: number) {
    const db = fakeDb();
    for (let i = 0; i < n; i++) {
      await appendLedgerEntry(db.q, { ...INPUT, payload: { title: `Item ${i}` } });
    }
    return db;
  }

  it('an empty ledger is valid for both checks', async () => {
    const { q } = fakeDb();
    expect(await verifyLedger(q)).toEqual({ ok: true, count: 0 });
    expect(await verifyLedgerTail(q)).toEqual({ ok: true, count: 0 });
  });

  it('accepts an intact chain', async () => {
    const { q } = await seeded(4);
    expect(await verifyLedger(q)).toEqual({ ok: true, count: 4 });
    expect(await verifyLedgerTail(q)).toEqual({ ok: true, count: 1 });
  });

  it('the full check catches a rewrite of an early entry', async () => {
    const { q, rows } = await seeded(3);
    rows[0].payload = { title: 'REWRITTEN' };
    const r = await verifyLedger(q);
    expect(r.ok).toBe(false);
    expect(r.seq).toBe(1);
    expect(r.error).toMatch(/hash mismatch/);
  });

  it('the tail check is cheap: it only sees the last entry', async () => {
    const { q, rows } = await seeded(3);
    rows[0].payload = { title: 'REWRITTEN' };
    // documented trade-off: an early rewrite is invisible to the tail check
    expect(await verifyLedgerTail(q)).toEqual({ ok: true, count: 1 });
    rows[2].actor = 'someone-else';
    expect(await verifyLedgerTail(q)).toEqual({
      ok: false,
      count: 1,
      seq: 3,
      error: 'tail entry hash mismatch',
    });
  });
});

describe('canonicalJson / verifyChain edge cases', () => {
  it('treats a missing contribution_id the same as null when hashing', () => {
    const base = { entry_type: 'published', actor: 'a', payload: {}, prev_hash: 'GENESIS' };
    expect(computeEntryHash({ ...base, contribution_id: null })).toBe(
      computeEntryHash({ ...base, contribution_id: undefined })
    );
  });

  it('accepts seq/prev_seq as strings (bigint from the driver)', () => {
    const e1 = { prev_seq: '0', contribution_id: null, entry_type: 'published', actor: 'a', payload: {}, prev_hash: GENESIS_PREV_HASH };
    const r1 = { seq: '7', ...e1, hash: computeEntryHash(e1) };
    const e2 = { prev_seq: '7', contribution_id: null, entry_type: 'withdrawn', actor: 'a', payload: {}, prev_hash: r1.hash };
    const r2 = { seq: '9', ...e2, hash: computeEntryHash(e2) };
    expect(verifyChain([r1, r2])).toEqual({ ok: true, count: 2 });
  });

  it('reports a prev_seq that skips its predecessor', () => {
    const e1 = { seq: 1, prev_seq: 0, contribution_id: null, entry_type: 'published', actor: 'a', payload: {}, prev_hash: GENESIS_PREV_HASH };
    const r1 = { ...e1, hash: computeEntryHash(e1) };
    const e2 = { seq: 2, prev_seq: 5, contribution_id: null, entry_type: 'published', actor: 'a', payload: {}, prev_hash: r1.hash };
    const r = verifyChain([r1, { ...e2, hash: computeEntryHash(e2) }]);
    expect(r).toMatchObject({ ok: false, seq: 2 });
    expect(r.error).toMatch(/does not link to predecessor seq=1/);
  });

  it('rejects a genesis entry with a non-GENESIS prev_hash', () => {
    const e = { seq: 1, prev_seq: 0, contribution_id: null, entry_type: 'published', actor: 'a', payload: {}, prev_hash: 'abc' };
    const r = verifyChain([{ ...e, hash: computeEntryHash(e) }]);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/expected GENESIS/);
  });

  it('canonical key order is by UTF-16 code unit (uppercase before lowercase)', () => {
    expect(canonicalJson({ b: 1, B: 2, a: 3, _: 4 })).toBe('{"B":2,"_":4,"a":3,"b":1}');
  });

  it('rejects a symbol value nested in an object', () => {
    expect(() => canonicalJson({ s: Symbol('x') })).toThrow(/symbol/);
  });

  it('refuses undefined at the top level', () => {
    expect(() => canonicalJson(undefined)).toThrow(/top level/);
  });

  it.skip('bug: canonicalJson emits invalid JSON for sparse arrays ("[1,,2]") instead of nulling the hole like JSON.stringify', () => {
    // eslint-disable-next-line no-sparse-arrays
    const sparse = [1, , 2];
    expect(canonicalJson(sparse)).toBe('[1,null,2]');
  });

  it.skip('bug: verifyChain throws a TypeError on a row with no `hash` instead of returning { ok: false }', () => {
    const row = { seq: 1, prev_seq: 0, contribution_id: null, entry_type: 'published', actor: 'a', payload: {}, prev_hash: GENESIS_PREV_HASH };
    expect(() => verifyChain([row])).not.toThrow();
    expect(verifyChain([row])).toMatchObject({ ok: false, seq: 1 });
  });
});
