// Short-lived signed read URLs, with no object-store SDK involved.
//
// Why this exists: the delivery rule is "a stored object may be read only
// while consent stands", and a signed URL is the only thing that leaves the
// server. So the signature must (a) expire quickly, (b) be bound to exactly
// one storage key, and (c) carry a revocation epoch, so that revoking consent
// invalidates every URL already handed out without waiting for it to expire.
//
// The HMAC scheme here is a complete, dependency-free implementation an
// operator can put in front of a private store (or use as the shape their
// store's own presigner must satisfy — see storage.ts).
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface SignedUrlClaims {
  /** The storage key being granted. */
  key: string;
  /** Expiry, epoch milliseconds. */
  exp: number;
  /**
   * Revocation epoch of the item at signing time. Bump the stored epoch on
   * revocation and every previously issued URL stops verifying immediately.
   */
  epoch: number;
}

export type SignedUrlFailure =
  | 'missing-parameters'
  | 'malformed'
  | 'bad-signature'
  | 'expired'
  | 'stale-epoch'
  | 'key-mismatch';

export type VerifyResult =
  | { ok: true; claims: SignedUrlClaims }
  | { ok: false; reason: SignedUrlFailure };

const FIELD_SEP = '\n';

function payload(claims: SignedUrlClaims): string {
  if (claims.key.includes(FIELD_SEP)) throw new Error('signed-url: key must not contain a newline');
  return ['v1', claims.key, String(claims.exp), String(claims.epoch)].join(FIELD_SEP);
}

/** Raw signature over the claims. Exposed for tests and for custom transports. */
export function signClaims(claims: SignedUrlClaims, secret: string): string {
  if (!secret) throw new Error('signed-url: a non-empty signing secret is required');
  return createHmac('sha256', secret).update(payload(claims)).digest('base64url');
}

/**
 * Mint a signed URL for `key`, valid for `ttlMs` from now.
 * `baseUrl` is whatever serves the bytes; query parameters are appended.
 */
export function mintSignedUrl(
  baseUrl: string,
  claims: Omit<SignedUrlClaims, 'exp'> & { exp?: number; ttlMs?: number },
  secret: string,
  now: number = Date.now()
): string {
  const exp = claims.exp ?? now + (claims.ttlMs ?? 5 * 60 * 1000);
  const full: SignedUrlClaims = { key: claims.key, exp, epoch: claims.epoch };
  const url = new URL(baseUrl);
  url.searchParams.set('key', full.key);
  url.searchParams.set('exp', String(full.exp));
  url.searchParams.set('epoch', String(full.epoch));
  url.searchParams.set('sig', signClaims(full, secret));
  return url.toString();
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Verify a signed URL. `currentEpoch` is the item's revocation epoch as it
 * stands RIGHT NOW: a URL signed before a revocation carries a lower epoch and
 * is rejected as `stale-epoch`, which is what makes revocation immediate.
 * Pass `expectKey` when the route already knows which object it is serving.
 */
export function verifySignedUrl(
  url: string | URL,
  secret: string,
  opts: { currentEpoch: number; expectKey?: string; now?: number }
): VerifyResult {
  const now = opts.now ?? Date.now();
  let params: URLSearchParams;
  try {
    params = (url instanceof URL ? url : new URL(url)).searchParams;
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  const key = params.get('key');
  const expRaw = params.get('exp');
  const epochRaw = params.get('epoch');
  const sig = params.get('sig');
  if (!key || !expRaw || !epochRaw || !sig) return { ok: false, reason: 'missing-parameters' };

  const exp = Number(expRaw);
  const epoch = Number(epochRaw);
  if (!Number.isSafeInteger(exp) || !Number.isSafeInteger(epoch)) {
    return { ok: false, reason: 'malformed' };
  }

  const claims: SignedUrlClaims = { key, exp, epoch };
  let expected: string;
  try {
    expected = signClaims(claims, secret);
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  // Signature first: everything below leaks information about a claim set that
  // was never ours to begin with.
  if (!constantTimeEqual(sig, expected)) return { ok: false, reason: 'bad-signature' };
  if (opts.expectKey !== undefined && opts.expectKey !== key) return { ok: false, reason: 'key-mismatch' };
  if (now >= exp) return { ok: false, reason: 'expired' };
  if (epoch < opts.currentEpoch) return { ok: false, reason: 'stale-epoch' };
  return { ok: true, claims };
}

/**
 * Response headers a signed-URL redirect must carry. A shared cache that
 * outlives a revocation would defeat the whole mechanism.
 */
export const NO_SHARED_CACHE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'Cache-Control': 'private, no-store',
});
