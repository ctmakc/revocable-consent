# The consent record

## Shape

```ts
interface ConsentRecord {
  contribution_id: string;
  subject_name?: string;        // personal data — private tables only
  subject_role?: string | null;
  licence?: string | null;
  scope_uses: readonly ScopeUse[];
  statement?: string;           // in the subject's own words
  signed_at?: string | Date;
  revoked: boolean;
  revoked_at?: string | Date | null;
}
```

In SQL: `consent_records` in [`db/schema.sql`](../db/schema.sql), with
`scope_uses text[] NOT NULL CHECK (cardinality(scope_uses) > 0)`.

## Scope is a set, never a boolean

A single yes/no field forces an archive to decide later what the yes covered.
The record therefore stores the granted uses explicitly, and code asks about
one use at a time:

```ts
scopeAllows(consent, 'public-display')      // before rendering
scopeAllows(consent, 'machine-processing')  // before handing bytes to a machine
```

The vocabulary shipped here is four terms:

| Term | Meaning |
|---|---|
| `public-display` | May be shown to the public |
| `research` | Access may be granted to named researchers |
| `education` | Use in teaching materials |
| `machine-processing` | The bytes may be handed to an automated system |

`ScopeUse` widens to any string, so an archive can add its own terms without
forking the library. What the library fixes is the *discipline*: ask about the
use you are about to exercise.

`machine-processing` is opt-in by construction. Its absence means the community
never agreed to a machine reading the material, so nothing automated touches
it — no transcription, no indexing, no model input.

## Revocation is recorded, never erased

A revoked record keeps its row and gains `revoked = true, revoked_at = …`. The
fact that consent was given and then withdrawn is part of the archive record,
and a deleted row would make the withdrawal unprovable. A CHECK constraint
keeps the two columns consistent.

Reducing several records to a decision:

```ts
consentContext(records) // { hasConsent, consentRevoked }
effectiveScope(records) // [] as soon as any record is revoked
```

One revoked record revokes the item. Consent is not a majority vote.

## Narrowing and widening

```ts
isScopeNarrowing(before, after)
```

Removing a permitted use is something a subject can do at any time. Adding one
needs a fresh consent record with a fresh statement, because nobody agreed to
the new use.

## The statement

`CONSENT_TEMPLATE` is a starting point an operator rewrites for their
jurisdiction and their community agreements. `consentStatementProblem()`
refuses two things:

1. a statement that still contains the bracket placeholders;
2. the template with nothing changed but the blanks.

The second check masks the placeholder positions and compares the rest, so
typing a name into the form does not count as stating consent in your own
words. A consent gate that boilerplate can satisfy is decoration.

## Standards alignment

The record above was designed from operational need, and it has a recognisable
shape: a consent record with a timestamp, an identified subject, a set of
purposes and a revocation state.

Aligning it formally with
[ISO/IEC TS 27560:2023](https://www.iso.org/standard/80392.html) (consent
record information structure) and the
[W3C Data Privacy Vocabulary](https://w3c.github.io/dpv/), with JSON-LD import
and export, is planned work and is described in
[`roadmap.md`](roadmap.md). This repository ships no mapping table yet, and
claims no conformance. Support for
[Local Contexts](https://localcontexts.org/) TK and BC Labels — the way
Indigenous communities express conditions of access to their own heritage — is
on the same list.
