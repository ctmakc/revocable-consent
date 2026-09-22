import { describe, it, expect } from 'vitest';
import {
  mintSignedUrl,
  signClaims,
  verifySignedUrl,
  NO_SHARED_CACHE_HEADERS,
} from '../src/signed-url';

const SECRET = 'test-signing-secret';
const BASE = 'https://archive.example/media/abc';
const T0 = 1_700_000_000_000;

describe('mintSignedUrl / verifySignedUrl', () => {
  it('round-trips a fresh URL', () => {
    const url = mintSignedUrl(BASE, { key: 'media/song.mp3', epoch: 3, ttlMs: 60_000 }, SECRET, T0);
    const r = verifySignedUrl(url, SECRET, { currentEpoch: 3, now: T0 + 1_000 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.claims).toEqual({ key: 'media/song.mp3', exp: T0 + 60_000, epoch: 3 });
  });

  it('expires', () => {
    const url = mintSignedUrl(BASE, { key: 'k', epoch: 0, ttlMs: 5_000 }, SECRET, T0);
    expect(verifySignedUrl(url, SECRET, { currentEpoch: 0, now: T0 + 4_999 }).ok).toBe(true);
    const late = verifySignedUrl(url, SECRET, { currentEpoch: 0, now: T0 + 5_000 });
    expect(late).toEqual({ ok: false, reason: 'expired' });
  });

  it('REVOCATION kills URLs already in flight, before they expire', () => {
    const url = mintSignedUrl(BASE, { key: 'k', epoch: 7, ttlMs: 60 * 60_000 }, SECRET, T0);
    // consent is revoked → the item's epoch is bumped
    const r = verifySignedUrl(url, SECRET, { currentEpoch: 8, now: T0 + 1_000 });
    expect(r).toEqual({ ok: false, reason: 'stale-epoch' });
  });

  it('rejects a tampered key, expiry or epoch', () => {
    const url = new URL(mintSignedUrl(BASE, { key: 'k', epoch: 1, ttlMs: 60_000 }, SECRET, T0));
    for (const [param, value] of [
      ['key', 'other'],
      ['exp', String(T0 + 10 * 60_000)],
      ['epoch', '99'],
    ] as const) {
      const bad = new URL(url.toString());
      bad.searchParams.set(param, value);
      expect(verifySignedUrl(bad.toString(), SECRET, { currentEpoch: 1, now: T0 }), param).toEqual({
        ok: false,
        reason: 'bad-signature',
      });
    }
  });

  it('rejects a signature made with another secret', () => {
    const url = mintSignedUrl(BASE, { key: 'k', epoch: 1, ttlMs: 60_000 }, 'other-secret', T0);
    expect(verifySignedUrl(url, SECRET, { currentEpoch: 1, now: T0 })).toEqual({
      ok: false,
      reason: 'bad-signature',
    });
  });

  it('rejects a valid URL presented for a different object', () => {
    const url = mintSignedUrl(BASE, { key: 'media/a.mp3', epoch: 1, ttlMs: 60_000 }, SECRET, T0);
    expect(
      verifySignedUrl(url, SECRET, { currentEpoch: 1, now: T0, expectKey: 'media/b.mp3' })
    ).toEqual({ ok: false, reason: 'key-mismatch' });
  });

  it('rejects missing parameters and malformed input', () => {
    expect(verifySignedUrl(`${BASE}?key=k`, SECRET, { currentEpoch: 0, now: T0 })).toEqual({
      ok: false,
      reason: 'missing-parameters',
    });
    expect(verifySignedUrl('not a url', SECRET, { currentEpoch: 0, now: T0 })).toEqual({
      ok: false,
      reason: 'malformed',
    });
    expect(
      verifySignedUrl(`${BASE}?key=k&exp=abc&epoch=1&sig=x`, SECRET, { currentEpoch: 0, now: T0 })
    ).toEqual({ ok: false, reason: 'malformed' });
  });

  it('checks the signature BEFORE it reports expiry or epoch (no oracle on forged claims)', () => {
    const forged = `${BASE}?key=k&exp=${T0 - 1}&epoch=0&sig=AAAA`;
    expect(verifySignedUrl(forged, SECRET, { currentEpoch: 5, now: T0 })).toEqual({
      ok: false,
      reason: 'bad-signature',
    });
  });

  it('refuses to sign with an empty secret, or a key containing the field separator', () => {
    expect(() => signClaims({ key: 'k', exp: T0, epoch: 0 }, '')).toThrow(/secret/);
    expect(() => signClaims({ key: 'a\nb', exp: T0, epoch: 0 }, SECRET)).toThrow(/newline/);
  });

  it('signatures differ per field (no field-splitting collisions)', () => {
    const a = signClaims({ key: 'ab', exp: 1, epoch: 23 }, SECRET);
    const b = signClaims({ key: 'ab', exp: 12, epoch: 3 }, SECRET);
    expect(a).not.toBe(b);
  });

  it('ships the cache headers a redirect must carry', () => {
    expect(NO_SHARED_CACHE_HEADERS['Cache-Control']).toBe('private, no-store');
  });
});
