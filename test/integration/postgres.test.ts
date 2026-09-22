// Integration lane: the ledger and the revocation cascade against a real
// PostgreSQL. Off by default — see test/integration/README.md.
//
// What it proves that the unit tests cannot: the concurrency control is a real
// UNIQUE constraint (two parallel appends, one retry, one valid chain), the
// schema in db/schema.sql actually applies, and the cascade's compare-and-set
// writes behave under real SQL.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { appendLedgerEntry, verifyLedger, type QueryFn } from '../../src/ledger';
import { revokeConsent, type RevocationPorts } from '../../src/revocation';
import { MemoryStorageAdapter } from '../../src/storage';
import type { Status } from '../../src/moderation';

const SCHEMA_NS = 'rc_integration_test';
const url = process.env.DATABASE_URL;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let client: any;
let q: QueryFn;

const describeDb = url ? describe : describe.skip;
if (!url) {
  // eslint-disable-next-line no-console
  console.warn('integration: DATABASE_URL is not set — skipping the Postgres lane');
}

describeDb('postgres integration', () => {
  beforeAll(async () => {
    const pg = await import('pg');
    const { Client } = (pg as unknown as { default?: typeof import('pg') }).default ?? pg;
    client = new Client({ connectionString: url });
    await client.connect();
    await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA_NS} CASCADE`);
    await client.query(`CREATE SCHEMA ${SCHEMA_NS}`);
    await client.query(`SET search_path TO ${SCHEMA_NS}, public`);
    const schema = readFileSync(fileURLToPath(new URL('../../db/schema.sql', import.meta.url)), 'utf8');
    await client.query(schema);
    q = (async (text: string, params: unknown[] = []) =>
      (await client.query(text, params)).rows) as QueryFn;
  }, 60_000);

  afterAll(async () => {
    if (client) {
      await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA_NS} CASCADE`);
      await client.end();
    }
  });

  async function seedContribution(status: Status = 'published') {
    const { rows } = await client.query(
      `INSERT INTO contributions (collection, title, status) VALUES ($1, $2, $3) RETURNING id, revocation_epoch`,
      ['demo', 'Integration item', status]
    );
    const id = rows[0].id as string;
    await client.query(
      `INSERT INTO consent_records (contribution_id, subject_name, licence, scope_uses, consent_statement)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, 'A. Representative', 'CC-BY', ['public-display', 'research'], 'Stated in their own words.']
    );
    const asset = await client.query(
      `INSERT INTO media_assets (contribution_id, kind, storage_key, mime, bytes)
       VALUES ($1, 'audio', $2, 'audio/mpeg', 1234) RETURNING id`,
      [id, `media/${Date.now()}-song.mp3`]
    );
    return { id, assetId: asset.rows[0].id as string, key: asset.rows[0].storage_key ?? null };
  }

  it('applies db/schema.sql and appends a verifiable chain', async () => {
    const { id } = await seedContribution();
    await appendLedgerEntry(q, {
      contribution_id: id,
      entry_type: 'published',
      actor: 'operator',
      payload: { title: 'Integration item', collection: 'demo', scope_uses: ['public-display'] },
    });
    await appendLedgerEntry(q, {
      contribution_id: id,
      entry_type: 'withdrawn',
      actor: 'operator',
      payload: { title: 'Integration item', collection: 'demo' },
    });
    const result = await verifyLedger(q);
    expect(result.ok).toBe(true);
    expect(result.count).toBeGreaterThanOrEqual(2);
  });

  it('two concurrent appends produce one valid chain (UNIQUE prev_seq, one retry)', async () => {
    const { id } = await seedContribution();
    const entry = (n: number) => ({
      contribution_id: id,
      entry_type: 'published' as const,
      actor: 'operator',
      payload: { title: `concurrent ${n}` },
    });
    const [a, b] = await Promise.all([appendLedgerEntry(q, entry(1)), appendLedgerEntry(q, entry(2))]);
    expect(Number(a.seq)).not.toBe(Number(b.seq));
    expect(await verifyLedger(q)).toMatchObject({ ok: true });
  });

  it('rejects a tampered row on re-verification', async () => {
    const { id } = await seedContribution();
    const entry = await appendLedgerEntry(q, {
      contribution_id: id,
      entry_type: 'published',
      actor: 'operator',
      payload: { title: 'Before tampering' },
    });
    await client.query(`UPDATE ledger_entries SET payload = $1 WHERE seq = $2`, [
      JSON.stringify({ title: 'After tampering' }),
      entry.seq,
    ]);
    const result = await verifyLedger(q);
    expect(result.ok).toBe(false);
    expect(result.seq).toBe(Number(entry.seq));
    // Put it back so the later assertions in this file are not poisoned.
    await client.query(`UPDATE ledger_entries SET payload = $1 WHERE seq = $2`, [
      JSON.stringify({ title: 'Before tampering' }),
      entry.seq,
    ]);
    expect((await verifyLedger(q)).ok).toBe(true);
  });

  it('runs the revocation cascade end to end against real SQL', async () => {
    const { id, assetId } = await seedContribution();
    const { rows: assetRows } = await client.query(
      `SELECT id, storage_key FROM media_assets WHERE contribution_id = $1`,
      [id]
    );
    const storage = new MemoryStorageAdapter();
    for (const a of assetRows) storage.put(a.storage_key, 'bytes');

    const ports: RevocationPorts = {
      async load() {
        const { rows } = await client.query(
          `SELECT c.status,
                  (SELECT count(*)::int FROM consent_records r WHERE r.contribution_id = c.id) AS n,
                  (SELECT bool_or(r.revoked) FROM consent_records r WHERE r.contribution_id = c.id) AS revoked
             FROM contributions c WHERE c.id = $1`,
          [id]
        );
        if (rows.length === 0) return null;
        return {
          contribution_id: id,
          status: rows[0].status as Status,
          hasConsent: rows[0].n > 0,
          consentRevoked: Boolean(rows[0].revoked),
          objects: assetRows.map((a: { id: string; storage_key: string }) => ({
            asset_id: a.id,
            key: a.storage_key,
          })),
        };
      },
      async revokeConsentRecords(_id, at) {
        const { rowCount } = await client.query(
          `UPDATE consent_records SET revoked = true, revoked_at = $2
            WHERE contribution_id = $1 AND revoked = false`,
          [id, at]
        );
        return rowCount ?? 0;
      },
      async bumpRevocationEpoch() {
        const { rows } = await client.query(
          `UPDATE contributions SET revocation_epoch = revocation_epoch + 1
            WHERE id = $1 RETURNING revocation_epoch`,
          [id]
        );
        return Number(rows[0].revocation_epoch);
      },
      async setStatus(_id, from, to) {
        const { rowCount } = await client.query(
          `UPDATE contributions SET status = $1, updated_at = now() WHERE id = $2 AND status = $3`,
          [to, id, from]
        );
        return (rowCount ?? 0) > 0;
      },
      async readStatus() {
        const { rows } = await client.query(`SELECT status FROM contributions WHERE id = $1`, [id]);
        return (rows[0]?.status as Status) ?? null;
      },
      async markObjectDeleted(aid, at) {
        await client.query(`UPDATE media_assets SET deleted_at = $2 WHERE id = $1`, [aid, at]);
      },
      async appendLedger(entry) {
        return appendLedgerEntry(q, entry);
      },
      storage,
    };

    const res = await revokeConsent(ports, id, { actor: 'operator' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.receipt.complete).toBe(true);
    expect(res.receipt.status).toBe('withdrawn');
    expect(storage.keys()).toEqual([]);

    await client.query(
      `INSERT INTO deletion_receipts (contribution_id, revoked_at, storage_adapter, objects_total, objects_deleted, complete, receipt, receipt_hash, ledger_seq)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        id,
        res.receipt.revoked_at,
        res.receipt.storage_adapter,
        res.receipt.objects.length,
        res.receipt.objects.filter((o) => o.verified_absent).length,
        res.receipt.complete,
        JSON.stringify(res.receipt),
        res.receipt.hash,
        res.ledger_seq,
      ]
    );

    const after = await client.query(
      `SELECT c.status, c.revocation_epoch,
              (SELECT bool_and(r.revoked) FROM consent_records r WHERE r.contribution_id = c.id) AS all_revoked,
              (SELECT count(*)::int FROM media_assets m WHERE m.contribution_id = c.id AND m.deleted_at IS NOT NULL) AS deleted,
              (SELECT count(*)::int FROM deletion_receipts d WHERE d.contribution_id = c.id AND d.complete) AS receipts
         FROM contributions c WHERE c.id = $1`,
      [id]
    );
    expect(after.rows[0].status).toBe('withdrawn');
    expect(after.rows[0].all_revoked).toBe(true);
    expect(Number(after.rows[0].revocation_epoch)).toBe(1);
    expect(after.rows[0].deleted).toBe(assetRows.length);
    expect(after.rows[0].receipts).toBe(1);
    expect(assetId).toBeTruthy();
    expect((await verifyLedger(q)).ok).toBe(true);
  });
});
