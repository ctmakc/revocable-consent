// Pure moderation state machine for contributions.
// Consent-first hard rules:
//   - approve requires a consent record that has not been revoked
//   - publish is ONLY reachable from approved, and only while consent stands
//   - nothing here auto-publishes; every transition is an explicit human action

export type Status =
  | 'submitted'
  | 'in_review'
  | 'needs_consent'
  | 'approved'
  | 'published'
  | 'rejected'
  | 'withdrawn';

export type Action =
  | 'submit'
  | 'review_start'
  | 'request_consent'
  | 'approve'
  | 'reject'
  | 'publish'
  | 'withdraw'
  | 'revoke_consent'
  | 'note';

export interface ConsentContext {
  /** A consent record exists for the contribution. */
  hasConsent: boolean;
  /** The consent record has been revoked. */
  consentRevoked: boolean;
}

export type TransitionResult =
  | { ok: true; next: Status }
  | { ok: false; error: string };

export const STATUSES: Status[] = [
  'submitted',
  'in_review',
  'needs_consent',
  'approved',
  'published',
  'rejected',
  'withdrawn',
];

export const ACTIONS: Action[] = [
  'submit',
  'review_start',
  'request_consent',
  'approve',
  'reject',
  'publish',
  'withdraw',
  'revoke_consent',
  'note',
];

const TERMINAL: Status[] = ['rejected', 'withdrawn'];

/** True when consent is present and standing (not revoked). */
export function consentStands(ctx: ConsentContext): boolean {
  return ctx.hasConsent && !ctx.consentRevoked;
}

/**
 * Publish-guard read. Consent revocation after publication does not flip the
 * stored status by itself (an admin records the withdrawal), so ANY code that
 * renders contributions publicly MUST use this guard, not `status ===
 * 'published'` alone: the moment consent is revoked this returns false and the
 * material drops out of public view, before a human has clicked Withdraw.
 */
export function isPubliclyVisible(status: Status, ctx: ConsentContext): boolean {
  return status === 'published' && consentStands(ctx);
}

/**
 * Compute the next status for (current, action) under the given consent context.
 * Returns { ok:false, error } for any transition the state machine forbids.
 * 'note' is a valid action from any state and does not change status.
 */
export function transition(
  current: Status,
  action: Action,
  ctx: ConsentContext
): TransitionResult {
  if (!STATUSES.includes(current)) return { ok: false, error: `unknown status: ${current}` };
  if (!ACTIONS.includes(action)) return { ok: false, error: `unknown action: ${action}` };

  if (action === 'note') return { ok: true, next: current };

  if (action === 'submit') {
    return { ok: false, error: 'submit is only valid when creating a contribution' };
  }

  if (action === 'revoke_consent') {
    // Consent can be revoked from ANY state that has a consent record —
    // including terminal rejected/withdrawn (revocation is a fact about the
    // consent, recorded post-hoc if need be). If the material is live,
    // revocation auto-unpublishes it: published → withdrawn. Otherwise the
    // status is unchanged; the revoked consent itself blocks approve/publish.
    if (!ctx.hasConsent) return { ok: false, error: 'there is no consent record to revoke' };
    if (ctx.consentRevoked) return { ok: false, error: 'consent has already been revoked' };
    return { ok: true, next: current === 'published' ? 'withdrawn' : current };
  }

  if (TERMINAL.includes(current)) {
    return { ok: false, error: `contribution is ${current}; no further transitions allowed` };
  }

  switch (action) {
    case 'review_start':
      if (current === 'submitted') return { ok: true, next: 'in_review' };
      return { ok: false, error: `review_start requires status submitted (got ${current})` };

    case 'request_consent':
      if (current === 'submitted' || current === 'in_review') {
        return { ok: true, next: 'needs_consent' };
      }
      return { ok: false, error: `request_consent requires submitted or in_review (got ${current})` };

    case 'approve':
      if (current !== 'in_review' && current !== 'needs_consent') {
        return { ok: false, error: `approve requires in_review or needs_consent (got ${current})` };
      }
      if (!ctx.hasConsent) return { ok: false, error: 'approve requires a consent record' };
      if (ctx.consentRevoked) return { ok: false, error: 'consent has been revoked' };
      return { ok: true, next: 'approved' };

    case 'reject':
      if (current === 'submitted' || current === 'in_review' || current === 'needs_consent') {
        return { ok: true, next: 'rejected' };
      }
      return { ok: false, error: `reject requires submitted, in_review or needs_consent (got ${current})` };

    case 'publish':
      if (current !== 'approved') {
        return { ok: false, error: `publish is only allowed from approved (got ${current})` };
      }
      if (!ctx.hasConsent) return { ok: false, error: 'publish requires a consent record' };
      if (ctx.consentRevoked) return { ok: false, error: 'consent has been revoked' };
      return { ok: true, next: 'published' };

    case 'withdraw':
      // Contributors may withdraw at any active stage, including after publication.
      return { ok: true, next: 'withdrawn' };

    default:
      return { ok: false, error: `unknown action: ${action}` };
  }
}
