# Architecture

## Shape

Everything in `src/` is a pure module with no database, no HTTP and no SDK in
it. The outside world arrives through two small interfaces — `StorageAdapter`
and `RevocationPorts` — which is what makes the whole component testable in
milliseconds and portable across hosts.

```
                       ┌──────────────────────────┐
   intake form ───────▶│ consent-template         │  refuses boilerplate
                       └──────────────────────────┘
                                   │
                       ┌──────────────────────────┐
   review console ────▶│ moderation (state machine)│ publish needs standing consent
                       └──────────────────────────┘
                                   │
        ┌──────────────────────────┼──────────────────────────┐
        ▼                          ▼                          ▼
┌───────────────┐        ┌──────────────────┐        ┌────────────────┐
│ media-access  │        │ revocation       │        │ ledger         │
│ delivery gate │        │ the cascade      │───────▶│ hash chain     │
└───────┬───────┘        └────────┬─────────┘        └────────────────┘
        │                         │                           ▲
        ▼                         ▼                           │
┌───────────────┐        ┌──────────────────┐                 │
│ signed-url    │◀───────│ storage adapter  │  receipts ──────┘
│ epoch-bound   │ epoch  │ delete + exists  │
└───────────────┘        └──────────────────┘
```

## The four questions

**Is there consent, and for what?** `consent.ts`. A record holds a set of
separately granted uses. `scopeAllows(record, use)` is the only way to ask, and
it takes the specific use as an argument, so no caller can accidentally treat
"consent exists" as "this is allowed".

**May this be public?** `moderation.ts`. The state machine owns every
transition. `isPubliclyVisible(status, ctx)` is the single read every public
surface goes through; it is false the instant a consent row is marked revoked,
without waiting for a human to change the status.

**May these bytes leave the server?** `media-access.ts` plus `signed-url.ts`.
`canServeMediaPublicly` requires the publish guard **and** `public-display` in
scope. The URL that comes back is short-lived, bound to one storage key, and
carries the item's revocation epoch.

**What actually happened?** `revocation.ts` and `ledger.ts`. The cascade
produces a receipt; the receipt's hash goes onto an append-only chain.

## Why ports

The pieces that differ between deployments are exactly the pieces that fail in
interesting ways: object stores, CDNs, database drivers. Putting them behind
ports means the failure handling lives in tested, host-independent code, and a
new storage backend is an adapter rather than a fork.

```ts
interface StorageAdapter {
  readonly name: string;
  presignRead(key: string, ttlMs: number): Promise<string | null>;
  delete(key: string): Promise<boolean>;
  exists(key: string): Promise<boolean>;   // the one that turns a claim into evidence
  head?(key: string): Promise<StoredObject | null>;
}
```

`RevocationPorts` adds the database side: load the item, revoke the consent
rows (compare-and-set), bump the epoch, set the status (compare-and-set),
record deletions, append to the ledger.

## Concurrency

No step assumes it is alone.

- Revoking consent is `UPDATE … WHERE revoked = false` and returns a row count.
  A second, concurrent revocation gets zero rows and is told so.
- Status changes are `UPDATE … WHERE status = $expected`. A lost race is
  recorded and the real status is reported, because the revocation itself
  already holds.
- Ledger appends use a `UNIQUE` constraint on `prev_seq`: two racing appends
  cannot both link to the same predecessor, and the loser retries against the
  new tail (up to three attempts).

## What a host must provide

| Need | Why |
|---|---|
| PostgreSQL 14+ | `db/schema.sql`; array and jsonb columns, `gen_random_uuid()` |
| A private object store | Public buckets defeat the delivery gate entirely |
| A signing secret | For `signed-url.ts`, if you use the built-in signer |
| Node 20+ | ES2022, `node:crypto` |
