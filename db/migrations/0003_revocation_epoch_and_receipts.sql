-- 0003 — the pieces the revocation cascade needs, for a database created
-- before it existed. Idempotent.

-- Signed URLs already in circulation are killed by bumping this counter; they
-- carry the epoch they were minted under (src/signed-url.ts).
ALTER TABLE contributions ADD COLUMN IF NOT EXISTS revocation_epoch bigint NOT NULL DEFAULT 0;

-- Set only after a read-back confirmed the object is gone.
ALTER TABLE media_assets ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

CREATE TABLE IF NOT EXISTS deletion_receipts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contribution_id uuid NOT NULL REFERENCES contributions(id) ON DELETE CASCADE,
  revoked_at      timestamptz NOT NULL,
  storage_adapter text NOT NULL,
  objects_total   int NOT NULL DEFAULT 0,
  objects_deleted int NOT NULL DEFAULT 0,
  complete        boolean NOT NULL,
  receipt         jsonb NOT NULL,
  receipt_hash    text NOT NULL CHECK (receipt_hash ~ '^[0-9a-f]{64}$'),
  ledger_seq      bigint,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS receipts_contribution_idx ON deletion_receipts(contribution_id);
CREATE INDEX IF NOT EXISTS receipts_incomplete_idx   ON deletion_receipts(created_at) WHERE NOT complete;
