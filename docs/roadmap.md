# Roadmap

Where this component is now, and what it needs to become something a small
archive can install without writing adapters first.

## Now (0.1.0)

Shipped and tested in this repository:

- the consent record, scope predicates and the boilerplate check;
- the moderation state machine with consent as a hard precondition;
- the publish guard and the scope-gated media delivery decision;
- epoch-bound, short-lived signed URLs;
- the revocation cascade with read-back verification, hashed receipts and
  honest partial-failure reporting;
- the hash-chained ledger, race-safe appends, and a standalone verifier;
- a reference PostgreSQL schema with migrations, and an integration lane
  against a real database.

In production in one archive ([FirstCiv](https://firstciv.com)): the state
machine, the scope gates, the publish guard, short-lived signed delivery and
the ledger. The deletion cascade and the receipts are new here and have no
production installation yet.

## Next

**Storage adapters.** S3-compatible stores (MinIO, Ceph, Backblaze B2,
Cloudflare R2, AWS) and hosted blob stores. Each one needs a real `exists()`
and honest error mapping, because that is what the receipt rests on.

**CDN purge adapters.** Implementations of the `CachePurger` port, with the
outcome recorded rather than assumed.

**ISO/IEC TS 27560 and W3C DPV.** A formal mapping of the consent record onto
the [consent record information
structure](https://www.iso.org/standard/80392.html) and the
[Data Privacy Vocabulary](https://w3c.github.io/dpv/), with JSON-LD import and
export, so a consent record can move between systems instead of being retyped.
This repository ships no mapping and claims no conformance today.

**Local Contexts labels.** Reading TK and BC Labels from the
[Local Contexts Hub](https://localcontexts.org/), displaying them with the
material, and letting them constrain access alongside the scope vocabulary.

**A ledger library with a CLI verifier** that an archive can adopt on its own,
separately from the rest.

**Deployment example.** A worked setup for a small archive: schema, adapters,
console, health checks, backup retention policy stated in writing.

**Documentation in more than English.** French and Spanish at least.

**Independent audit.** Security and accessibility review, with the findings and
the fixes published.

## Funding

This roadmap is the work proposed to
[NLnet](https://nlnet.nl/) under the Restack open call (application prepared
for the 3 November 2026 deadline). The component is released under open
licences regardless of the outcome, and the repository will say plainly which
items are done and which are still on this list.
