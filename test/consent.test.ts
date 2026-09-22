import { describe, it, expect } from 'vitest';
import {
  BUILTIN_SCOPE_USES,
  consentContext,
  effectiveScope,
  isScopeNarrowing,
  scopeAllows,
} from '../src/consent';

const standing = { revoked: false, scope_uses: ['public-display', 'research'] };
const revoked = { revoked: true, scope_uses: ['public-display', 'research'] };

describe('scopeAllows', () => {
  it('permits a granted use while consent stands', () => {
    expect(scopeAllows(standing, 'public-display')).toBe(true);
    expect(scopeAllows(standing, 'research')).toBe(true);
  });

  it('refuses a use that was never granted', () => {
    expect(scopeAllows(standing, 'machine-processing')).toBe(false);
    expect(scopeAllows(standing, 'education')).toBe(false);
  });

  it('refuses every use once consent is revoked', () => {
    for (const use of BUILTIN_SCOPE_USES) expect(scopeAllows(revoked, use)).toBe(false);
  });

  it('refuses when there is no record at all', () => {
    expect(scopeAllows(null, 'public-display')).toBe(false);
    expect(scopeAllows(undefined, 'public-display')).toBe(false);
  });

  it('refuses when scope_uses is not an array (bad row, missing column)', () => {
    expect(scopeAllows({ revoked: false, scope_uses: null as never }, 'public-display')).toBe(false);
  });

  it('machine processing is opt-in: absence never means permission', () => {
    expect(scopeAllows({ revoked: false, scope_uses: [] }, 'machine-processing')).toBe(false);
    expect(scopeAllows({ revoked: false, scope_uses: ['machine-processing'] }, 'machine-processing')).toBe(true);
  });
});

describe('consentContext', () => {
  it('reports no consent for an empty set', () => {
    expect(consentContext([])).toEqual({ hasConsent: false, consentRevoked: false });
  });

  it('reports standing consent', () => {
    expect(consentContext([{ revoked: false }])).toEqual({ hasConsent: true, consentRevoked: false });
  });

  it('one revoked record revokes the item (consent is not a majority vote)', () => {
    expect(consentContext([{ revoked: false }, { revoked: true }])).toEqual({
      hasConsent: true,
      consentRevoked: true,
    });
  });
});

describe('effectiveScope', () => {
  it('unions standing records without duplicates, order-stable', () => {
    expect(
      effectiveScope([
        { revoked: false, scope_uses: ['public-display', 'research'] },
        { revoked: false, scope_uses: ['research', 'education'] },
      ])
    ).toEqual(['public-display', 'research', 'education']);
  });

  it('collapses to nothing as soon as any record is revoked', () => {
    expect(effectiveScope([{ revoked: false, scope_uses: ['public-display'] }, revoked])).toEqual([]);
  });

  it('is empty for no records', () => {
    expect(effectiveScope([])).toEqual([]);
  });
});

describe('isScopeNarrowing', () => {
  it('accepts a subset', () => {
    expect(isScopeNarrowing(['public-display', 'research'], ['research'])).toBe(true);
    expect(isScopeNarrowing(['public-display'], [])).toBe(true);
  });

  it('rejects a widening that would need fresh consent', () => {
    expect(isScopeNarrowing(['research'], ['research', 'public-display'])).toBe(false);
  });
});
