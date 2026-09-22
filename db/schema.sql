-- revocable-consent — reference schema (PostgreSQL 14+).
--
-- The full current shape, for a fresh database. An existing deployment should
-- apply db/migrations/*.sql in order instead; this file is what those
-- migrations add up to.
--
-- Naming: a "contribution" is one submitted item (a recording, a photograph, a
-- document). Everything else hangs off it.

CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- gen_random_uuid()

-- ---------------------------------------------------------------------------
-- The item itself.
-- `revocation_epoch` is what makes revocation immediate for URLs already in
-- circulation: every signed URL carries the epoch it was minted under, and a
-- revocation bumps this counter (see src/signed-url.ts).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS contributions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  collection       text,
  title            text NOT NULL,
  status           text NOT NULL DEFAULT 'submitted'
                   CHECK (status IN ('submitted','in_review','needs_consent','approved','published','rejected','withdrawn')),
  revocation_epoch bigint NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Consent. Scope is an ARRAY of separately granted uses, never a boolean.
-- Revocation is recorded on the row; the row is never deleted, because "consent
-- was given and then withdrawn" is itself part of the record.
-- Personal data lives here and ONLY here — never in ledger_entries.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS consent_records (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contribution_id   uuid NOT NULL REFERENCES contributions(id) ON DELETE CASCADE,
  subject_name      text NOT NULL,
  subject_role      text,
  licence           text,
  scope_uses        text[] NOT NULL CHECK (cardinality(scope_uses) > 0),
  consent_statement text NOT NULL,
  signed_at         timestamptz NOT NULL DEFAULT now(),
  revoked           boolean NOT NULL DEFAULT false,
  revoked_at        timestamptz,
  CONSTRAINT consent_revoked_at_consistent
    CHECK ((revoked AND revoked_at IS NOT NULL) OR (NOT revoked AND revoked_at IS NULL))
);

-- ---------------------------------------------------------------------------
-- Stored objects. `storage_key` is opaque to this component — whatever the
-- StorageAdapter understands. `deleted_at` is set only after a read-back
-- confirmed the object is gone (src/revocation.ts step 5).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS media_assets (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contribution_id uuid NOT NULL REFERENCES contributions(id) ON DELETE CASCADE,
  kind            text CHECK (kind IN ('image','audio','video','document')),
  storage_key     text NOT NULL,
  mime            text,
  bytes           bigint,
  original_name   text,
  checksum_sha256 text CHECK (checksum_sha256 IS NULL OR checksum_sha256 ~ '^[0-9a-f]{64}$'),
  checksum_source text NOT NULL DEFAULT 'server' CHECK (checksum_source IN ('server','client')),
  deleted_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Every state-machine action a human took. The actions are exactly the ones
-- src/moderation.ts accepts.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS moderation_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contribution_id uuid NOT NULL REFERENCES contributions(id) ON DELETE CASCADE,
  actor           text NOT NULL,
  action          text NOT NULL CHECK (action IN ('submit','review_start','request_consent','approve','reject','publish','withdraw','revoke_consent','note')),
  note            text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- The ledger: an append-only hash chain. Off-chain and tamper-EVIDENT — not a
-- blockchain, and never described as one.
--
-- prev_seq carries the concurrency control: it is UNIQUE and must equal the
-- predecessor's seq (0 for genesis), so two racing appends cannot both insert;
-- the loser retries against the new tail. seq (bigserial) may therefore have
-- GAPS, and verification follows prev_seq linkage, never seq arithmetic.
--
-- PAYLOADS ARE NON-PII BY DESIGN. In most deployments this table is public and
-- its rows are permanent: titles, collections, licences, counts and hashes —
-- never names, emails, statements or notes.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ledger_entries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq             bigserial UNIQUE NOT NULL,
  prev_seq        bigint UNIQUE NOT NULL,
  contribution_id uuid REFERENCES contributions(id),
  entry_type      text NOT NULL CHECK (entry_type IN ('published','withdrawn','consent_revoked','media_deleted','mint','withdraw')),
  actor           text NOT NULL,
  payload         jsonb NOT NULL,
  prev_hash       text NOT NULL,
  hash            text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
COMMENT ON COLUMN ledger_entries.entry_type IS
  'Current vocabulary: published, withdrawn, consent_revoked, media_deleted. '
  '"mint" and "withdraw" are the legacy spellings of published/withdrawn and are '
  'still accepted because entry_type is hashed: renaming them in place would break '
  'verification. Map them at READ time with publicEntryType().';

-- ---------------------------------------------------------------------------
-- Deletion receipts: the evidence a revocation produces. One row per cascade
-- run, holding the hash of the receipt that also went onto the ledger.
-- `complete` false means listed, outstanding work — never a silent partial.
-- ---------------------------------------------------------------------------
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

CREATE INDEX IF NOT EXISTS contributions_status_idx      ON contributions(status);
CREATE INDEX IF NOT EXISTS consent_contribution_idx      ON consent_records(contribution_id);
CREATE INDEX IF NOT EXISTS consent_revoked_idx           ON consent_records(contribution_id) WHERE revoked;
CREATE INDEX IF NOT EXISTS media_contribution_idx        ON media_assets(contribution_id);
CREATE INDEX IF NOT EXISTS modevents_contribution_idx    ON moderation_events(contribution_id);
CREATE INDEX IF NOT EXISTS ledger_contribution_idx       ON ledger_entries(contribution_id);
CREATE INDEX IF NOT EXISTS receipts_contribution_idx     ON deletion_receipts(contribution_id);
CREATE INDEX IF NOT EXISTS receipts_incomplete_idx       ON deletion_receipts(created_at) WHERE NOT complete;
