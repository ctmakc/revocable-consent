# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **Package entry point** — relative imports in `src/` now carry `.js`
  extensions, so the built `dist/index.js` loads under Node's native ESM loader
  (it failed with `ERR_MODULE_NOT_FOUND` before). A test builds the package and
  imports it in a plain Node process.
- **Ledger** — `appendLedgerEntry` hashes `contribution_id` in the form a
  Postgres `uuid` column returns (lowercase, hyphenated), so an id passed in
  upper case, with braces or without hyphens no longer produces an entry that
  can never re-verify.
- **Ledger** — `publicEntryType('constructor')` and other `Object.prototype`
  names return the input instead of a prototype member.
- **Ledger verification** — `verifyChain` reports a row without a stored hash,
  or a non-object row, as a failed verification instead of throwing.
- **verify-ledger CLI** — an unreadable file or an unreachable database exits
  2 (input error) with a one-line message instead of 1 ("chain broken") with a
  stack trace; the database URL is never echoed.
- **Revocation** — a failing optional `head()` metadata read no longer skips
  the delete of that object; the error is still recorded on the outcome.
- **Signed URLs** — `verifySignedUrl` fails closed (`stale-epoch`) when
  `currentEpoch` is missing or not a number, instead of accepting every URL.

## [0.1.0] — 2026-09-22

First public release. Extracted from [FirstCiv](https://firstciv.com) and
generalised, with the deletion cascade and receipts added here.

### Added

- **Consent model** (`src/consent.ts`) — consent records with separately
  granted uses, `scopeAllows`, `consentContext`, `effectiveScope` and
  `isScopeNarrowing`.
- **Consent statement check** (`src/consent-template.ts`) — a starter template
  plus a check that refuses both the unedited template and the template with
  the blanks merely filled in.
- **Moderation state machine** (`src/moderation.ts`) — seven states, nine
  actions; `approve` and `publish` require standing consent; `revoke_consent`
  moves published material straight to withdrawn; `isPubliclyVisible` as the
  single publish guard.
- **Media delivery gate** (`src/media-access.ts`) — `canServeMediaPublicly`
  requires the publish guard and `public-display` in scope, plus the intake
  rules for uploads (accepted MIME types, filename sanitising, staged-path
  validation, direct-upload threshold).
- **Signed URLs** (`src/signed-url.ts`) — HMAC-SHA256 URLs bound to one storage
  key, a short expiry and a revocation epoch, so links already in circulation
  stop verifying the moment consent is withdrawn. Constant-time comparison;
  signature checked before expiry and epoch.
- **Storage port** (`src/storage.ts`) — `StorageAdapter` with a first-class
  `exists()` for deletion read-back, an optional `CachePurger` port,
  `MemoryStorageAdapter` and `FailingDeleteAdapter`.
- **Revocation cascade** (`src/revocation.ts`) — the seven ordered steps, a
  hashed receipt, `complete: false` with `outstandingWork()` on partial
  failure, and a non-PII ledger entry carrying the receipt hash.
- **Ledger** (`src/ledger.ts`, `src/ledger-core.mjs`) — canonical JSON, entry
  hashing, chain verification, race-safe appends over a `UNIQUE prev_seq`
  constraint, whole-chain and tail verification. Entry vocabulary
  `published` / `withdrawn` / `consent_revoked` / `media_deleted`, with the
  legacy `mint` / `withdraw` spellings mapped at read time.
- **Standalone verifier** (`bin/verify-ledger.mjs`) — verify a chain from a
  JSON export, from stdin, or straight from PostgreSQL; no build step, no
  dependencies in file mode.
- **Reference schema** (`db/schema.sql`, `db/migrations/`) — contributions,
  consent records, media assets, moderation events, ledger entries and
  deletion receipts, with a revocation epoch on each item.
- **Tests** — 105 unit tests with no database, plus an opt-in PostgreSQL lane
  (`docker compose up -d postgres`) covering concurrent appends, tamper
  detection and the full cascade against real SQL.
- Apache-2.0 for code, CC BY 4.0 for documentation.

### Changed from the FirstCiv original

- Ledger entry types renamed from `mint` / `withdraw` to `published` /
  `withdrawn`. Because `entry_type` is hashed, existing chains keep their
  stored values and map them at read time — see
  `db/migrations/0002_ledger_entry_type_vocabulary.sql`.
- The consent statement check now catches the template with its placeholders
  filled in, which the original accepted.
- Vocabulary generalised away from one archive's domain (`culture_slug` became
  `collection`, `ai-processing` became `machine-processing`).
- Object-store specifics moved behind `StorageAdapter`; no vendor SDK remains
  in the library.

### Known gaps

Storage adapters beyond the in-memory one, CDN purge implementations, the
ISO/IEC TS 27560 and W3C DPV mapping, and Local Contexts label support are all
unimplemented. See [`docs/roadmap.md`](docs/roadmap.md).

[Unreleased]: https://github.com/ctmakc/revocable-consent/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/ctmakc/revocable-consent/releases/tag/v0.1.0
