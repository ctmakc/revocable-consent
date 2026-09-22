// The revocation cascade: what has to happen, in what order, when consent is
// withdrawn — and what evidence comes out of it.
//
// ORDER IS THE DESIGN. Each step closes a different door, and the cheap,
// certain doors close first:
//
//   1. mark the consent record revoked      → every read gate now answers "no"
//   2. bump the item's revocation epoch     → signed URLs already handed out
//                                             stop verifying (signed-url.ts)
//   3. published → withdrawn                → the stored status catches up
//   4. delete the stored objects            → the bytes go
//   5. read each key back                   → deletion becomes EVIDENCE
//   6. purge the cache (best effort)         → shortens the tail of stale copies
//   7. append a receipt to the hash chain   → the evidence is tamper-evident
//
// Steps 1–3 are pure database writes and take effect immediately; the public
// surface is closed before any byte is touched. Steps 4–5 are the part that
// can partially fail, and a partial failure is REPORTED (`complete: false`),
// never rounded up to success.
//
// Everything is injected through ports, so this file has no database, no HTTP
// and no object-store SDK in it, and the whole cascade is unit-testable.
import { canonicalJson, sha256Hex } from './ledger-core.mjs';
import { transition, type Status } from './moderation';
import type { CachePurger, StorageAdapter } from './storage';

export interface RevocationSubject {
  contribution_id: string;
  status: Status;
  /** True when at least one consent record exists for the item. */
  hasConsent: boolean;
  /** True when consent was already revoked. */
  consentRevoked: boolean;
  /** Storage keys held for this item. */
  objects: readonly { asset_id: string; key: string }[];
}

export interface ObjectOutcome {
  asset_id: string;
  key: string;
  /** The adapter reported the object as deleted. */
  deleted: boolean;
  /** A read-back confirmed the object is gone. This is the load-bearing field. */
  verified_absent: boolean;
  /** Recorded content hash of what was deleted, when the operator had one. */
  checksum_sha256?: string | null;
  bytes?: number | null;
  error?: string;
}

export interface RevocationReceipt {
  contribution_id: string;
  revoked_at: string;
  previous_status: Status;
  status: Status;
  /** How many standing consent records this revocation closed. */
  consent_rows_revoked: number;
  /** The item's revocation epoch after the cascade; older signed URLs are dead. */
  epoch: number;
  storage_adapter: string;
  objects: ObjectOutcome[];
  cache_purge?: { adapter: string; ok: boolean; detail?: string };
  /**
   * True only when every object was deleted AND read back as absent. False
   * leaves the operator with explicit, listed work to finish.
   */
  complete: boolean;
  /** SHA-256 over the canonical form of this receipt (with `hash` omitted). */
  hash: string;
}

export type RevocationResult =
  | { ok: true; receipt: RevocationReceipt; ledger_seq: number | null }
  | { ok: false; error: string };

/** Everything the cascade needs from the outside world. */
export interface RevocationPorts {
  /** Load the current state of the item. */
  load(contributionId: string): Promise<RevocationSubject | null>;
  /**
   * Mark every standing consent record revoked. MUST be a compare-and-set
   * (`WHERE revoked = false`) and return how many rows it actually changed, so
   * a concurrent revocation loses instead of both claiming to have won.
   */
  revokeConsentRecords(contributionId: string, at: Date): Promise<number>;
  /**
   * Increment and return the item's revocation epoch. Signed URLs carry the
   * epoch they were minted under, so this is what kills the ones in flight.
   */
  bumpRevocationEpoch(contributionId: string): Promise<number>;
  /** Compare-and-set the status. Returns false when the item moved meanwhile. */
  setStatus(contributionId: string, from: Status, to: Status): Promise<boolean>;
  /** Re-read the status after a lost compare-and-set. */
  readStatus(contributionId: string): Promise<Status | null>;
  /** Record that a stored object is gone (and when). */
  markObjectDeleted?(assetId: string, at: Date): Promise<void>;
  /**
   * Append the receipt to the hash chain. Non-PII payload only. Returning null
   * (or throwing) does not undo the deletion — the receipt is still returned.
   */
  appendLedger?(entry: {
    contribution_id: string;
    entry_type: 'consent_revoked' | 'media_deleted';
    actor: string;
    payload: Record<string, unknown>;
  }): Promise<{ seq: number | string } | null>;
  storage: StorageAdapter;
  cache?: CachePurger;
  now?: () => Date;
}

/** Hash of a receipt: canonical JSON of every field except `hash` itself. */
export function receiptHash(receipt: Omit<RevocationReceipt, 'hash'>): string {
  return sha256Hex(canonicalJson(receipt as unknown as Record<string, unknown>));
}

/**
 * Run the cascade for one item. `actor` is recorded in the ledger entry and
 * should identify the operator role (not a person's name — the ledger is
 * public in most deployments).
 */
export async function revokeConsent(
  ports: RevocationPorts,
  contributionId: string,
  opts: { actor?: string; deleteObjects?: boolean } = {}
): Promise<RevocationResult> {
  const actor = opts.actor ?? 'operator';
  const deleteObjects = opts.deleteObjects ?? true;
  const now = ports.now ?? (() => new Date());

  const subject = await ports.load(contributionId);
  if (!subject) return { ok: false, error: 'no such contribution' };

  // The state machine owns the legality of the transition, here as everywhere.
  const decision = transition(subject.status, 'revoke_consent', {
    hasConsent: subject.hasConsent,
    consentRevoked: subject.consentRevoked,
  });
  if (decision.ok === false) return { ok: false, error: decision.error };

  const at = now();

  // 1. Close the gate. Compare-and-set: zero rows means somebody else revoked
  //    while we were deciding, and this call has nothing left to do.
  const consentRowsRevoked = await ports.revokeConsentRecords(contributionId, at);
  if (consentRowsRevoked === 0) {
    return { ok: false, error: 'consent was already revoked by a concurrent action' };
  }

  // 2. Kill the signed URLs already in flight.
  const epoch = await ports.bumpRevocationEpoch(contributionId);

  // 3. Catch the stored status up. A lost race here does not undo step 1 —
  //    the revocation already holds — so we record where the item actually
  //    landed and carry on.
  let status: Status = decision.next;
  if (decision.next !== subject.status) {
    const moved = await ports.setStatus(contributionId, subject.status, decision.next);
    if (!moved) status = (await ports.readStatus(contributionId)) ?? decision.next;
  }

  // 4–5. Delete the bytes, then read each key back. An adapter that reports a
  //      successful delete is not believed until `exists()` says no.
  const objects: ObjectOutcome[] = [];
  if (deleteObjects) {
    for (const obj of subject.objects) {
      const outcome: ObjectOutcome = {
        asset_id: obj.asset_id,
        key: obj.key,
        deleted: false,
        verified_absent: false,
      };
      try {
        if (ports.storage.head) {
          const meta = await ports.storage.head(obj.key);
          if (meta) {
            outcome.bytes = meta.bytes;
            outcome.checksum_sha256 = meta.checksum_sha256 ?? null;
          }
        }
        outcome.deleted = await ports.storage.delete(obj.key);
      } catch (err) {
        outcome.error = err instanceof Error ? err.message : String(err);
      }
      try {
        outcome.verified_absent = !(await ports.storage.exists(obj.key));
      } catch (err) {
        outcome.error = outcome.error ?? (err instanceof Error ? err.message : String(err));
      }
      if (outcome.verified_absent && ports.markObjectDeleted) {
        try {
          await ports.markObjectDeleted(obj.asset_id, at);
        } catch (err) {
          outcome.error = outcome.error ?? (err instanceof Error ? err.message : String(err));
        }
      }
      objects.push(outcome);
    }
  }

  // 6. Best-effort cache purge. Correctness does not rest on it.
  let cachePurge: RevocationReceipt['cache_purge'];
  if (deleteObjects && ports.cache && subject.objects.length > 0) {
    try {
      const res = await ports.cache.purge(subject.objects.map((o) => o.key));
      cachePurge = { adapter: ports.cache.name, ok: res.ok, detail: res.detail };
    } catch (err) {
      cachePurge = {
        adapter: ports.cache.name,
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  }

  const draft: Omit<RevocationReceipt, 'hash'> = {
    contribution_id: contributionId,
    revoked_at: at.toISOString(),
    previous_status: subject.status,
    status,
    consent_rows_revoked: consentRowsRevoked,
    epoch,
    storage_adapter: ports.storage.name,
    objects,
    ...(cachePurge ? { cache_purge: cachePurge } : {}),
    complete: deleteObjects ? objects.every((o) => o.verified_absent) : objects.length === 0,
  };
  const receipt: RevocationReceipt = { ...draft, hash: receiptHash(draft) };

  // 7. Put the evidence on the chain. NON-PII payload: ids, counts, hashes —
  //    never names, emails or statements.
  let ledgerSeq: number | null = null;
  if (ports.appendLedger) {
    try {
      const entry = await ports.appendLedger({
        contribution_id: contributionId,
        entry_type: deleteObjects && objects.length > 0 ? 'media_deleted' : 'consent_revoked',
        actor,
        payload: {
          revoked_at: receipt.revoked_at,
          previous_status: receipt.previous_status,
          status: receipt.status,
          epoch: receipt.epoch,
          storage_adapter: receipt.storage_adapter,
          objects_deleted: objects.filter((o) => o.verified_absent).length,
          objects_total: objects.length,
          complete: receipt.complete,
          receipt_hash: receipt.hash,
        },
      });
      ledgerSeq = entry ? Number(entry.seq) : null;
    } catch {
      // A ledger failure never un-deletes anything. The receipt is returned
      // either way and the caller is expected to retry the append.
      ledgerSeq = null;
    }
  }

  return { ok: true, receipt, ledger_seq: ledgerSeq };
}

/** Human-readable summary of what a receipt still leaves undone. */
export function outstandingWork(receipt: RevocationReceipt): string[] {
  const out: string[] = [];
  for (const o of receipt.objects) {
    if (!o.verified_absent) {
      out.push(`object ${o.key} is still present${o.error ? ` (${o.error})` : ''}`);
    }
  }
  if (receipt.cache_purge && !receipt.cache_purge.ok) {
    out.push(
      `cache purge via ${receipt.cache_purge.adapter} failed${
        receipt.cache_purge.detail ? ` (${receipt.cache_purge.detail})` : ''
      }`
    );
  }
  return out;
}
