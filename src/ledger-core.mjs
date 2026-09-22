// Ledger core: canonical JSON, entry hashing and pure chain verification.
// Plain ESM JavaScript on purpose — imported by BOTH the typed library
// (ledger.ts) and the standalone CLI verifier (bin/verify-ledger.mjs), so
// there is exactly one implementation of the hash rules and an auditor can
// run the verifier with nothing but Node installed.
//
// HONESTY NOTE: this is an off-chain, tamper-EVIDENT archive record — a hash
// chain in Postgres. It is not a blockchain and we never describe it as one.
import { createHash } from 'node:crypto';

/** prev_hash value of the first (genesis) entry. */
export const GENESIS_PREV_HASH = 'GENESIS';
/** prev_seq value of the first (genesis) entry. */
export const GENESIS_PREV_SEQ = 0;

/**
 * Deterministic JSON serialisation: object keys sorted (recursively),
 * no whitespace, arrays in order. Rules:
 *   - undefined values inside objects are DROPPED (like JSON.stringify)
 *   - undefined inside arrays becomes null (like JSON.stringify)
 *   - non-finite numbers / functions / symbols / bigints are rejected —
 *     a ledger payload must be plain JSON data.
 */
export function canonicalJson(value) {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'number') {
    if (!Number.isFinite(value)) throw new Error('canonicalJson: non-finite number');
    return JSON.stringify(value);
  }
  if (t === 'boolean' || t === 'string') return JSON.stringify(value);
  if (t === 'undefined') throw new Error('canonicalJson: cannot serialise undefined at top level');
  if (t === 'function' || t === 'symbol' || t === 'bigint') {
    throw new Error(`canonicalJson: cannot serialise ${t}`);
  }
  if (Array.isArray(value)) {
    return '[' + value.map((v) => (v === undefined ? 'null' : canonicalJson(v))).join(',') + ']';
  }
  // plain object: sorted keys, undefined-valued keys dropped
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}';
}

/** Hex SHA-256 of a string. */
export function sha256Hex(s) {
  return createHash('sha256').update(s).digest('hex');
}

/**
 * Hash of one ledger entry. Deliberately seq-INDEPENDENT (bigserial seq is
 * assigned by the database after the hash is computed): the hash commits to
 * the entry content and to the predecessor via prev_hash.
 */
export function computeEntryHash({ entry_type, contribution_id, actor, payload, prev_hash }) {
  return sha256Hex(
    prev_hash +
      '\n' +
      canonicalJson({
        entry_type,
        contribution_id: contribution_id ?? null,
        actor,
        payload,
        prev_hash,
      })
  );
}

/**
 * Pure chain verification over rows ordered by seq ASC.
 * Each row: { seq, prev_seq, contribution_id, entry_type, actor, payload, prev_hash, hash }.
 * Checks: genesis linkage, prev_seq → predecessor.seq, prev_hash → predecessor.hash,
 * and recomputes every hash. seq gaps are legal (lost-race inserts burn serials);
 * linkage is what matters.
 * Returns { ok: true, count } or { ok: false, count, error, seq }.
 */
export function verifyChain(rows) {
  let prev = null;
  for (const row of rows) {
    const seq = Number(row.seq);
    if (prev === null) {
      if (Number(row.prev_seq) !== GENESIS_PREV_SEQ) {
        return { ok: false, count: 0, seq, error: `genesis entry seq=${seq} has prev_seq=${row.prev_seq}, expected ${GENESIS_PREV_SEQ}` };
      }
      if (row.prev_hash !== GENESIS_PREV_HASH) {
        return { ok: false, count: 0, seq, error: `genesis entry seq=${seq} has prev_hash=${row.prev_hash}, expected ${GENESIS_PREV_HASH}` };
      }
    } else {
      if (Number(row.prev_seq) !== Number(prev.seq)) {
        return { ok: false, count: 0, seq, error: `entry seq=${seq} prev_seq=${row.prev_seq} does not link to predecessor seq=${prev.seq}` };
      }
      if (row.prev_hash !== prev.hash) {
        return { ok: false, count: 0, seq, error: `entry seq=${seq} prev_hash does not match predecessor hash` };
      }
    }
    const expected = computeEntryHash(row);
    if (row.hash !== expected) {
      return { ok: false, count: 0, seq, error: `entry seq=${seq} hash mismatch (stored ${row.hash.slice(0, 12)}…, computed ${expected.slice(0, 12)}…)` };
    }
    prev = row;
  }
  return { ok: true, count: rows.length };
}
