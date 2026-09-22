-- 0002 — entry_type vocabulary: accept 'published' / 'withdrawn' alongside the
-- legacy 'mint' / 'withdraw', and add 'media_deleted' for deletion receipts.
--
-- WHY THE OLD VALUES STAY. entry_type is one of the fields each entry's hash
-- commits to. An `UPDATE ledger_entries SET entry_type = 'published' WHERE
-- entry_type = 'mint'` would make every touched row fail verification, and the
-- whole point of the chain is that it cannot be rewritten. So a deployment
-- with existing history keeps what it stored, writes the new vocabulary from
-- here on, and maps the old spellings at READ time with publicEntryType()
-- from src/ledger.ts. Both eras verify.
--
-- A deployment that has never written a ledger entry may narrow the CHECK to
-- the four current values; the statement is at the bottom, commented out.

ALTER TABLE ledger_entries DROP CONSTRAINT IF EXISTS ledger_entries_entry_type_check;
ALTER TABLE ledger_entries ADD CONSTRAINT ledger_entries_entry_type_check
  CHECK (entry_type IN ('published','withdrawn','consent_revoked','media_deleted','mint','withdraw'));

-- Empty-ledger deployments only (verify with: SELECT count(*) FROM ledger_entries;)
-- ALTER TABLE ledger_entries DROP CONSTRAINT ledger_entries_entry_type_check;
-- ALTER TABLE ledger_entries ADD CONSTRAINT ledger_entries_entry_type_check
--   CHECK (entry_type IN ('published','withdrawn','consent_revoked','media_deleted'));
