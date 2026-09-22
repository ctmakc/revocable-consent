import { describe, it, expect } from 'vitest';
import { transition, consentStands, isPubliclyVisible, STATUSES, type Status } from '../src/moderation';

const withConsent = { hasConsent: true, consentRevoked: false };
const noConsent = { hasConsent: false, consentRevoked: false };
const revoked = { hasConsent: true, consentRevoked: true };

describe('moderation state machine', () => {
  it('walks the happy path submit → review → approve → publish', () => {
    let r = transition('submitted', 'review_start', withConsent);
    expect(r).toEqual({ ok: true, next: 'in_review' });
    r = transition('in_review', 'approve', withConsent);
    expect(r).toEqual({ ok: true, next: 'approved' });
    r = transition('approved', 'publish', withConsent);
    expect(r).toEqual({ ok: true, next: 'published' });
  });

  it('supports the needs_consent detour', () => {
    expect(transition('in_review', 'request_consent', noConsent)).toEqual({ ok: true, next: 'needs_consent' });
    expect(transition('submitted', 'request_consent', noConsent)).toEqual({ ok: true, next: 'needs_consent' });
    expect(transition('needs_consent', 'approve', withConsent)).toEqual({ ok: true, next: 'approved' });
  });

  it('never publishes from any status other than approved', () => {
    for (const s of STATUSES.filter((s) => s !== 'approved')) {
      const r = transition(s as Status, 'publish', withConsent);
      expect(r.ok, `publish from ${s} must fail`).toBe(false);
    }
  });

  it('consent gate: approve requires consent', () => {
    expect(transition('in_review', 'approve', noConsent).ok).toBe(false);
    expect(transition('needs_consent', 'approve', noConsent).ok).toBe(false);
  });

  it('consent gate: revoked consent blocks approve and publish', () => {
    expect(transition('in_review', 'approve', revoked).ok).toBe(false);
    expect(transition('approved', 'publish', revoked).ok).toBe(false);
  });

  it('consent gate: publish without consent is blocked even from approved', () => {
    expect(transition('approved', 'publish', noConsent).ok).toBe(false);
  });

  it('reject works from active pre-approval states only', () => {
    expect(transition('submitted', 'reject', noConsent)).toEqual({ ok: true, next: 'rejected' });
    expect(transition('in_review', 'reject', noConsent)).toEqual({ ok: true, next: 'rejected' });
    expect(transition('needs_consent', 'reject', noConsent)).toEqual({ ok: true, next: 'rejected' });
    expect(transition('published', 'reject', withConsent).ok).toBe(false);
    expect(transition('approved', 'reject', withConsent).ok).toBe(false);
  });

  it('withdraw is allowed from any active state, including published', () => {
    for (const s of ['submitted', 'in_review', 'needs_consent', 'approved', 'published'] as Status[]) {
      expect(transition(s, 'withdraw', withConsent)).toEqual({ ok: true, next: 'withdrawn' });
    }
  });

  it('terminal states accept no transitions except note and revoke_consent', () => {
    for (const s of ['rejected', 'withdrawn'] as Status[]) {
      for (const a of ['review_start', 'request_consent', 'approve', 'publish', 'withdraw', 'reject'] as const) {
        expect(transition(s, a, withConsent).ok, `${a} from ${s}`).toBe(false);
      }
      expect(transition(s, 'note', withConsent)).toEqual({ ok: true, next: s });
    }
  });

  it('note never changes status', () => {
    for (const s of STATUSES) {
      expect(transition(s as Status, 'note', noConsent)).toEqual({ ok: true, next: s });
    }
  });

  it('submit is not a valid runtime transition', () => {
    expect(transition('submitted', 'submit', withConsent).ok).toBe(false);
  });

  it('review_start only from submitted', () => {
    expect(transition('in_review', 'review_start', withConsent).ok).toBe(false);
    expect(transition('approved', 'review_start', withConsent).ok).toBe(false);
  });

  it('revoke_consent: valid from ANY state with standing consent, including terminal', () => {
    for (const s of STATUSES.filter((x) => x !== 'published')) {
      // status unchanged everywhere except published
      expect(transition(s as Status, 'revoke_consent', withConsent)).toEqual({ ok: true, next: s });
    }
  });

  it('revoke_consent from published auto-unpublishes (→ withdrawn)', () => {
    expect(transition('published', 'revoke_consent', withConsent)).toEqual({ ok: true, next: 'withdrawn' });
  });

  it('revoke_consent requires a consent record and rejects double revocation', () => {
    expect(transition('published', 'revoke_consent', noConsent).ok).toBe(false);
    expect(transition('in_review', 'revoke_consent', noConsent).ok).toBe(false);
    expect(transition('published', 'revoke_consent', revoked).ok).toBe(false);
    expect(transition('withdrawn', 'revoke_consent', revoked).ok).toBe(false);
  });

  it('consentStands helper', () => {
    expect(consentStands(withConsent)).toBe(true);
    expect(consentStands(noConsent)).toBe(false);
    expect(consentStands(revoked)).toBe(false);
  });
});

describe('isPubliclyVisible (publish-guard read)', () => {
  it('is true only for published with standing consent', () => {
    expect(isPubliclyVisible('published', { hasConsent: true, consentRevoked: false })).toBe(true);
  });
  it('goes false the moment consent is revoked, without a status change', () => {
    expect(isPubliclyVisible('published', { hasConsent: true, consentRevoked: true })).toBe(false);
  });
  it('is false for every non-published status', () => {
    for (const s of STATUSES.filter((x) => x !== 'published')) {
      expect(isPubliclyVisible(s, { hasConsent: true, consentRevoked: false })).toBe(false);
    }
  });
});
