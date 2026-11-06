// Boundaries of signed-URL minting and verification beyond signed-url.test.ts.
import { describe, it, expect } from 'vitest';
import { mintSignedUrl, signClaims, verifySignedUrl } from '../src/signed-url';

const SECRET = 'test-secret';
const NOW = 1_800_000_000_000;

describe('mintSignedUrl', () => {
  it('defaults to a five-minute lifetime', () => {
    const url = new URL(mintSignedUrl('https://media.example/get', { key: 'k', epoch: 0 }, SECRET, NOW));
    expect(Number(url.searchParams.get('exp'))).toBe(NOW + 5 * 60 * 1000);
  });

  it('honours ttlMs, and an explicit exp wins over ttlMs', () => {
    const a = new URL(mintSignedUrl('https://m.example/', { key: 'k', epoch: 0, ttlMs: 1000 }, SECRET, NOW));
    expect(a.searchParams.get('exp')).toBe(String(NOW + 1000));
    const b = new URL(
      mintSignedUrl('https://m.example/', { key: 'k', epoch: 0, ttlMs: 1000, exp: NOW + 7 }, SECRET, NOW)
    );
    expect(b.searchParams.get('exp')).toBe(String(NOW + 7));
  });

  it('keeps existing query parameters on the base URL and overrides spoofed claim params', () => {
    const url = mintSignedUrl('https://m.example/get?tenant=x&key=evil', { key: 'real', epoch: 3 }, SECRET, NOW);
    const u = new URL(url);
    expect(u.searchParams.get('tenant')).toBe('x');
    expect(u.searchParams.getAll('key')).toEqual(['real']);
    expect(verifySignedUrl(url, SECRET, { currentEpoch: 3, now: NOW }).ok).toBe(true);
  });

  it('round-trips keys with spaces, unicode and reserved characters', () => {
    const key = 'media/архив 2026/a&b=c?.mp3';
    const url = mintSignedUrl('https://m.example/', { key, epoch: 1 }, SECRET, NOW);
    const res = verifySignedUrl(url, SECRET, { currentEpoch: 1, expectKey: key, now: NOW });
    expect(res).toEqual({ ok: true, claims: { key, exp: NOW + 300000, epoch: 1 } });
  });

  it('throws on a base URL that is not absolute', () => {
    expect(() => mintSignedUrl('/relative', { key: 'k', epoch: 0 }, SECRET, NOW)).toThrow();
  });
});

describe('verifySignedUrl boundaries', () => {
  const url = mintSignedUrl('https://m.example/', { key: 'k', epoch: 5, exp: NOW + 1000 }, SECRET, NOW);

  it('is valid one millisecond before exp and expired exactly at exp', () => {
    expect(verifySignedUrl(url, SECRET, { currentEpoch: 5, now: NOW + 999 }).ok).toBe(true);
    expect(verifySignedUrl(url, SECRET, { currentEpoch: 5, now: NOW + 1000 })).toEqual({
      ok: false,
      reason: 'expired',
    });
  });

  it('accepts a URL whose epoch is AHEAD of the stored one (only older epochs are stale)', () => {
    expect(verifySignedUrl(url, SECRET, { currentEpoch: 4, now: NOW }).ok).toBe(true);
    expect(verifySignedUrl(url, SECRET, { currentEpoch: 6, now: NOW })).toEqual({ ok: false, reason: 'stale-epoch' });
  });

  it('accepts a URL object as well as a string', () => {
    expect(verifySignedUrl(new URL(url), SECRET, { currentEpoch: 5, now: NOW }).ok).toBe(true);
  });

  it('reports expiry before staleness when both apply', () => {
    expect(verifySignedUrl(url, SECRET, { currentEpoch: 9, now: NOW + 5000 })).toEqual({
      ok: false,
      reason: 'expired',
    });
  });

  it('reports a key mismatch before expiry', () => {
    expect(verifySignedUrl(url, SECRET, { currentEpoch: 5, expectKey: 'other', now: NOW + 5000 })).toEqual({
      ok: false,
      reason: 'key-mismatch',
    });
  });

  it('treats non-integer or unsafe exp/epoch as malformed', () => {
    for (const [field, value] of [
      ['exp', '1.5'],
      ['exp', 'abc'],
      ['epoch', '9007199254740993'],
      ['epoch', 'NaN'],
    ] as const) {
      const u = new URL(url);
      u.searchParams.set(field, value);
      expect(verifySignedUrl(u, SECRET, { currentEpoch: 5, now: NOW }), `${field}=${value}`).toEqual({
        ok: false,
        reason: 'malformed',
      });
    }
  });

  it('a key containing a newline cannot be verified and is reported malformed, not thrown', () => {
    const u = new URL(url);
    u.searchParams.set('key', 'a\nb');
    expect(verifySignedUrl(u, SECRET, { currentEpoch: 5, now: NOW })).toEqual({ ok: false, reason: 'malformed' });
  });

  it('an empty verification secret is reported malformed, not thrown', () => {
    expect(verifySignedUrl(url, '', { currentEpoch: 5, now: NOW })).toEqual({ ok: false, reason: 'malformed' });
  });

  it('a truncated signature is a bad signature (length-mismatch path)', () => {
    const u = new URL(url);
    u.searchParams.set('sig', u.searchParams.get('sig')!.slice(0, 10));
    expect(verifySignedUrl(u, SECRET, { currentEpoch: 5, now: NOW })).toEqual({ ok: false, reason: 'bad-signature' });
  });
});

describe('signClaims', () => {
  it('is deterministic base64url HMAC-SHA256 (43 chars, no padding)', () => {
    const a = signClaims({ key: 'k', exp: 1, epoch: 0 }, SECRET);
    expect(a).toBe(signClaims({ key: 'k', exp: 1, epoch: 0 }, SECRET));
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});
