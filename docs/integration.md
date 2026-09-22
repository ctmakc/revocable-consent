# Wiring it into an application

Four connections. Each one is a small interface you implement against your own
stack.

## 1. The database

Fresh install: apply [`../db/schema.sql`](../db/schema.sql). Existing database:
apply [`../db/migrations/`](../db/migrations/) in order. PostgreSQL 14+.

The ledger helpers take any query function of this shape:

```ts
type QueryFn = <T>(text: string, params?: unknown[]) => Promise<T[]>;

// node-postgres
const query: QueryFn = async (text, params) => (await pool.query(text, params)).rows;
```

## 2. The public surface

Every place that renders material publicly goes through the publish guard.

```ts
import { isPubliclyVisible, consentContext } from 'revocable-consent';

const ctx = consentContext(consentRows);
if (!isPubliclyVisible(row.status, ctx)) return notFound();
```

`status === 'published'` on its own is the bug this function exists to prevent:
it stays true for the window between a consent revocation and whatever human
action updates the status.

## 3. Media delivery

```ts
import { canServeMediaPublicly, mintSignedUrl, NO_SHARED_CACHE_HEADERS } from 'revocable-consent';

export async function GET(req, { params }) {
  const row = await loadAsset(params.id);           // one JOIN: asset + status + consent
  if (!row) return notFound();

  const allowed = canServeMediaPublicly(
    row.status,
    { hasConsent: row.consent_count > 0, consentRevoked: row.consent_revoked },
    row.scope_uses
  );
  if (!allowed) return notFound();

  const url = mintSignedUrl(deliveryBase, {
    key: row.storage_key,
    epoch: Number(row.revocation_epoch),
    ttlMs: 5 * 60_000,
  }, process.env.MEDIA_SIGNING_SECRET);

  return redirect(url, { status: 302, headers: NO_SHARED_CACHE_HEADERS });
}
```

Three rules this encodes:

- **Every outcome that is not "yes" is the same 404.** Wrong scope, revoked
  consent, unpublished, withdrawn, no such id — one indistinguishable answer.
  The existence of unpublished community material must not be inferable from a
  delivery endpoint.
- **Short TTL.** These URLs land in browser history and in referrer-stripped
  copies; they only need to outlive one fetch.
- **`Cache-Control: private, no-store`.** A shared cache that outlives a
  revocation defeats the mechanism.

If your object store mints its own presigned URLs, keep the epoch check: verify
`revocation_epoch` server-side before you presign, and keep the TTL short.

## 4. The moderation console

```ts
import { transition } from 'revocable-consent';

const result = transition(current.status, action, ctx);
if (!result.ok) return conflict(result.error);

// compare-and-set on the status the decision was made against
const updated = await query(
  `UPDATE contributions SET status = $1, updated_at = now()
    WHERE id = $2 AND status = $3
      AND EXISTS (SELECT 1 FROM consent_records r WHERE r.contribution_id = id)
      AND NOT EXISTS (SELECT 1 FROM consent_records r WHERE r.contribution_id = id AND r.revoked)
  RETURNING id`,
  [result.next, id, current.status]
);
if (updated.length === 0) return conflict('the item changed while this action was in flight');
```

The consent guard in the `UPDATE` closes the window between reading the consent
state and writing the new status.

## 5. Revocation

Implement `RevocationPorts` once, against your database and your store:

```ts
const ports: RevocationPorts = {
  load, revokeConsentRecords, bumpRevocationEpoch,
  setStatus, readStatus, markObjectDeleted, appendLedger,
  storage: myStorageAdapter,
  cache: myCdnPurger,              // optional
};

const res = await revokeConsent(ports, id, { actor: 'operator' });
if (res.ok && !res.receipt.complete) {
  await alertOperator(outstandingWork(res.receipt));
}
await storeReceipt(res.receipt, res.ledger_seq);   // deletion_receipts
```

A full, runnable implementation against real SQL is
[`../test/integration/postgres.test.ts`](../test/integration/postgres.test.ts).

## Writing a StorageAdapter

```ts
class S3Adapter implements StorageAdapter {
  readonly name = 's3';
  async presignRead(key, ttlMs) { /* … */ }
  async delete(key) { /* … */ return true; }
  async exists(key) {
    try { await this.client.send(new HeadObjectCommand({ Bucket, Key: key })); return true; }
    catch (e) { if (e.name === 'NotFound') return false; throw e; }
  }
}
```

`exists()` is the one that matters. Make it a real read against the store, and
let it throw on anything ambiguous: an `exists()` that returns `false` when it
means "I could not tell" turns the receipt into a lie.

## Operational notes

- Keep the signing secret out of the repository and rotate it like any other
  credential. Rotating it invalidates every outstanding URL, which is a
  feature.
- Run `verifyLedgerTail()` from your health endpoint and `verifyLedger()` from
  a nightly job.
- Watch `deletion_receipts WHERE NOT complete`. That is the queue of
  revocations the archive still owes someone.
