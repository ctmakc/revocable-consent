# The ledger

An append-only hash chain in PostgreSQL. Each entry commits to its own content
and to its predecessor's hash, so an entry cannot be changed, and an entry
cannot be removed from the middle, without verification failing.

## What it proves, and what it does not

**Proves:** that the sequence of entries you are reading now is the sequence
that was written, and that nothing in the middle was edited or dropped. If an
archive published its chain head anywhere durable — a page, a mailing list, a
tweet — everything before that head is pinned by it.

**Does not prove:** that the archive wrote an entry for every event. An
operator with database access can append, and can truncate the tail. This is an
off-chain, tamper-**evident** record. It is not a blockchain and is never
described as one; the honest claim is "you can tell if the history changed",
and that is the claim this component makes.

## Hash rules

```js
hash = sha256( prev_hash + "\n" + canonicalJson({
  entry_type, contribution_id, actor, payload, prev_hash
}) )
```

`canonicalJson` is deterministic serialisation: object keys sorted recursively,
no whitespace, arrays left in order, `undefined` dropped from objects and
nullified in arrays (matching `JSON.stringify`), and non-JSON values (NaN,
Infinity, functions, symbols, bigints) rejected outright.

The hash is deliberately **seq-independent**: `seq` is a `bigserial` the
database assigns after the hash is computed. The entry commits to its content
and to its predecessor, and linkage carries the ordering.

Payloads are normalised through `JSON.parse(JSON.stringify(payload))` before
hashing, so the value that is stored and the value that was hashed are the same
bytes. Without that step a payload containing, say, a `Date` would hash as
`canonicalJson` sees it and store as `JSON.stringify` sees it — an entry that
could never re-verify, a permanent false tampering alarm baked into the chain.

## Concurrency

`prev_seq` is `UNIQUE` and must equal the predecessor's `seq` (0 for genesis).
Two appends that read the same tail both try to insert the same `prev_seq`; the
second violates the constraint and retries against the fresh tail, up to three
attempts. This needs no transaction, which matters on serverless HTTP database
drivers that do not offer one.

A consequence: `seq` may have **gaps**, because a failed insert still burns a
serial. Verification follows `prev_seq` linkage and never does arithmetic on
`seq`.

## Entry types

| Type | Written when |
|---|---|
| `published` | Material went live |
| `withdrawn` | Previously published material was taken down |
| `consent_revoked` | Consent was withdrawn |
| `media_deleted` | A revocation cascade deleted stored objects; payload carries the receipt hash |

`mint` and `withdraw` are legacy spellings of `published` and `withdrawn`.
Because `entry_type` is hashed, an `UPDATE` that renames them breaks
verification for every row it touches — so a deployment with existing history
keeps what it stored, writes the current vocabulary from then on, and maps the
old spellings at read time with `publicEntryType()`. Both eras verify. See
[`../db/migrations/0002_ledger_entry_type_vocabulary.sql`](../db/migrations/0002_ledger_entry_type_vocabulary.sql).

## Privacy

Payloads are non-PII **by design**, because in most deployments this table is
public and its rows are permanent: titles, collections, licences, permitted
uses, counts and hashes. Names, emails, consent statements and moderation notes
stay in the private tables.

One consequence is easy to miss: writing a `consent_revoked` entry for material
that was never public would disclose that the material existed at all. An
entry belongs on a public chain only for items whose existence is already
public — published at the time, or already on the chain.

## Verifying

```bash
psql "$DATABASE_URL" -At -c \
  "SELECT json_agg(t ORDER BY seq) FROM (SELECT seq, prev_seq, contribution_id, entry_type, actor, payload, prev_hash, hash FROM ledger_entries ORDER BY seq) t" \
  > chain.json

npx verify-ledger --file chain.json
npx verify-ledger --postgres          # needs DATABASE_URL and the pg package
cat chain.json | npx verify-ledger --file -
```

Exit codes: `0` valid, `1` broken (with the failing `seq` and the reason on
stderr), `2` usage or input error.

The verifier is plain ESM JavaScript with no build step and no dependencies in
file mode, so an auditor can read all 101 lines of
[`../src/ledger-core.mjs`](../src/ledger-core.mjs) before running it, and never
has to execute — or trust — the archive's application.

## In the application

```ts
const entry = await appendLedgerEntry(query, {
  contribution_id,
  entry_type: 'published',
  actor: 'operator',
  payload: { title, collection, licence, scope_uses },
});

await verifyLedger(query);      // whole chain, O(n) — for audits and deep health checks
await verifyLedgerTail(query);  // last entry only — cheap enough for a health endpoint
```
