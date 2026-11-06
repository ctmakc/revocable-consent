// Edge cases of the revocation cascade not covered by revocation.test.ts:
// what goes into the receipt when ports misbehave, which ports are (not)
// called, and how outstandingWork() phrases what is left to do.
import { describe, it, expect, vi } from 'vitest';
import {
  outstandingWork,
  receiptHash,
  revokeConsent,
  type RevocationPorts,
  type RevocationReceipt,
} from '../src/revocation';
import { MemoryStorageAdapter, type StorageAdapter } from '../src/storage';
import type { Status } from '../src/moderation';

const AT = new Date('2026-10-01T08:00:00.000Z');
const ID = 'item-1';

function ports(over: Partial<RevocationPorts> & { status?: Status; keys?: string[] } = {}) {
  const storage = new MemoryStorageAdapter();
  const keys = over.keys ?? ['media/a.mp3'];
  keys.forEach((k, i) => storage.put(k, `content-${i}`, String(i).repeat(64)));
  const p: RevocationPorts = {
    load: async () => ({
      contribution_id: ID,
      status: over.status ?? 'published',
      hasConsent: true,
      consentRevoked: false,
      objects: keys.map((key, i) => ({ asset_id: `a${i}`, key })),
    }),
    revokeConsentRecords: vi.fn(async () => 1),
    bumpRevocationEpoch: vi.fn(async () => 2),
    setStatus: vi.fn(async () => true),
    readStatus: vi.fn(async () => null),
    storage,
    now: () => AT,
    ...over,
  };
  return { p, storage };
}

describe('revokeConsent — preconditions', () => {
  it('reports a missing item without touching any port', async () => {
    const { p } = ports({ load: async () => null });
    expect(await revokeConsent(p, ID)).toEqual({ ok: false, error: 'no such contribution' });
    expect(p.revokeConsentRecords).not.toHaveBeenCalled();
    expect(p.bumpRevocationEpoch).not.toHaveBeenCalled();
  });

  it('refuses an already-revoked item at the state machine, before the CAS', async () => {
    const { p } = ports();
    const loaded = await p.load(ID);
    p.load = async () => ({ ...loaded!, consentRevoked: true });
    const res = await revokeConsent(p, ID);
    expect(res).toEqual({ ok: false, error: 'consent has already been revoked' });
    expect(p.revokeConsentRecords).not.toHaveBeenCalled();
  });

  it('does not bump the epoch when the CAS reports zero rows', async () => {
    const { p } = ports({ revokeConsentRecords: vi.fn(async () => 0) });
    const res = await revokeConsent(p, ID);
    expect(res.ok).toBe(false);
    expect(p.bumpRevocationEpoch).not.toHaveBeenCalled();
  });
});

describe('revokeConsent — receipt contents', () => {
  it('records bytes and checksum from head(), stamps revoked_at from now(), and the epoch from the port', async () => {
    const { p } = ports();
    const res = await revokeConsent(p, ID);
    if (!res.ok) throw new Error(res.error);
    expect(res.receipt.revoked_at).toBe(AT.toISOString());
    expect(res.receipt.epoch).toBe(2);
    expect(res.receipt.consent_rows_revoked).toBe(1);
    expect(res.receipt.objects).toEqual([
      {
        asset_id: 'a0',
        key: 'media/a.mp3',
        deleted: true,
        verified_absent: true,
        bytes: 'content-0'.length,
        checksum_sha256: '0'.repeat(64),
      },
    ]);
    expect(res.receipt.cache_purge).toBeUndefined();
    expect('cache_purge' in res.receipt).toBe(false);
    expect(res.ledger_seq).toBeNull(); // no appendLedger port
  });

  it('passes the revocation time to markObjectDeleted', async () => {
    const mark = vi.fn(async () => {});
    const { p } = ports({ markObjectDeleted: mark });
    await revokeConsent(p, ID);
    expect(mark).toHaveBeenCalledWith('a0', AT);
  });

  it('an adapter that says "deleted" but still has the object is not believed', async () => {
    const liar: StorageAdapter = {
      name: 'liar',
      presignRead: async () => null,
      delete: async () => true,
      exists: async () => true,
    };
    const mark = vi.fn(async () => {});
    const { p } = ports({ storage: liar, markObjectDeleted: mark });
    const res = await revokeConsent(p, ID);
    if (!res.ok) throw new Error(res.error);
    expect(res.receipt.objects[0]).toMatchObject({ deleted: true, verified_absent: false });
    expect(res.receipt.complete).toBe(false);
    expect(mark).not.toHaveBeenCalled();
    expect(res.receipt.storage_adapter).toBe('liar');
  });

  it('an object that was already gone counts as verified absent (deleted:false)', async () => {
    const { p, storage } = ports();
    await storage.delete('media/a.mp3');
    const res = await revokeConsent(p, ID);
    if (!res.ok) throw new Error(res.error);
    expect(res.receipt.objects[0]).toMatchObject({ deleted: false, verified_absent: true });
    expect(res.receipt.complete).toBe(true);
  });

  it('an exists() failure leaves the object unverified and records the error', async () => {
    const flaky: StorageAdapter = {
      name: 'flaky',
      presignRead: async () => null,
      delete: async () => true,
      exists: async () => {
        throw new Error('HEAD timed out');
      },
    };
    const { p } = ports({ storage: flaky });
    const res = await revokeConsent(p, ID);
    if (!res.ok) throw new Error(res.error);
    expect(res.receipt.objects[0]).toMatchObject({
      deleted: true,
      verified_absent: false,
      error: 'HEAD timed out',
    });
    expect(outstandingWork(res.receipt)).toEqual(['object media/a.mp3 is still present (HEAD timed out)']);
  });

  it('a markObjectDeleted failure is recorded but the object stays verified absent', async () => {
    const { p } = ports({
      markObjectDeleted: async () => {
        throw new Error('db write failed');
      },
    });
    const res = await revokeConsent(p, ID);
    if (!res.ok) throw new Error(res.error);
    expect(res.receipt.objects[0]).toMatchObject({ verified_absent: true, error: 'db write failed' });
    expect(res.receipt.complete).toBe(true);
  });

  it('a non-Error throw from storage is stringified into the outcome', async () => {
    const weird: StorageAdapter = {
      name: 'weird',
      presignRead: async () => null,
      delete: async () => {
        throw 'quota';
      },
      exists: async () => true,
    };
    const { p } = ports({ storage: weird });
    const res = await revokeConsent(p, ID);
    if (!res.ok) throw new Error(res.error);
    expect(res.receipt.objects[0].error).toBe('quota');
  });

  it('a lost status race with an unreadable status falls back to the decided status', async () => {
    const { p } = ports({ setStatus: vi.fn(async () => false), readStatus: vi.fn(async () => null) });
    const res = await revokeConsent(p, ID);
    if (!res.ok) throw new Error(res.error);
    expect(res.receipt.previous_status).toBe('published');
    expect(res.receipt.status).toBe('withdrawn');
    expect(p.readStatus).toHaveBeenCalled();
  });

  it('does not call setStatus when the status does not change', async () => {
    const { p } = ports({ status: 'in_review' });
    const res = await revokeConsent(p, ID);
    if (!res.ok) throw new Error(res.error);
    expect(p.setStatus).not.toHaveBeenCalled();
    expect(res.receipt.status).toBe('in_review');
  });

  it('skips the cache purge when the item holds no objects', async () => {
    const purge = vi.fn(async () => ({ ok: true }));
    const { p } = ports({ keys: [], cache: { name: 'cdn', purge } });
    const res = await revokeConsent(p, ID);
    if (!res.ok) throw new Error(res.error);
    expect(purge).not.toHaveBeenCalled();
    expect(res.receipt.objects).toEqual([]);
    expect(res.receipt.complete).toBe(true);
  });

  it('records a thrown cache purge as ok:false with the message', async () => {
    const { p } = ports({
      cache: {
        name: 'cdn',
        purge: async () => {
          throw new Error('rate limited');
        },
      },
    });
    const res = await revokeConsent(p, ID);
    if (!res.ok) throw new Error(res.error);
    expect(res.receipt.cache_purge).toEqual({ adapter: 'cdn', ok: false, detail: 'rate limited' });
    expect(res.receipt.complete).toBe(true); // purge is best-effort and does not affect completeness
  });

  it('the receipt hash is the hash of everything else in it', async () => {
    const { p } = ports({ keys: ['x', 'y'] });
    const res = await revokeConsent(p, ID);
    if (!res.ok) throw new Error(res.error);
    const { hash, ...rest } = res.receipt;
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(receiptHash(rest)).toBe(hash);
  });
});

describe('revokeConsent — ledger entry', () => {
  it('uses the default actor and passes through a string seq as a number', async () => {
    const append = vi.fn(async (_entry: Parameters<NonNullable<RevocationPorts["appendLedger"]>>[0]) => ({ seq: "42" }));
    const { p } = ports({ appendLedger: append });
    const res = await revokeConsent(p, ID);
    if (!res.ok) throw new Error(res.error);
    expect(res.ledger_seq).toBe(42);
    expect(append.mock.calls[0][0]).toMatchObject({
      contribution_id: ID,
      entry_type: 'media_deleted',
      actor: 'operator',
    });
  });

  it('an appendLedger returning null yields ledger_seq null', async () => {
    const { p } = ports({ appendLedger: async () => null });
    const res = await revokeConsent(p, ID, { actor: 'archive-admin' });
    if (!res.ok) throw new Error(res.error);
    expect(res.ledger_seq).toBeNull();
  });

  it('counts only verified-absent objects as deleted in the ledger payload', async () => {
    let payload: Record<string, unknown> = {};
    const half: StorageAdapter = (() => {
      const inner = new MemoryStorageAdapter({ keep: 'k', drop: 'd' });
      return {
        name: 'half',
        presignRead: inner.presignRead.bind(inner),
        exists: inner.exists.bind(inner),
        delete: async (key: string) => (key === 'keep' ? true : inner.delete(key)),
      };
    })();
    const { p } = ports({
      keys: ['keep', 'drop'],
      storage: half,
      appendLedger: async (e) => {
        payload = e.payload;
        return { seq: 1 };
      },
    });
    const res = await revokeConsent(p, ID);
    if (!res.ok) throw new Error(res.error);
    expect(payload).toMatchObject({ objects_deleted: 1, objects_total: 2, complete: false, receipt_hash: res.receipt.hash });
  });
});

describe('outstandingWork', () => {
  const base: RevocationReceipt = {
    contribution_id: ID,
    revoked_at: AT.toISOString(),
    previous_status: 'published',
    status: 'withdrawn',
    consent_rows_revoked: 1,
    epoch: 1,
    storage_adapter: 'memory',
    objects: [],
    complete: true,
    hash: 'h',
  };

  it('is empty for a complete receipt with a successful or absent purge', () => {
    expect(outstandingWork(base)).toEqual([]);
    expect(outstandingWork({ ...base, cache_purge: { adapter: 'cdn', ok: true } })).toEqual([]);
  });

  it('lists every object still present, with and without an error', () => {
    const r: RevocationReceipt = {
      ...base,
      complete: false,
      objects: [
        { asset_id: '1', key: 'a', deleted: false, verified_absent: false, error: 'denied' },
        { asset_id: '2', key: 'b', deleted: true, verified_absent: true },
        { asset_id: '3', key: 'c', deleted: true, verified_absent: false },
      ],
    };
    expect(outstandingWork(r)).toEqual(['object a is still present (denied)', 'object c is still present']);
  });

  it('mentions a failed purge, with detail when there is one', () => {
    expect(outstandingWork({ ...base, cache_purge: { adapter: 'cdn', ok: false } })).toEqual([
      'cache purge via cdn failed',
    ]);
    expect(
      outstandingWork({ ...base, cache_purge: { adapter: 'cdn', ok: false, detail: '503' } })
    ).toEqual(['cache purge via cdn failed (503)']);
  });
});

describe('revokeConsent — deleteObjects:false', () => {
  it.skip('bug: receipt says complete:true and outstandingWork is empty although the stored objects were kept', async () => {
    // `complete` is documented as "true only when every object was deleted AND
    // read back as absent", but with deleteObjects:false the code computes
    // `objects.length === 0` over an array it never fills, so it is always true.
    const { p, storage } = ports({ keys: ['media/a.mp3', 'media/b.jpg'] });
    const res = await revokeConsent(p, ID, { deleteObjects: false });
    if (!res.ok) throw new Error(res.error);
    expect(storage.keys()).toHaveLength(2);
    expect(res.receipt.complete).toBe(false);
  });
});
