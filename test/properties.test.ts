// Property-based tests for the invariants the library exists to keep.
// Everything is in memory: no network, no database, no keys.
import { describe, it, expect, afterEach } from 'vitest';
import fc from 'fast-check';
import {
  BUILTIN_SCOPE_USES,
  consentContext,
  effectiveScope,
  isScopeNarrowing,
  scopeAllows,
} from '../src/consent';
import {
  ACTIONS,
  STATUSES,
  consentStands,
  isPubliclyVisible,
  transition,
  type Action,
  type ConsentContext,
  type Status,
} from '../src/moderation';
import { canServeMediaPublicly } from '../src/media-access';
import { mintSignedUrl, verifySignedUrl } from '../src/signed-url';
import { receiptHash, revokeConsent, type RevocationPorts } from '../src/revocation';
import { FailingDeleteAdapter, MemoryStorageAdapter, type StorageAdapter } from '../src/storage';
import { appendLedgerEntry, type QueryFn } from '../src/ledger';
import {
  canonicalJson,
  computeEntryHash,
  verifyChain,
  GENESIS_PREV_HASH,
  GENESIS_PREV_SEQ,
} from '../src/ledger-core.mjs';

const arbStatus = fc.constantFrom<Status>(...STATUSES);
const arbAction = fc.constantFrom<Action>(...ACTIONS);
const arbCtx = fc.record<ConsentContext>({ hasConsent: fc.boolean(), consentRevoked: fc.boolean() });
const arbUse = fc.oneof(fc.constantFrom(...BUILTIN_SCOPE_USES), fc.string({ maxLength: 12 }));
const arbRecord = fc.record({
  revoked: fc.boolean(),
  scope_uses: fc.array(arbUse, { maxLength: 6 }),
});

// ---------------------------------------------------------------------------
describe('consent scope evaluation', () => {
  it('scopeAllows is true exactly for a granted use on a standing record', () => {
    fc.assert(
      fc.property(arbRecord, arbUse, (rec, use) => {
        expect(scopeAllows(rec, use)).toBe(!rec.revoked && rec.scope_uses.includes(use));
      })
    );
  });

  it('scopeAllows never grants on null, undefined or a non-array scope', () => {
    for (const use of BUILTIN_SCOPE_USES) {
      expect(scopeAllows(null, use)).toBe(false);
      expect(scopeAllows(undefined, use)).toBe(false);
      expect(scopeAllows({ revoked: false, scope_uses: 'public-display' as never }, use)).toBe(false);
      expect(scopeAllows({ revoked: false, scope_uses: [] }, use)).toBe(false);
    }
  });

  it('scope matching is exact: no case folding, no prefix match', () => {
    const rec = { revoked: false, scope_uses: ['public-display'] };
    expect(scopeAllows(rec, 'Public-Display')).toBe(false);
    expect(scopeAllows(rec, 'public')).toBe(false);
    expect(scopeAllows(rec, 'public-display ')).toBe(false);
  });

  it('machine-processing is opt-in: granting everything else never implies it', () => {
    const rec = { revoked: false, scope_uses: ['public-display', 'research', 'education'] };
    expect(scopeAllows(rec, 'machine-processing')).toBe(false);
  });

  it('effectiveScope is empty as soon as any record is revoked', () => {
    fc.assert(
      fc.property(fc.array(arbRecord, { maxLength: 6 }), (recs) => {
        const scope = effectiveScope(recs);
        if (recs.some((r) => r.revoked)) expect(scope).toEqual([]);
        else {
          // deduplicated union of the standing records, first-seen order
          const expected = [...new Set(recs.flatMap((r) => r.scope_uses))];
          expect(scope).toEqual(expected);
        }
      })
    );
  });

  it('consentContext: one revoked record revokes the item (not a majority vote)', () => {
    fc.assert(
      fc.property(fc.array(fc.record({ revoked: fc.boolean() }), { maxLength: 8 }), (recs) => {
        const ctx = consentContext(recs);
        expect(ctx.hasConsent).toBe(recs.length > 0);
        expect(ctx.consentRevoked).toBe(recs.some((r) => r.revoked));
        // the reduced context can only stand when NO record is revoked
        if (consentStands(ctx)) expect(recs.every((r) => !r.revoked)).toBe(true);
      })
    );
  });

  it('isScopeNarrowing: a subset is narrowing, adding any new use is widening', () => {
    fc.assert(
      fc.property(fc.array(arbUse, { maxLength: 6 }), fc.array(fc.boolean(), { maxLength: 6 }), (before, keep) => {
        const after = before.filter((_, i) => keep[i] ?? false);
        expect(isScopeNarrowing(before, after)).toBe(true);
        const fresh = `new-${before.join('|')}`;
        expect(isScopeNarrowing(before, [...after, fresh])).toBe(false);
      })
    );
  });
});

// ---------------------------------------------------------------------------
describe('publish state machine', () => {
  // The complete set of legal (status, action) → next transitions when consent
  // stands. Everything not listed must be refused. 'note' and 'revoke_consent'
  // are checked separately.
  const LEGAL: Record<string, Status> = {
    'submitted:review_start': 'in_review',
    'submitted:request_consent': 'needs_consent',
    'in_review:request_consent': 'needs_consent',
    'in_review:approve': 'approved',
    'needs_consent:approve': 'approved',
    'submitted:reject': 'rejected',
    'in_review:reject': 'rejected',
    'needs_consent:reject': 'rejected',
    'approved:publish': 'published',
    'submitted:withdraw': 'withdrawn',
    'in_review:withdraw': 'withdrawn',
    'needs_consent:withdraw': 'withdrawn',
    'approved:withdraw': 'withdrawn',
    'published:withdraw': 'withdrawn',
  };
  const standing = { hasConsent: true, consentRevoked: false };

  it('exhaustive table: exactly the legal transitions succeed while consent stands', () => {
    for (const s of STATUSES) {
      for (const a of ACTIONS) {
        if (a === 'note' || a === 'revoke_consent') continue;
        const r = transition(s, a, standing);
        const want = LEGAL[`${s}:${a}`];
        if (want) expect(r, `${s} --${a}-->`).toEqual({ ok: true, next: want });
        else expect(r.ok, `${s} --${a}--> must be refused`).toBe(false);
      }
    }
  });

  it('a refused transition always carries an error message', () => {
    fc.assert(
      fc.property(arbStatus, arbAction, arbCtx, (s, a, ctx) => {
        const r = transition(s, a, ctx);
        if (!r.ok) expect(r.error.length).toBeGreaterThan(0);
        else expect(STATUSES).toContain(r.next);
      })
    );
  });

  it('approve and publish are never allowed without standing consent', () => {
    fc.assert(
      fc.property(arbStatus, arbCtx, (s, ctx) => {
        fc.pre(!consentStands(ctx));
        expect(transition(s, 'approve', ctx).ok).toBe(false);
        expect(transition(s, 'publish', ctx).ok).toBe(false);
      })
    );
  });

  it('terminal states accept nothing but note and revoke_consent', () => {
    fc.assert(
      fc.property(fc.constantFrom<Status>('rejected', 'withdrawn'), arbAction, arbCtx, (s, a, ctx) => {
        fc.pre(a !== 'note' && a !== 'revoke_consent');
        expect(transition(s, a, ctx).ok).toBe(false);
      })
    );
  });

  it('unknown statuses and actions are refused, never coerced', () => {
    expect(transition('live' as Status, 'publish', standing).ok).toBe(false);
    expect(transition('approved', 'force_publish' as Action, standing).ok).toBe(false);
    expect(transition('approved', 'note' as Action, standing)).toEqual({ ok: true, next: 'approved' });
  });

  it('property: no action sequence ever makes an item visible without standing consent', () => {
    // Drive the machine with random actions and random consent changes; at
    // every step, public visibility implies consent stands, and once consent
    // is revoked the item never becomes visible again.
    const arbStep = fc.oneof(
      arbAction.map((a) => ({ kind: 'action' as const, a })),
      fc.constant({ kind: 'grant' as const }),
      fc.constant({ kind: 'revoke' as const })
    );
    fc.assert(
      fc.property(fc.array(arbStep, { maxLength: 40 }), (steps) => {
        let status: Status = 'submitted';
        let ctx: ConsentContext = { hasConsent: false, consentRevoked: false };
        let everRevoked = false;
        for (const step of steps) {
          if (step.kind === 'grant') {
            // granting happens only before any revocation; revocation is sticky
            if (!everRevoked) ctx = { hasConsent: true, consentRevoked: false };
          } else if (step.kind === 'revoke' || step.a === 'revoke_consent') {
            const r = transition(status, 'revoke_consent', ctx);
            if (r.ok) {
              status = r.next;
              ctx = { ...ctx, consentRevoked: true };
              everRevoked = true;
              expect(status).not.toBe('published');
            }
          } else {
            const r = transition(status, step.a, ctx);
            if (r.ok) status = r.next;
          }
          if (isPubliclyVisible(status, ctx)) expect(consentStands(ctx)).toBe(true);
          if (everRevoked) {
            expect(isPubliclyVisible(status, ctx)).toBe(false);
            expect(status).not.toBe('published');
          }
        }
      }),
      { numRuns: 500 }
    );
  });
});

// ---------------------------------------------------------------------------
describe('revocation propagation', () => {
  const SECRET = 'unit-test-only-secret';

  function world(status: Status, keys: string[], storageKind: 'ok' | 'failing') {
    const mem = new MemoryStorageAdapter();
    keys.forEach((k) => mem.put(k, `bytes:${k}`));
    const storage: StorageAdapter = storageKind === 'failing' ? new FailingDeleteAdapter(mem) : mem;
    const state = {
      status,
      consentRows: [{ revoked: false }],
      epoch: 0,
      ledger: [] as any[],
    };
    let seq = 0;
    const q: QueryFn = (async (text: string, params: unknown[] = []) => {
      if (text.startsWith('SELECT seq, hash')) {
        const t = state.ledger.at(-1);
        return t ? [{ seq: String(t.seq), hash: t.hash }] : [];
      }
      const [prev_seq, contribution_id, entry_type, actor, payload, prev_hash, hash] = params as any[];
      const row = { seq: ++seq, prev_seq, contribution_id, entry_type, actor, payload: JSON.parse(payload), prev_hash, hash };
      state.ledger.push(row);
      return [row];
    }) as QueryFn;
    const ports: RevocationPorts = {
      load: async () => ({
        contribution_id: 'c1',
        status: state.status,
        hasConsent: true,
        consentRevoked: state.consentRows.some((r) => r.revoked),
        objects: keys.map((key, i) => ({ asset_id: `a${i}`, key })),
      }),
      revokeConsentRecords: async () => {
        const n = state.consentRows.filter((r) => !r.revoked).length;
        state.consentRows.forEach((r) => (r.revoked = true));
        return n;
      },
      bumpRevocationEpoch: async () => ++state.epoch,
      setStatus: async (_id, from, to) => {
        if (state.status !== from) return false;
        state.status = to;
        return true;
      },
      readStatus: async () => state.status,
      appendLedger: (e) => appendLedgerEntry(q, e),
      storage,
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    };
    return { ports, state, mem };
  }

  it('property: after revocation nothing is served, from any state, whatever the store does', async () => {
    const keysArb = fc.uniqueArray(fc.stringMatching(/^media\/[a-z0-9]{1,8}$/), { maxLength: 4 });
    await fc.assert(
      fc.asyncProperty(arbStatus, keysArb, fc.constantFrom<'ok' | 'failing'>('ok', 'failing'), async (status, keys, kind) => {
        const { ports, state, mem } = world(status, keys, kind);
        const urls = keys.map((key) =>
          mintSignedUrl('https://archive.example/m', { key, epoch: state.epoch, ttlMs: 3_600_000 }, SECRET, 0)
        );
        const res = await revokeConsent(ports, 'c1');
        expect(res.ok).toBe(true);
        if (!res.ok) return;

        const ctx = consentContext(state.consentRows);
        // 1. every read gate says no
        expect(isPubliclyVisible(state.status, ctx)).toBe(false);
        expect(canServeMediaPublicly(state.status, ctx, ['public-display'])).toBe(false);
        expect(scopeAllows({ revoked: true, scope_uses: ['public-display'] }, 'public-display')).toBe(false);
        // 2. every URL handed out before the revocation is dead
        for (const u of urls) {
          expect(verifySignedUrl(u, SECRET, { currentEpoch: state.epoch, now: 1 })).toEqual({
            ok: false,
            reason: 'stale-epoch',
          });
        }
        // 3. the stored status is never left live
        expect(state.status).not.toBe('published');
        if (status === 'published') expect(state.status).toBe('withdrawn');
        expect(res.receipt.status).toBe(state.status);
        // 4. complete ⇔ every object really is gone
        const remaining = keys.filter((k) => mem.keys().includes(k));
        expect(res.receipt.complete).toBe(remaining.length === 0);
        // 5. the receipt hash and the chain both verify
        const { hash, ...rest } = res.receipt;
        expect(receiptHash(rest)).toBe(hash);
        expect(verifyChain(state.ledger).ok).toBe(true);
        expect(state.ledger[0].payload.receipt_hash).toBe(hash);
        // 6. a second revocation refuses instead of writing a second receipt
        const again = await revokeConsent(ports, 'c1');
        expect(again.ok).toBe(false);
        expect(state.ledger).toHaveLength(1);
      }),
      { numRuns: 150 }
    );
  });

  it('a concurrent revocation that wins the compare-and-set leaves the loser with nothing to do', async () => {
    const { ports, state } = world('published', ['media/a'], 'ok');
    const losing: RevocationPorts = { ...ports, revokeConsentRecords: async () => 0 };
    const res = await revokeConsent(losing, 'c1');
    expect(res).toEqual({ ok: false, error: 'consent was already revoked by a concurrent action' });
    expect(state.epoch).toBe(0);
    expect(state.ledger).toHaveLength(0);
  });

  it('an item with no consent record cannot be "revoked"', async () => {
    const { ports } = world('submitted', [], 'ok');
    const none: RevocationPorts = {
      ...ports,
      load: async () => ({ contribution_id: 'c1', status: 'submitted', hasConsent: false, consentRevoked: false, objects: [] }),
    };
    expect(await revokeConsent(none, 'c1')).toEqual({ ok: false, error: 'there is no consent record to revoke' });
    expect(await revokeConsent({ ...ports, load: async () => null }, 'missing')).toEqual({
      ok: false,
      error: 'no such contribution',
    });
  });
});

// ---------------------------------------------------------------------------
describe('audit log integrity', () => {
  const arbJson = fc.jsonValue({ maxDepth: 3 }).filter((v) => v !== null && typeof v === 'object');

  function chainOf(payloads: unknown[]) {
    const rows: any[] = [];
    let prev_seq = GENESIS_PREV_SEQ;
    let prev_hash = GENESIS_PREV_HASH;
    payloads.forEach((payload, i) => {
      const e = { seq: i + 1, prev_seq, contribution_id: `c${i}`, entry_type: 'published', actor: 'op', payload, prev_hash };
      const hash = computeEntryHash(e as never);
      rows.push({ ...e, hash });
      prev_seq = i + 1;
      prev_hash = hash;
    });
    return rows;
  }

  it('canonicalJson is independent of key insertion order and round-trips through JSON', () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string(), fc.jsonValue({ maxDepth: 2 })), (obj) => {
        const reversed = Object.fromEntries(Object.entries(obj).reverse());
        expect(canonicalJson(reversed)).toBe(canonicalJson(obj));
        // what a jsonb store hands back must hash the same as what was written
        expect(canonicalJson(JSON.parse(JSON.stringify(obj)))).toBe(canonicalJson(obj));
      })
    );
  });

  it('canonicalJson rejects values a ledger payload cannot hold', () => {
    expect(() => canonicalJson({ a: NaN })).toThrow();
    expect(() => canonicalJson({ a: Infinity })).toThrow();
    expect(() => canonicalJson({ a: 1n })).toThrow();
    expect(() => canonicalJson({ a: () => 1 })).toThrow();
    expect(() => canonicalJson(undefined)).toThrow();
  });

  it('property: a valid chain verifies; changing any field of any entry is detected', () => {
    const fields = ['entry_type', 'contribution_id', 'actor', 'payload', 'prev_hash', 'hash', 'prev_seq'] as const;
    fc.assert(
      fc.property(
        fc.array(arbJson, { minLength: 1, maxLength: 6 }),
        fc.nat(),
        fc.constantFrom(...fields),
        (payloads, idx, field) => {
          const rows = chainOf(payloads);
          expect(verifyChain(rows)).toEqual({ ok: true, count: rows.length });
          const i = idx % rows.length;
          const tampered = rows.map((r) => ({ ...r }));
          const r = tampered[i];
          if (field === 'payload') r.payload = { ...(r.payload as object), __tampered: true };
          else if (field === 'prev_seq') r.prev_seq = Number(r.prev_seq) + 100;
          else r[field] = `${r[field]}x`;
          expect(verifyChain(tampered).ok).toBe(false);
        }
      ),
      { numRuns: 300 }
    );
  });

  it('property: deleting or reordering an entry in the middle is detected', () => {
    fc.assert(
      fc.property(fc.array(arbJson, { minLength: 3, maxLength: 6 }), fc.nat(), (payloads, idx) => {
        const rows = chainOf(payloads);
        const i = 1 + (idx % (rows.length - 2)); // strictly inside the chain
        expect(verifyChain([...rows.slice(0, i), ...rows.slice(i + 1)]).ok).toBe(false);
        const swapped = [...rows];
        [swapped[i], swapped[i + 1]] = [swapped[i + 1], swapped[i]];
        expect(verifyChain(swapped).ok).toBe(false);
      })
    );
  });

  it('appendLedgerEntry stores exactly the bytes it hashed, even for Date payloads', async () => {
    const stored: any[] = [];
    const q: QueryFn = (async (text: string, params: unknown[] = []) => {
      if (text.startsWith('SELECT')) {
        const t = stored.at(-1);
        return t ? [{ seq: String(t.seq), hash: t.hash }] : [];
      }
      const [prev_seq, contribution_id, entry_type, actor, payload, prev_hash, hash] = params as any[];
      const row = { seq: stored.length + 1, prev_seq, contribution_id, entry_type, actor, payload: JSON.parse(payload), prev_hash, hash };
      stored.push(row);
      return [row];
    }) as QueryFn;
    await appendLedgerEntry(q, { contribution_id: 'c', entry_type: 'published', actor: 'op', payload: { at: new Date(0) as never } });
    await appendLedgerEntry(q, { contribution_id: null, entry_type: 'withdrawn', actor: 'op', payload: { n: 1, u: undefined } });
    expect(stored[0].payload).toEqual({ at: '1970-01-01T00:00:00.000Z' });
    expect(verifyChain(stored).ok).toBe(true);
  });

  it('appendLedgerEntry gives up after repeated unique violations and never loops forever', async () => {
    let inserts = 0;
    const q: QueryFn = (async (text: string) => {
      if (text.startsWith('SELECT')) return [];
      inserts++;
      throw Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
    }) as QueryFn;
    await expect(
      appendLedgerEntry(q, { contribution_id: 'c', entry_type: 'published', actor: 'op', payload: {} })
    ).rejects.toThrow(/lost the race 3 times/);
    expect(inserts).toBe(3);
  });
});

// ---------------------------------------------------------------------------
describe('expiry and time zones', () => {
  const ORIGINAL_TZ = process.env.TZ;
  afterEach(() => {
    if (ORIGINAL_TZ === undefined) delete process.env.TZ;
    else process.env.TZ = ORIGINAL_TZ;
  });
  const SECRET = 'unit-test-only-secret';
  const ZONES = ['UTC', 'Pacific/Kiritimati', 'America/St_Johns', 'Asia/Kathmandu', 'Pacific/Pago_Pago', 'Europe/Kyiv'];

  it('property: a URL verifies strictly before exp and never at or after it', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 2 ** 41 }),
        fc.integer({ min: 1, max: 86_400_000 }),
        fc.integer({ min: 0, max: 2 * 86_400_000 }),
        (t0, ttl, dt) => {
          const url = mintSignedUrl('https://a.example/m', { key: 'k', epoch: 0, ttlMs: ttl }, SECRET, t0);
          const r = verifySignedUrl(url, SECRET, { currentEpoch: 0, now: t0 + dt });
          if (dt < ttl) expect(r.ok).toBe(true);
          else expect(r).toEqual({ ok: false, reason: 'expired' });
        }
      )
    );
  });

  it('signed URLs and their expiry do not depend on the server time zone', () => {
    const t0 = Date.UTC(2026, 2, 29, 0, 59, 59); // around a European DST switch
    const minted: string[] = [];
    for (const tz of ZONES) {
      process.env.TZ = tz;
      minted.push(mintSignedUrl('https://a.example/m', { key: 'k', epoch: 2, ttlMs: 3_600_000 }, SECRET, t0));
    }
    expect(new Set(minted).size).toBe(1);
    for (const tz of ZONES) {
      process.env.TZ = tz;
      expect(verifySignedUrl(minted[0], SECRET, { currentEpoch: 2, now: t0 + 3_599_999 }).ok).toBe(true);
      expect(verifySignedUrl(minted[0], SECRET, { currentEpoch: 2, now: t0 + 3_600_000 }).ok).toBe(false);
    }
  });

  it('the revocation receipt (and its hash) is identical in every server time zone', async () => {
    const hashes = new Set<string>();
    const stamps = new Set<string>();
    for (const tz of ZONES) {
      process.env.TZ = tz;
      const storage = new MemoryStorageAdapter({ 'media/a': 'x' });
      let status: Status = 'published';
      const ports: RevocationPorts = {
        load: async () => ({ contribution_id: 'c1', status, hasConsent: true, consentRevoked: false, objects: [{ asset_id: 'a', key: 'media/a' }] }),
        revokeConsentRecords: async () => 1,
        bumpRevocationEpoch: async () => 1,
        setStatus: async (_i, from, to) => (status === from ? ((status = to), true) : false),
        readStatus: async () => status,
        storage,
        // local wall-clock construction would differ per zone; an instant does not
        now: () => new Date(Date.UTC(2026, 9, 25, 1, 30)),
      };
      const res = await revokeConsent(ports, 'c1');
      expect(res.ok).toBe(true);
      if (!res.ok) continue;
      hashes.add(res.receipt.hash);
      stamps.add(res.receipt.revoked_at);
    }
    expect([...stamps]).toEqual(['2026-10-25T01:30:00.000Z']);
    expect(hashes.size).toBe(1);
  });
});
