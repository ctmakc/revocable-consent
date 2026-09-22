// Off-chain, tamper-evident ledger.
// A hash chain in Postgres: append-only rows, each committing to its
// predecessor's hash. NOT a blockchain — an archive record whose history
// cannot be silently rewritten without breaking verification.
//
// Concurrency WITHOUT a transaction (the common case on serverless HTTP
// drivers): prev_seq is UNIQUE and must equal the predecessor's seq. Two
// racing appends both read the same tail and both try prev_seq = tail.seq —
// the second insert violates the UNIQUE constraint and is retried against the
// fresh tail (up to 3 attempts). Inside a SERIALIZABLE transaction the same
// code is simply never contended.
import {
  canonicalJson,
  computeEntryHash,
  verifyChain,
  GENESIS_PREV_HASH,
  GENESIS_PREV_SEQ,
} from './ledger-core.mjs';

export { canonicalJson, computeEntryHash, verifyChain, GENESIS_PREV_HASH, GENESIS_PREV_SEQ };

/**
 * The entry vocabulary.
 *
 *   published      — material went live
 *   withdrawn      — previously published material was taken down
 *   consent_revoked— consent was withdrawn
 *   media_deleted  — a revocation cascade deleted stored objects; the payload
 *                    carries the receipt hash (see revocation.ts)
 */
export type LedgerEntryType = 'published' | 'withdrawn' | 'consent_revoked' | 'media_deleted';

export const LEDGER_ENTRY_TYPES: LedgerEntryType[] = [
  'published',
  'withdrawn',
  'consent_revoked',
  'media_deleted',
];

/**
 * Legacy vocabulary map, for chains written before the rename.
 *
 * entry_type is part of every entry's hash, so a chain cannot be rewritten in
 * place: an UPDATE that renames 'mint' to 'published' breaks verification of
 * every entry from that point on. A deployment with existing history therefore
 * keeps the stored value and maps it AT READ TIME with this function, while
 * new entries use the current vocabulary. Both forms verify, because each
 * entry's hash still commits to the bytes that were actually stored.
 */
const LEGACY_ENTRY_TYPE: Record<string, LedgerEntryType> = {
  mint: 'published',
  withdraw: 'withdrawn',
};

/** Map a stored entry_type (current or legacy) to the current vocabulary. */
export function publicEntryType(t: string): LedgerEntryType | string {
  return LEGACY_ENTRY_TYPE[t] ?? t;
}

/**
 * Non-PII by design: never put names, emails or free-text notes in here.
 * In most deployments the ledger is PUBLIC, and an entry is permanent.
 */
export interface LedgerPayload {
  title?: string;
  collection?: string;
  licence?: string | null;
  scope_uses?: string[] | null;
  [k: string]: unknown;
}

export interface LedgerEntryRow {
  id: string;
  seq: string | number; // bigint comes back as string from the driver
  prev_seq: string | number;
  contribution_id: string | null;
  entry_type: LedgerEntryType;
  actor: string;
  payload: LedgerPayload;
  prev_hash: string;
  hash: string;
  created_at: string;
}

/** Minimal query-function contract; any `query(text, params) => rows` satisfies it. */
export type QueryFn = <T = Record<string, unknown>>(
  text: string,
  params?: unknown[]
) => Promise<T[]>;

export interface AppendInput {
  contribution_id: string | null;
  entry_type: LedgerEntryType;
  actor: string;
  payload: LedgerPayload;
}

const MAX_APPEND_ATTEMPTS = 3;

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  return e?.code === '23505' || /duplicate key value/i.test(e?.message ?? '');
}

/**
 * Append one entry to the chain. Reads the current tail, computes the hash
 * app-side, and inserts with prev_seq = tail.seq; a UNIQUE violation on
 * prev_seq means another append won the race — retry against the new tail.
 */
export async function appendLedgerEntry(
  q: QueryFn,
  input: AppendInput
): Promise<LedgerEntryRow> {
  // Normalise the payload to plain JSON BEFORE hashing, so the stored jsonb
  // value and the hashed value are guaranteed identical. Without this, a
  // payload containing e.g. a Date (or any object with toJSON) would hash as
  // canonicalJson sees it ('{}') but store as JSON.stringify sees it (an ISO
  // string) — an entry that could never re-verify: a permanent false
  // "tampering" alarm baked into the chain. The round trip applies toJSON,
  // drops undefined and rejects non-JSON values (cycles throw here, early).
  const payload: LedgerPayload = JSON.parse(JSON.stringify(input.payload));
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < MAX_APPEND_ATTEMPTS; attempt++) {
    const tail = (
      await q<{ seq: string; hash: string }>(
        'SELECT seq, hash FROM ledger_entries ORDER BY seq DESC LIMIT 1'
      )
    )[0];
    const prev_seq = tail ? Number(tail.seq) : GENESIS_PREV_SEQ;
    const prev_hash = tail ? tail.hash : GENESIS_PREV_HASH;
    const hash = computeEntryHash({
      entry_type: input.entry_type,
      contribution_id: input.contribution_id,
      actor: input.actor,
      payload,
      prev_hash,
    });
    try {
      const rows = await q<LedgerEntryRow>(
        `INSERT INTO ledger_entries (prev_seq, contribution_id, entry_type, actor, payload, prev_hash, hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [
          prev_seq,
          input.contribution_id,
          input.entry_type,
          input.actor,
          JSON.stringify(payload), // the SAME normalised value the hash committed to
          prev_hash,
          hash,
        ]
      );
      if (rows[0]) return rows[0];
      throw new Error('ledger insert returned no row');
    } catch (err) {
      if (isUniqueViolation(err)) {
        lastErr = err; // raced — re-read the tail and try again
        continue;
      }
      throw err;
    }
  }
  throw new Error(
    `ledger append lost the race ${MAX_APPEND_ATTEMPTS} times: ${
      lastErr instanceof Error ? lastErr.message : String(lastErr)
    }`
  );
}

export interface VerifyResult {
  ok: boolean;
  count: number;
  error?: string;
  seq?: number;
}

/** Recompute and verify the WHOLE chain from genesis. O(n) — for scripts/health deep checks. */
export async function verifyLedger(q: QueryFn): Promise<VerifyResult> {
  const rows = await q<LedgerEntryRow>(
    'SELECT seq, prev_seq, contribution_id, entry_type, actor, payload, prev_hash, hash FROM ledger_entries ORDER BY seq ASC'
  );
  return verifyChain(rows as any[]) as VerifyResult;
}

/**
 * Cheap tail check for /api/health: recompute ONLY the last entry's hash.
 * An empty ledger is valid.
 */
export async function verifyLedgerTail(q: QueryFn): Promise<VerifyResult> {
  const rows = await q<LedgerEntryRow>(
    'SELECT seq, prev_seq, contribution_id, entry_type, actor, payload, prev_hash, hash FROM ledger_entries ORDER BY seq DESC LIMIT 1'
  );
  if (rows.length === 0) return { ok: true, count: 0 };
  const row = rows[0];
  const expected = computeEntryHash(row as any);
  if (row.hash !== expected) {
    return { ok: false, count: 1, seq: Number(row.seq), error: 'tail entry hash mismatch' };
  }
  return { ok: true, count: 1 };
}
