# The revocation cascade

## The seven steps

```
1. mark the consent record revoked   database  instant   cannot fail silently
2. bump the revocation epoch         database  instant   kills URLs in flight
3. published → withdrawn             database  instant   compare-and-set
4. delete the stored objects         network   slow      can fail
5. read each key back                network   slow      turns 4 into evidence
6. purge the cache                   network   slow      best effort
7. append the receipt to the ledger  database  fast       tamper-evident record
```

Steps 1–3 are ordered first on purpose: they are cheap, atomic and certain, and
once they land the material is out of public view. Nothing about the public
surface waits on an object store.

## Step 1 — close the gate

```sql
UPDATE consent_records SET revoked = true, revoked_at = $2
 WHERE contribution_id = $1 AND revoked = false
```

The `revoked = false` guard makes this a compare-and-set. Zero rows changed
means a concurrent revocation already won, and the cascade stops with
`consent was already revoked by a concurrent action` rather than producing a
second receipt for the same event.

From this moment `isPubliclyVisible()` is false everywhere, because it reads
consent, rather than status alone.

## Step 2 — kill the URLs already handed out

Signed URLs live in browser histories, chat logs and referrer-stripped copies.
Expiry alone leaves a window as wide as the TTL.

Every URL carries the item's `revocation_epoch` at signing time; verification
compares it with the epoch as it stands now. Bumping the counter invalidates
every URL minted before the revocation, at once. See
[`../src/signed-url.ts`](../src/signed-url.ts).

## Step 3 — catch the status up

`published → withdrawn`, compare-and-set on the status the state machine was
evaluated against. A lost race here does not undo step 1: the revocation
already holds, so the cascade re-reads the status, reports where the item
actually landed, and carries on.

## Steps 4 and 5 — delete, then prove it

```ts
outcome.deleted        = await storage.delete(key);
outcome.verified_absent = !(await storage.exists(key));
```

An adapter that reports a successful delete is not believed until `exists()`
says no. `verified_absent` is the field that carries weight; `deleted` alone is
a claim by the store.

`head()` is called first, when the adapter offers it, so the receipt can record
the size and content hash of what was removed.

## Step 6 — the cache

Purging is best-effort by nature: a CDN may queue, rate-limit or silently drop
a purge. Correctness therefore rests on short-lived, epoch-bound URLs, and the
purge outcome is recorded rather than trusted.

## Step 7 — the receipt

```ts
{
  contribution_id: '…',
  revoked_at: '2026-09-22T12:00:00.000Z',
  previous_status: 'published',
  status: 'withdrawn',
  consent_rows_revoked: 2,
  epoch: 5,
  storage_adapter: 's3',
  objects: [
    { asset_id: '…', key: 'media/song.mp3', deleted: true, verified_absent: true,
      bytes: 4210233, checksum_sha256: '…' }
  ],
  cache_purge: { adapter: 'cdn', ok: true },
  complete: true,
  hash: '…'   // sha256 over the canonical form of everything above
}
```

`hash` is a SHA-256 over the canonical JSON of the receipt with `hash` itself
omitted, so any later edit to the stored receipt is detectable. The hash — and
only non-identifying counts alongside it — goes onto the ledger as a
`media_deleted` entry.

## Partial failure

`complete` is true only when every object was deleted **and** read back as
absent. Anything else leaves listed work:

```ts
outstandingWork(receipt)
// [ 'object media/song.mp3 is still present (store returned 503)' ]
```

The ledger entry records `complete: false` too. An archive that cannot finish a
deletion says so, in the same record where it would have said it did.

Retrying is safe: the consent rows are already revoked, so a second
`revokeConsent()` call refuses. Re-running the deletion is an operator task
against the outstanding keys listed in the receipt, and
`deletion_receipts.complete = false` is indexed for exactly that queue.

## What revocation does not undo

- **Copies other people already downloaded.** No software can reach those. A
  consent statement should say so plainly.
- **Backups and snapshots.** Deleting from the live store leaves backups, and
  their retention window is an operational policy this component cannot
  enforce. Write the window down; the receipt records the live-store deletion
  only.
- **The ledger entries themselves.** They hold non-PII metadata and stay, by
  design: the point is that the history of a takedown survives the takedown.
