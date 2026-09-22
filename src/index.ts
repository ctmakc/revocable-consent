// revocable-consent — public entry point.
//
// Four things, each usable on its own:
//   consent + moderation  — the record and the state machine that gates on it
//   media-access + signed-url — the delivery gate and the URLs it hands out
//   revocation + storage  — the cascade that makes withdrawal take effect
//   ledger                — the hash chain that makes all of it checkable
export {
  BUILTIN_SCOPE_USES,
  consentContext,
  effectiveScope,
  isScopeNarrowing,
  scopeAllows,
  type BuiltinScopeUse,
  type ConsentRecord,
  type ScopeUse,
} from './consent';

export { CONSENT_TEMPLATE, consentStatementProblem } from './consent-template';

export {
  ACTIONS,
  STATUSES,
  consentStands,
  isPubliclyVisible,
  transition,
  type Action,
  type ConsentContext,
  type Status,
  type TransitionResult,
} from './moderation';

export {
  ALLOWED_MIME,
  DIRECT_UPLOAD_THRESHOLD_BYTES,
  INCOMING_PREFIX,
  MAX_CLIENT_MEDIA_BYTES,
  canServeMediaPublicly,
  incomingPathnameValid,
  mediaKindForMime,
  sanitiseFilename,
  uploadVariantFor,
  type UploadVariant,
} from './media-access';

export {
  NO_SHARED_CACHE_HEADERS,
  mintSignedUrl,
  signClaims,
  verifySignedUrl,
  type SignedUrlClaims,
  type SignedUrlFailure,
  type VerifyResult as SignedUrlVerifyResult,
} from './signed-url';

export {
  FailingDeleteAdapter,
  MemoryStorageAdapter,
  type CachePurger,
  type StorageAdapter,
  type StoredObject,
} from './storage';

export {
  outstandingWork,
  receiptHash,
  revokeConsent,
  type ObjectOutcome,
  type RevocationPorts,
  type RevocationReceipt,
  type RevocationResult,
  type RevocationSubject,
} from './revocation';

export {
  GENESIS_PREV_HASH,
  GENESIS_PREV_SEQ,
  LEDGER_ENTRY_TYPES,
  appendLedgerEntry,
  canonicalJson,
  computeEntryHash,
  publicEntryType,
  verifyChain,
  verifyLedger,
  verifyLedgerTail,
  type AppendInput,
  type LedgerEntryRow,
  type LedgerEntryType,
  type LedgerPayload,
  type QueryFn,
  type VerifyResult,
} from './ledger';

export { sha256Hex } from './checksum';
