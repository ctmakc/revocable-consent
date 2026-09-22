import { describe, it, expect } from 'vitest';
import { CONSENT_TEMPLATE, consentStatementProblem } from '../src/consent-template';

const filledIn = CONSENT_TEMPLATE.replace('[name]', 'Olena Kravets').replace(
  '[role / relationship to the community]',
  'chair of the community council'
);

describe('consentStatementProblem', () => {
  it('rejects the unedited template verbatim', () => {
    expect(consentStatementProblem(CONSENT_TEMPLATE)).toMatch(/placeholder/);
  });

  it('rejects a statement that still carries one placeholder', () => {
    const half = CONSENT_TEMPLATE.replace('[name]', 'Olena Kravets');
    expect(consentStatementProblem(half)).toMatch(/placeholder/);
  });

  it('rejects the template with the blanks merely filled in', () => {
    expect(consentStatementProblem(filledIn)).toMatch(/blanks filled in/);
  });

  it('sees through reflowed whitespace and case', () => {
    expect(consentStatementProblem(filledIn.replace(/ /g, '\n  ').toUpperCase())).toMatch(
      /blanks filled in/
    );
  });

  it('accepts a statement written in the representative’s own words', () => {
    expect(
      consentStatementProblem(
        'I, Olena Kravets, speaking as the chair of the community council, agree to this recording being held in the archive and shown publicly, and I know I can withdraw that agreement at any time.'
      )
    ).toBeNull();
  });

  it('accepts the template once it is genuinely edited', () => {
    expect(
      consentStatementProblem(
        filledIn.replace(
          'I understand that this consent can be revoked at any time',
          'We agreed at the council meeting on 12 May that any of the three families can end this at any time'
        )
      )
    ).toBeNull();
  });
});
