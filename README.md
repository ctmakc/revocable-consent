# revocable-consent

**Consent you can actually take back.** A small, dependency-free component for
archives, museums and community collections: a consent record with separately
granted uses, a state machine that refuses to publish without standing consent,
media delivery that closes the moment consent is withdrawn, a revocation
cascade that deletes the stored bytes and reads them back to prove it, and a
hash-chained ledger that makes the whole history checkable by an outsider.

Most consent tooling stops at recording a yes. The hard part starts at the no:
a withdrawal has to reach the public page, the CDN, the signed URLs already in
someone's browser history, the object store, and the record of what happened.
This component is that path, written down as code.

---

## The problem

A community hands an archive a recording. They agree to a public display, and
they say no to machine processing. Two years later they change their mind about
everything.

What has to happen, and what usually does:

| Step | What an archive can usually promise | What this component does |
|---|---|---|
| Take the item off the public page | Yes | Yes, before anything else runs |
| Stop serving the file | "The link expires in a few hours" | Every URL already issued stops verifying immediately |
| Delete the stored bytes | "We'll get to it" | Deletes, then reads the key back and records the result |
| Prove it happened | An email | A signed receipt, hashed into an append-only chain |
| Show what was never allowed | Free-text notes | Scope gates checked per use, per request |

## What is in the box

| Module | What it does |
|---|---|
| `src/consent.ts` | The consent record and its predicates. Scope is a set of separately granted uses, never one boolean. |
| `src/consent-template.ts` | A starter consent statement, and the check that refuses boilerplate: filling in the blanks does not count as consenting in your own words. |
| `src/moderation.ts` | The state machine. `publish` is reachable only from `approved`, only while consent stands; revoking consent auto-unpublishes. |
| `src/media-access.ts` | The delivery gate: one function that decides whether a stored object may be served, and the intake rules around uploads. |
| `src/signed-url.ts` | Short-lived HMAC signed URLs bound to one key and to a **revocation epoch** — the mechanism that kills links already in circulation. |
| `src/storage.ts` | The storage port the cascade deletes through, plus an in-memory implementation. |
| `src/revocation.ts` | The cascade itself, in order, with a hashed receipt and an honest `complete: false` when something is left undone. |
| `src/ledger.ts`, `src/ledger-core.mjs` | The append-only hash chain: canonical JSON, entry hashing, chain verification, race-safe appends. |
| `bin/verify-ledger.mjs` | A standalone verifier an auditor can run without the archive's application. |
| `db/` | Reference PostgreSQL schema and migrations. |

Zero runtime dependencies. Node 20+. TypeScript, with the ledger core kept in
plain ESM JavaScript so the verifier runs with nothing installed.

## How consent works here

A consent record carries a **set of permitted uses**, and code gates on the
specific use it is about to exercise:

```ts
import { scopeAllows } from 'revocable-consent';

const consent = {
  revoked: false,
  scope_uses: ['public-display', 'research'],
};

scopeAllows(consent, 'public-display');     // true  — show it
scopeAllows(consent, 'machine-processing'); // false — never granted
```

`machine-processing` is opt-in by construction: its absence means the community
never agreed to a machine reading the material, so nothing automated may touch
it. The same applies to any term an operator adds — `ScopeUse` widens to any
string, so an archive can use its own vocabulary without forking the library.

Publication runs through a state machine that treats consent as a hard
precondition, rather than a field someone remembers to check:

```
submitted ──review_start──▶ in_review ──approve──▶ approved ──publish──▶ published
    │                           │                                            │
    └────request_consent────▶ needs_consent                        withdraw/revoke
                                                                             ▼
                                                                        withdrawn
```

`approve` and `publish` both refuse when consent is missing or revoked.
`revoke_consent` is legal from any state that has a consent record, and it
moves `published` straight to `withdrawn`.

One rule carries the public surface:

```ts
isPubliclyVisible(status, ctx)  // status === 'published' && consent stands
```

Any code that renders material publicly calls this, never `status ===
'published'` on its own. The moment a consent row is marked revoked, every such
read answers no — before a human has clicked anything.

## How revocation works

Order is the design. Each step closes a different door, and the cheap, certain
doors close first.

```
1. mark consent revoked        → every read gate answers "no"            (instant)
2. bump the revocation epoch   → signed URLs already issued stop working (instant)
3. published → withdrawn       → the stored status catches up            (instant)
4. delete the stored objects   → the bytes go                            (can fail)
5. read each key back          → deletion becomes evidence               (can fail)
6. purge the cache             → shortens the tail of stale copies       (best effort)
7. append a receipt            → the evidence becomes tamper-evident
```

Steps 1–3 are database writes that take effect at once, so the public surface
closes before a single byte is touched. Steps 4–5 are the part that can
partially fail, and a partial failure is reported:

```ts
const res = await revokeConsent(ports, contributionId, { actor: 'operator' });

res.receipt.complete       // false when any object survived
outstandingWork(res.receipt)
// [ 'object media/song.mp3 is still present (store returned 503)' ]
```

A deletion nobody read back is a claim. `verified_absent` on each object is the
field that carries weight, and `complete` is true only when every object was
deleted **and** confirmed gone. The receipt is hashed and the hash goes onto
the ledger, so "we deleted it on the 4th" becomes something a third party can
check.

### The signed-URL epoch

A short expiry alone leaves a window: a URL minted a minute before the
revocation keeps working until it expires. Every URL therefore carries the
item's revocation epoch, and the verifier compares it with the epoch as it
stands now:

```ts
const url = mintSignedUrl(base, { key, epoch: 4, ttlMs: 3_600_000 }, secret);
// …consent is revoked, the item's epoch becomes 5…
verifySignedUrl(url, secret, { currentEpoch: 5 });
// { ok: false, reason: 'stale-epoch' }
```

Redirects carry `Cache-Control: private, no-store`, so no shared cache outlives
a revocation.

## The ledger

An append-only hash chain in PostgreSQL. Each entry commits to its content and
to its predecessor's hash, so history cannot be rewritten without breaking
verification.

This is an off-chain, tamper-**evident** archive record. It is not a
blockchain, it is never described as one, and an operator with database access
can still append or truncate the tail — what they cannot do is silently change
what is already there, or drop an entry from the middle.

Entries are `published`, `withdrawn`, `consent_revoked` and `media_deleted`.
Payloads are non-PII by design: titles, collections, licences, counts and
hashes. Names, emails, statements and notes stay in the private tables.

Anyone can check a published chain without trusting the archive's software:

```bash
psql "$DATABASE_URL" -At -c \
  "SELECT json_agg(t ORDER BY seq) FROM (SELECT seq, prev_seq, contribution_id, entry_type, actor, payload, prev_hash, hash FROM ledger_entries ORDER BY seq) t" \
  > chain.json

npx verify-ledger --file chain.json
# verify-ledger: OK — 412 entries, chain valid from genesis
```

## Quick start

```bash
git clone https://github.com/ctmakc/revocable-consent.git
cd revocable-consent
npm install
npm test          # 105 tests, no database required
npm run typecheck
npm run build
```

Wire the cascade to your own storage and database by implementing two small
interfaces — `StorageAdapter` (presign, delete, exists) and `RevocationPorts`
(load, revoke rows, bump epoch, set status, append ledger). `MemoryStorageAdapter`
is a runnable example of the first; `test/integration/postgres.test.ts` is a
runnable example of the second, against real SQL.

The database side lives in `db/schema.sql` (fresh install) and
`db/migrations/` (existing deployments).

### Integration tests

```bash
docker compose up -d postgres
RC_INTEGRATION=1 DATABASE_URL=postgres://rc:rc@127.0.0.1:55433/rc npm run test:integration
docker compose down -v
```

They apply `db/schema.sql` into a scratch schema, exercise the chain under
concurrent appends, tamper with a row to watch verification fail, and run the
full cascade against real SQL.

## Status and honesty

Version 0.1.0. The extracted layer is in production in one archive
([FirstCiv](https://firstciv.com)) with the state machine, the scope gates, the
publish guard, the short-lived signed delivery and the ledger; this repository
is that layer, generalised, plus a reference implementation of the deletion
cascade and the receipts.

What is **not** here yet, stated plainly:

- storage adapters for S3-compatible stores and hosted blob stores (the
  in-memory adapter is the only implementation shipped);
- CDN purge adapters (the `CachePurger` port exists, implementations do not);
- a formal mapping of the consent record onto
  [ISO/IEC TS 27560:2023](https://www.iso.org/standard/80392.html) and the
  [W3C Data Privacy Vocabulary](https://w3c.github.io/dpv/), and JSON-LD
  import/export;
- support for [Local Contexts](https://localcontexts.org/) TK and BC Labels;
- external users. FirstCiv is the first and so far only installation.

Those are the roadmap, and they are the work proposed for funding — see
[`docs/roadmap.md`](docs/roadmap.md).

## Documentation

- [`docs/architecture.md`](docs/architecture.md) — the pieces and how they fit
- [`docs/consent-model.md`](docs/consent-model.md) — the record, scopes, standards alignment
- [`docs/revocation.md`](docs/revocation.md) — the cascade, failure modes, receipts
- [`docs/ledger.md`](docs/ledger.md) — hash rules, concurrency, what it does and does not prove
- [`docs/integration.md`](docs/integration.md) — wiring it into an application
- [`docs/roadmap.md`](docs/roadmap.md) — what comes next

## Licence

Code is [Apache-2.0](LICENSE). Documentation (`README.md`, `docs/`) is
[CC BY 4.0](LICENSE-docs). See [NOTICE](NOTICE).

## Security

Please report vulnerabilities privately — see [SECURITY.md](SECURITY.md).

## Contributing

[CONTRIBUTING.md](CONTRIBUTING.md). Short version: the consent rules are
load-bearing, so a change to them comes with tests that fail without it.

## Origin and AI assistance

Extracted from [FirstCiv](https://firstciv.com), an archive of community-held
cultural material, by its author. Parts of this repository — documentation
prose, the generalisation of the extracted modules, and test scaffolding — were
drafted with AI assistance under the author's direction, then reviewed, edited
and approved by the author, who is responsible for all of it.
