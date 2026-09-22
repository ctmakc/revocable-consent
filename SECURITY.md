# Security policy

## Reporting a vulnerability

Report privately through GitHub's
[private vulnerability reporting](https://github.com/ctmakc/revocable-consent/security/advisories/new)
on this repository. If that is unavailable to you, open an issue that says only
"security report, please make contact" with no details, and a maintainer will
arrange a private channel.

Please include what you found, how to reproduce it, and what an attacker gets.
A proof of concept helps.

**Expect:** an acknowledgement within 7 days, an assessment within 14, and
credit in the advisory and the changelog unless you would rather not be named.
This is a small project maintained by one person, so those are targets set in
good faith rather than a contractual SLA.

Please hold off on public disclosure for 90 days, or until a fix ships if that
comes sooner.

## Supported versions

Version 0.1.0 is the current release, and the only supported one. Security
fixes land on `main`.

## What counts

This component's security properties, and therefore what a report should be
measured against:

| Property | Meaning |
|---|---|
| Consent gates the public surface | No path renders or serves material whose consent is missing or revoked |
| Scope is enforced per use | `public-display` gates delivery; `machine-processing` gates automated reads |
| Revocation is immediate | Signed URLs issued before a revocation stop verifying at once (epoch check) |
| Delivery failures are indistinguishable | Wrong scope, revoked, unpublished, and non-existent all return the same 404 |
| The ledger is tamper-evident | An edited or removed entry breaks verification |
| Receipts reflect reality | `complete: true` only after a read-back confirmed every object is gone |
| Ledger payloads carry no PII | Nothing identifying reaches a table that is usually public |

A way to break any of those is a vulnerability. So is a path that reveals the
existence of unpublished material, or a signature check that can be bypassed.

## Out of scope

- The absence of storage and CDN adapters. Shipping them is roadmap work, not a
  vulnerability.
- Copies already downloaded before a revocation, and backup retention. Both are
  named in [`docs/revocation.md`](docs/revocation.md) as things this component
  cannot reach.
- The ledger's inability to prove that an entry was written for every event. It
  is tamper-evident, not a blockchain, and says so.
- Weaknesses in an operator's own adapter, deployment or secret handling.

## Notes for operators

- The signing secret for `signed-url.ts` is a credential. Keep it out of the
  repository, and rotate it like one; rotation invalidates every outstanding
  URL, which is the intended behaviour under abuse.
- Keep the object store private. A public bucket defeats the delivery gate
  completely.
- Run `verifyLedgerTail()` from a health check and `verifyLedger()` nightly.
- Watch `deletion_receipts WHERE NOT complete`: that queue is revocations the
  archive still owes someone.
