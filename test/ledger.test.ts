import { describe, it, expect } from 'vitest';
import {
  canonicalJson,
  computeEntryHash,
  verifyChain,
  GENESIS_PREV_HASH,
  GENESIS_PREV_SEQ,
} from '../src/ledger-core.mjs';
import { appendLedgerEntry, type QueryFn } from '../src/ledger';

describe('canonicalJson', () => {
  it('sorts object keys recursively', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalJson({ z: { d: 1, c: [{ y: 1, x: 2 }] }, a: 'v' })).toBe(
      '{"a":"v","z":{"c":[{"x":2,"y":1}],"d":1}}'
    );
  });

  it('is stable regardless of key insertion order', () => {
    const one = { title: 'Song', collection: 'lanark-oral-history', scope_uses: ['research'] };
    const two = { scope_uses: ['research'], collection: 'lanark-oral-history', title: 'Song' };
    expect(canonicalJson(one)).toBe(canonicalJson(two));
  });

  it('preserves array order (arrays are ordered data)', () => {
    expect(canonicalJson([2, 1])).toBe('[2,1]');
    expect(canonicalJson([2, 1])).not.toBe(canonicalJson([1, 2]));
  });

  it('handles primitives, null and unicode strings like JSON', () => {
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson(true)).toBe('true');
    expect(canonicalJson(3.14)).toBe('3.14');
    expect(canonicalJson('ünïcode "quoted"')).toBe(JSON.stringify('ünïcode "quoted"'));
  });

  it('drops undefined object values and nullifies undefined array slots (JSON.stringify parity)', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
    expect(canonicalJson([1, undefined, 2])).toBe('[1,null,2]');
  });

  it('rejects non-JSON data (NaN, Infinity, functions, bigint)', () => {
    expect(() => canonicalJson({ n: NaN })).toThrow();
    expect(() => canonicalJson({ n: Infinity })).toThrow();
    expect(() => canonicalJson({ f: () => 1 })).toThrow();
    expect(() => canonicalJson({ b: 1n })).toThrow();
  });
});

// ---- chain helpers for verifyChain tests ----

interface FakeEntry {
  seq: number;
  prev_seq: number;
  contribution_id: string | null;
  entry_type: string;
  actor: string;
  payload: Record<string, unknown>;
  prev_hash: string;
  hash: string;
}

function buildChain(specs: { entry_type: string; payload?: Record<string, unknown>; seqGap?: number }[]): FakeEntry[] {
  const rows: FakeEntry[] = [];
  let prevSeq = GENESIS_PREV_SEQ;
  let prevHash = GENESIS_PREV_HASH;
  let seq = 0;
  for (const s of specs) {
    seq += 1 + (s.seqGap ?? 0); // gaps are legal (lost-race inserts burn serials)
    const entry = {
      seq,
      prev_seq: prevSeq,
      contribution_id: '00000000-0000-4000-8000-000000000001',
      entry_type: s.entry_type,
      actor: 'admin',
      payload: s.payload ?? { title: 'T', collection: 'lanark-oral-history' },
      prev_hash: prevHash,
    };
    const hash = computeEntryHash(entry);
    rows.push({ ...entry, hash });
    prevSeq = seq;
    prevHash = hash;
  }
  return rows;
}

describe('computeEntryHash', () => {
  it('is deterministic and seq-independent', () => {
    const base = {
      entry_type: 'published',
      contribution_id: 'abc',
      actor: 'admin',
      payload: { title: 'Song', scope_uses: ['research'] },
      prev_hash: GENESIS_PREV_HASH,
    };
    expect(computeEntryHash(base)).toBe(computeEntryHash({ ...base }));
    expect(computeEntryHash(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when any input changes', () => {
    const base = {
      entry_type: 'published',
      contribution_id: 'abc',
      actor: 'admin',
      payload: { title: 'Song' },
      prev_hash: 'h1',
    };
    const h = computeEntryHash(base);
    expect(computeEntryHash({ ...base, entry_type: 'withdrawn' })).not.toBe(h);
    expect(computeEntryHash({ ...base, actor: 'other' })).not.toBe(h);
    expect(computeEntryHash({ ...base, payload: { title: 'Song!' } })).not.toBe(h);
    expect(computeEntryHash({ ...base, prev_hash: 'h2' })).not.toBe(h);
  });
});

describe('verifyChain', () => {
  it('accepts an empty ledger', () => {
    expect(verifyChain([])).toEqual({ ok: true, count: 0 });
  });

  it('accepts a valid chain from genesis', () => {
    const rows = buildChain([
      { entry_type: 'published' },
      { entry_type: 'withdrawn' },
      { entry_type: 'consent_revoked' },
    ]);
    expect(verifyChain(rows)).toEqual({ ok: true, count: 3 });
  });

  it('accepts seq GAPS as long as prev_seq linkage holds (lost races burn serials)', () => {
    const rows = buildChain([{ entry_type: 'published' }, { entry_type: 'published', seqGap: 4 }]);
    expect(rows[1].seq - rows[0].seq).toBeGreaterThan(1);
    expect(verifyChain(rows).ok).toBe(true);
  });

  it('detects a tampered payload (hash recomputation fails)', () => {
    const rows = buildChain([{ entry_type: 'published' }, { entry_type: 'published' }]);
    rows[0].payload = { title: 'REWRITTEN HISTORY', collection: 'lanark-oral-history' };
    const r = verifyChain(rows);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/hash mismatch/);
  });

  it('detects a broken hash link (entry replaced wholesale)', () => {
    const rows = buildChain([{ entry_type: 'published' }, { entry_type: 'published' }]);
    // Recompute row 0 with different content — internally consistent, but row 1 no longer links to it.
    const replaced = { ...rows[0], payload: { title: 'X' } };
    replaced.hash = computeEntryHash(replaced);
    const r = verifyChain([replaced, rows[1]]);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/prev_hash/);
  });

  it('detects a DELETED middle entry (linkage break)', () => {
    const rows = buildChain([{ entry_type: 'published' }, { entry_type: 'published' }, { entry_type: 'published' }]);
    const r = verifyChain([rows[0], rows[2]]); // middle removed
    expect(r.ok).toBe(false);
  });

  it('remains valid when only TAIL entries are deleted', () => {
    const rows = buildChain([{ entry_type: 'published' }, { entry_type: 'published' }, { entry_type: 'published' }]);
    expect(verifyChain(rows.slice(0, 2)).ok).toBe(true);
    expect(verifyChain(rows.slice(0, 1)).ok).toBe(true);
  });

  it('rejects a chain whose first entry is not genesis-linked', () => {
    const rows = buildChain([{ entry_type: 'published' }, { entry_type: 'published' }]);
    const r = verifyChain([rows[1]]); // starts mid-chain
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/genesis/);
  });
});

describe('appendLedgerEntry payload normalisation (stored value === hashed value)', () => {
  // In-memory ledger table: enough SQL understanding for appendLedgerEntry,
  // storing the payload through a JSON round trip exactly like jsonb does.
  function fakeLedgerDb() {
    const rows: any[] = [];
    let seq = 0;
    const q: QueryFn = (async (text: string, params: unknown[] = []) => {
      if (text.startsWith('SELECT seq, hash FROM ledger_entries')) {
        const tail = rows[rows.length - 1];
        return tail ? [{ seq: String(tail.seq), hash: tail.hash }] : [];
      }
      if (text.startsWith('INSERT INTO ledger_entries')) {
        const [prev_seq, contribution_id, entry_type, actor, payloadJson, prev_hash, hash] = params;
        if (rows.some((r) => Number(r.prev_seq) === Number(prev_seq))) {
          const err: any = new Error('duplicate key value violates unique constraint');
          err.code = '23505';
          throw err;
        }
        seq += 1;
        const row = {
          id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
          seq,
          prev_seq: Number(prev_seq),
          contribution_id,
          entry_type,
          actor,
          payload: JSON.parse(payloadJson as string), // jsonb round trip
          prev_hash,
          hash,
          created_at: new Date(0).toISOString(),
        };
        rows.push(row);
        return [row];
      }
      throw new Error(`unexpected query: ${text}`);
    }) as QueryFn;
    return { q, rows };
  }

  it('a payload with toJSON values (e.g. Date) still re-verifies from the stored row', async () => {
    const { q, rows } = fakeLedgerDb();
    await appendLedgerEntry(q, {
      contribution_id: null,
      entry_type: 'published',
      actor: 'admin',
      // Date has toJSON: JSON.stringify emits an ISO string while canonicalJson
      // would have seen '{}' — the normalisation must make both sides agree.
      payload: { title: 'Song', recorded: new Date('2026-01-01T00:00:00Z') } as any,
    });
    expect(rows[0].payload.recorded).toBe('2026-01-01T00:00:00.000Z');
    // the stored row (as verifyLedger would read it back) must re-verify
    expect(verifyChain(rows)).toEqual({ ok: true, count: 1 });
  });

  it('normal string/array payloads are unchanged and chain across appends', async () => {
    const { q, rows } = fakeLedgerDb();
    await appendLedgerEntry(q, {
      contribution_id: null,
      entry_type: 'published',
      actor: 'admin',
      payload: { title: 'Song', collection: 'lanark-oral-history', scope_uses: ['research'] },
    });
    await appendLedgerEntry(q, {
      contribution_id: null,
      entry_type: 'withdrawn',
      actor: 'admin',
      payload: { title: 'Song', collection: 'lanark-oral-history', scope_uses: ['research'] },
    });
    expect(rows[1].prev_hash).toBe(rows[0].hash);
    expect(verifyChain(rows)).toEqual({ ok: true, count: 2 });
  });
});
