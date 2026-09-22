// A pre-filled consent statement to offer on an intake form, plus the pure
// check that rejects statements which were never actually edited. Shared by a
// client form and a server-side schema (no dependencies, unit-testable).
//
// The template is a STARTING POINT, not a legal instrument: an operator is
// expected to rewrite it for their own jurisdiction, community agreements and
// permitted-use vocabulary. What matters structurally is the check below —
// boilerplate must never be able to satisfy the consent gate.

export const CONSENT_TEMPLATE = `I, [name], as [role / relationship to the community], confirm that the community I represent consents to this recording being held in this archive under the licence and permitted uses selected above. I understand that this consent can be revoked at any time, that revocation will remove the material from public view, and that nothing will be published before this consent is verified by a human reviewer. Machine processing is only ever performed if the community has explicitly selected the "machine processing" permission above; any resulting output is a draft that a human reviews and approves before it is shown.`;

const PLACEHOLDERS = ['[name]', '[role / relationship to the community]'];

const normalise = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * Returns a human-readable problem with the consent statement, or null if it
 * is acceptable. Rejects the verbatim template and any statement that still
 * contains the unedited bracket placeholders — boilerplate must not satisfy
 * the consent-first gate.
 */
export function consentStatementProblem(statement: string): string | null {
  const lower = statement.toLowerCase();
  for (const p of PLACEHOLDERS) {
    if (lower.includes(p.toLowerCase())) {
      return `the consent statement still contains the placeholder “${p}” — please replace it with the representative’s actual details`;
    }
  }
  if (matchesTemplateShape(statement)) {
    return 'the consent statement is the template with the blanks filled in — please state the consent in the representative’s own words';
  }
  return null;
}

/**
 * True when the statement is the template with nothing changed but the
 * placeholders. Filling in a name is not consenting in your own words, so the
 * check masks the placeholder positions and compares the rest.
 */
function matchesTemplateShape(statement: string): boolean {
  return TEMPLATE_SHAPE.test(normalise(statement));
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The template with each placeholder turned into a short wildcard. */
const TEMPLATE_SHAPE = new RegExp(
  '^' +
    PLACEHOLDERS.reduce<string[]>(
      (parts, p) => parts.flatMap((part) => part.split(normalise(p))),
      [normalise(CONSENT_TEMPLATE)]
    )
      .map(escapeRe)
      .join('[\\s\\S]{0,200}') +
    '$'
);
