// The consent record itself: what an operator stores, and the pure predicates
// every other module asks about it. No DB, no network, no dependencies.
//
// SCOPE IS THE POINT. A consent record is never a single yes/no — it is a set
// of separately granted uses. Public display, research access and machine
// processing are different permissions, and code must gate on the specific one
// it is about to exercise (see `scopeAllows`), never on "consent exists".

/**
 * The permitted-use vocabulary this reference implementation ships with.
 * It is deliberately small and operator-extendable: `ScopeUse` widens to any
 * string so an archive can add its own terms without forking the library.
 *
 * - `public-display`    — the material may be shown to the public
 * - `research`          — access may be granted to named researchers
 * - `education`         — use in teaching materials
 * - `machine-processing`— the bytes may be handed to an automated system
 *                         (transcription, indexing, model input). Opt-in only:
 *                         its ABSENCE means the community never agreed to
 *                         machine disclosure, so nothing automated may read it.
 */
export const BUILTIN_SCOPE_USES = [
  'public-display',
  'research',
  'education',
  'machine-processing',
] as const;

export type BuiltinScopeUse = (typeof BUILTIN_SCOPE_USES)[number];
export type ScopeUse = BuiltinScopeUse | (string & {});

/**
 * A consent record as stored. `licence` is free-form on purpose — an operator
 * picks their own vocabulary (CC0, CC-BY, community-restricted, a local
 * agreement reference). Revocation is recorded on the record, never by
 * deleting it: the fact that consent was given and then withdrawn is itself
 * part of the archive record.
 */
export interface ConsentRecord {
  /** Opaque id of the record this consent covers. */
  contribution_id: string;
  /** Who granted it (a person or a community body). Personal data — keep it out of the ledger. */
  subject_name?: string;
  /** Their relationship to the material or community. */
  subject_role?: string | null;
  /** Licence or agreement reference chosen at signing time. */
  licence?: string | null;
  /** The separately granted permitted uses. */
  scope_uses: readonly ScopeUse[];
  /** The consent statement in the subject's own words. */
  statement?: string;
  signed_at?: string | Date;
  revoked: boolean;
  revoked_at?: string | Date | null;
}

/**
 * Reduce one or more consent records for the same item to the context the
 * state machine and the delivery gates take. A single revoked record revokes
 * the item: consent is not a majority vote.
 */
export function consentContext(records: readonly Pick<ConsentRecord, 'revoked'>[]): {
  hasConsent: boolean;
  consentRevoked: boolean;
} {
  return {
    hasConsent: records.length > 0,
    consentRevoked: records.some((r) => r.revoked),
  };
}

/**
 * Does standing consent permit this specific use? False for a revoked record,
 * false for a use that was never granted. Call it with the use you are about
 * to exercise — `scopeAllows(c, 'machine-processing')` before handing bytes to
 * an automated system, `'public-display'` before serving them publicly.
 */
export function scopeAllows(
  record: Pick<ConsentRecord, 'revoked' | 'scope_uses'> | null | undefined,
  use: ScopeUse
): boolean {
  if (!record) return false;
  if (record.revoked) return false;
  if (!Array.isArray(record.scope_uses)) return false;
  return record.scope_uses.includes(use);
}

/**
 * The effective scope across several records for one item: empty as soon as
 * any record is revoked, otherwise the intersection-free union of what is
 * still standing. Deduplicated, order-stable.
 */
export function effectiveScope(
  records: readonly Pick<ConsentRecord, 'revoked' | 'scope_uses'>[]
): ScopeUse[] {
  if (records.some((r) => r.revoked)) return [];
  const out: ScopeUse[] = [];
  for (const r of records) {
    for (const u of r.scope_uses ?? []) if (!out.includes(u)) out.push(u);
  }
  return out;
}

/** Narrowing a scope is always allowed; widening it needs fresh consent. */
export function isScopeNarrowing(
  before: readonly ScopeUse[],
  after: readonly ScopeUse[]
): boolean {
  return after.every((u) => before.includes(u));
}
