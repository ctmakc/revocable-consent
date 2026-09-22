import { describe, it, expect } from 'vitest';
import {
  outstandingWork,
  receiptHash,
  revokeConsent,
  type RevocationPorts,
  type RevocationSubject,
} from '../src/revocation';
import { FailingDeleteAdapter, MemoryStorageAdapter, type CachePurger } from '../src/storage';
import { verifyChain } from '../src/ledger-core.mjs';
import { appendLedgerEntry, type QueryFn } from '../src/ledger';
import { mintSignedUrl, verifySignedUrl } from '../src/signed-url';
import type { Status } from '../src/moderation';

const AT = new Date('2026-09-22T12:00:00.000Z');
const ID = '00000000-0000-4000-8000-000000000001';

/** A tiny in-memory world implementing every port the cascade needs. */
function world(opts: { status?: Status; objects?: string[]; cache?: CachePurger } = {}) {
  const storage = new MemoryStorageAdapter();
  const objects = (opts.objects ?? ['media/song.mp3', 'media/photo.jpg']).map((key, i) => ({
    asset_id: `asset-${i}`,
    key,
  }));
  for (const o of objects) storage.put(o.key, `bytes of ${o.key}`, `${'a'.repeat(63)}${o.asset_id.at(-1)}`);

  const state = {
    status: (opts.status ?? 'published') as Status,
    consentRows: [{ revoked: false }, { revoked: false }],
    epoch: 4,
    deletedAssets: [] as string[],
    ledgerRows: [] as any[],
  };

  // Ledger over the real appendLedgerEntry, against a fake SQL surface.
  let seq = 0;
  const q: QueryFn = (async (text: string, params: unknown[] = []) => {
    if (text.startsWith('SELECT seq, hash FROM ledger_entries')) {
      const tail = state.ledgerRows[state.ledgerRows.length - 1];
      return tail ? [{ seq: String(tail.seq), hash: tail.hash }] : [];
    }
    if (text.startsWith('INSERT INTO ledger_entries')) {
      const [prev_seq, contribution_id, entry_type, actor, payloadJson, prev_hash, hash] = params as any[];
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
        created_at: AT.toISOString(),
      };
      state.ledgerRows.push(row);
      return [row];
    }
    throw new Error(`unexpected query: ${text}`);
  }) as QueryFn;

  const ports: RevocationPorts = {
    async load(): Promise<RevocationSubject | null> {
      return {
        contribution_id: ID,
        status: state.status,
        hasConsent: state.consentRows.length > 0,
        consentRevoked: state.consentRows.some((r) => r.revoked),
        objects,
      };
    },
    async revokeConsentRecords() {
      const standing = state.consentRows.filter((r) => !r.revoked);
      standing.forEach((r) => (r.revoked = true));
      return standing.length;
    },
    async bumpRevocationEpoch() {
      state.epoch += 1;
      return state.epoch;
    },
    async setStatus(_id, from, to) {
      if (state.status !== from) return false;
      state.status = to;
      return true;
    },
    async readStatus() {
      return state.status;
    },
    async markObjectDeleted(assetId) {
      state.deletedAssets.push(assetId);
    },
    async appendLedger(entry) {
      return appendLedgerEntry(q, {
        contribution_id: entry.contribution_id,
        entry_type: entry.entry_type,
        actor: entry.actor,
        payload: entry.payload,
      });
    },
    storage,
    cache: opts.cache,
    now: () => AT,
  };

  return { ports, state, storage, objects };
}

describe('revokeConsent cascade', () => {
  it('closes the gate, kills the bytes and proves it', async () => {
    const { ports, state, storage } = world();
    const res = await revokeConsent(ports, ID, { actor: 'operator' });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const r = res.receipt;

    expect(state.consentRows.every((c) => c.revoked)).toBe(true); // 1. gate closed
    expect(r.epoch).toBe(5); //                                     2. signed URLs dead
    expect(r.previous_status).toBe('published');
    expect(r.status).toBe('withdrawn'); //                          3. status caught up
    expect(storage.keys()).toEqual([]); //                          4. bytes gone
    expect(r.objects.every((o) => o.deleted && o.verified_absent)).toBe(true); // 5. read back
    expect(r.complete).toBe(true);
    expect(outstandingWork(r)).toEqual([]);
    expect(state.deletedAssets).toEqual(['asset-0', 'asset-1']);
    expect(res.ledger_seq).toBe(1); //                              7. on the chain
  });

  it('writes a ledger entry with the receipt hash and NO personal data', async () => {
    const { ports, state } = world();
    const res = await revokeConsent(ports, ID);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const entry = state.ledgerRows[0];
    expect(entry.entry_type).toBe('media_deleted');
    expect(entry.payload.receipt_hash).toBe(res.receipt.hash);
    expect(entry.payload.objects_deleted).toBe(2);
    expect(entry.payload.complete).toBe(true);
    // The whole payload must be free of anything identifying.
    const serialised = JSON.stringify(entry.payload);
    for (const field of ['name', 'email', 'statement', 'note']) {
      expect(serialised.toLowerCase().includes(field)).toBe(false);
    }
    expect(verifyChain(state.ledgerRows)).toEqual({ ok: true, count: 1 });
  });

  it('reports an INCOMPLETE deletion instead of claiming success', async () => {
    const base = world();
    const failing = new FailingDeleteAdapter(base.storage, 'store returned 503');
    const res = await revokeConsent({ ...base.ports, storage: failing }, ID);

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.receipt.complete).toBe(false);
    expect(res.receipt.objects.every((o) => o.error === 'store returned 503')).toBe(true);
    expect(res.receipt.objects.every((o) => o.verified_absent)).toBe(false);
    expect(outstandingWork(res.receipt)).toHaveLength(2);
    // Consent is revoked all the same: the public gate never waits on storage.
    expect(base.state.consentRows.every((c) => c.revoked)).toBe(true);
    expect(base.state.ledgerRows[0].payload.complete).toBe(false);
  });

  it('records a failed cache purge without failing the revocation', async () => {
    const cache: CachePurger = {
      name: 'test-cdn',
      async purge() {
        return { ok: false, detail: 'purge API timeout' };
      },
    };
    const { ports } = world({ cache });
    const res = await revokeConsent(ports, ID);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.receipt.cache_purge).toEqual({ adapter: 'test-cdn', ok: false, detail: 'purge API timeout' });
    expect(res.receipt.complete).toBe(true); // the bytes are still gone
    expect(outstandingWork(res.receipt)).toEqual(['cache purge via test-cdn failed (purge API timeout)']);
  });

  it('refuses a second revocation (compare-and-set on the consent rows)', async () => {
    const { ports } = world();
    expect((await revokeConsent(ports, ID)).ok).toBe(true);
    const second = await revokeConsent(ports, ID);
    expect(second).toEqual({ ok: false, error: 'consent has already been revoked' });
  });

  it('refuses when there is no consent record to revoke', async () => {
    const { ports } = world();
    const noConsent: RevocationPorts = {
      ...ports,
      async load() {
        return { contribution_id: ID, status: 'submitted', hasConsent: false, consentRevoked: false, objects: [] };
      },
    };
    expect(await revokeConsent(noConsent, ID)).toEqual({
      ok: false,
      error: 'there is no consent record to revoke',
    });
  });

  it('revokes unpublished material without changing its status', async () => {
    const { ports, state } = world({ status: 'approved' });
    const res = await revokeConsent(ports, ID);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.receipt.status).toBe('approved');
    expect(state.status).toBe('approved');
    expect(res.receipt.complete).toBe(true);
  });

  it('survives a status race: revocation holds and the real status is reported', async () => {
    const { ports, state } = world();
    const racing: RevocationPorts = {
      ...ports,
      async setStatus() {
        state.status = 'withdrawn'; // someone else withdrew it meanwhile
        return false;
      },
    };
    const res = await revokeConsent(racing, ID);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.receipt.status).toBe('withdrawn');
    expect(state.consentRows.every((c) => c.revoked)).toBe(true);
  });

  it('keeps the receipt when the ledger append fails', async () => {
    const { ports } = world();
    const brokenLedger: RevocationPorts = {
      ...ports,
      async appendLedger() {
        throw new Error('ledger unavailable');
      },
    };
    const res = await revokeConsent(brokenLedger, ID);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.ledger_seq).toBeNull();
    expect(res.receipt.complete).toBe(true);
  });

  it('can revoke consent without deleting (a takedown that keeps a dark copy)', async () => {
    const { ports, storage, state } = world();
    const res = await revokeConsent(ports, ID, { deleteObjects: false });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.receipt.objects).toEqual([]);
    expect(storage.keys()).toHaveLength(2);
    expect(state.ledgerRows[0].entry_type).toBe('consent_revoked');
  });

  it('the receipt hash covers the outcome (tampering with it is detectable)', async () => {
    const { ports } = world();
    const res = await revokeConsent(ports, ID);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const { hash, ...rest } = res.receipt;
    expect(receiptHash(rest)).toBe(hash);
    expect(receiptHash({ ...rest, complete: false })).not.toBe(hash);
    expect(receiptHash({ ...rest, objects: [] })).not.toBe(hash);
  });

  it('end to end: a URL minted before the revocation stops verifying after it', async () => {
    const secret = 'signing-secret';
    const { ports } = world();
    const before = mintSignedUrl(
      'https://archive.example/media/asset-0',
      { key: 'media/song.mp3', epoch: 4, ttlMs: 60 * 60_000 },
      secret
    );
    expect(verifySignedUrl(before, secret, { currentEpoch: 4 }).ok).toBe(true);

    const res = await revokeConsent(ports, ID);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(verifySignedUrl(before, secret, { currentEpoch: res.receipt.epoch })).toEqual({
      ok: false,
      reason: 'stale-epoch',
    });
  });
});
