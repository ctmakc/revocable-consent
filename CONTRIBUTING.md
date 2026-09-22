# Contributing

Thanks for looking. This is a small component with a narrow job, and the rules
below exist to keep it that way.

## Ground rule

The consent rules are load-bearing. A change to the state machine, the publish
guard, the delivery gate or the cascade comes with a test that fails without
the change. "It obviously works" is how a publish path that ignores a revoked
consent record gets merged.

## Getting set up

```bash
git clone https://github.com/ctmakc/revocable-consent.git
cd revocable-consent
npm install
npm test          # no database needed
npm run typecheck
```

The Postgres lane is opt-in:

```bash
docker compose up -d postgres
RC_INTEGRATION=1 DATABASE_URL=postgres://rc:rc@127.0.0.1:55433/rc npm run test:integration
docker compose down -v
```

## House style

- **No runtime dependencies.** The `dependencies` field stays empty. A new
  dependency needs an argument that survives "what happens when it is
  unmaintained in three years and an archive is still running this".
- **Pure modules.** Database access, HTTP and SDKs go behind ports. Anything in
  `src/` should be testable without a network.
- **Comments explain why.** The what is in the code. Write down the failure
  mode a piece of defensive code exists for — future readers will otherwise
  remove it.
- **Honest naming.** The ledger is tamper-evident, and calling it a blockchain
  is a rejected pull request.
- **Non-PII payloads.** Nothing identifying goes into `ledger_entries`, ever.

## Pull requests

1. One concern per pull request.
2. `npm test` and `npm run typecheck` pass.
3. New behaviour is documented in `docs/`, and `CHANGELOG.md` gains a line
   under "Unreleased".
4. Schema changes come with a migration in `db/migrations/`, numbered and
   idempotent, plus the same change in `db/schema.sql`.
5. Say in the description what you tested, and how.

## Reporting a security issue

Privately, please — see [SECURITY.md](SECURITY.md). Do not open a public issue
for a vulnerability.

## Licensing of contributions

Code contributions are accepted under Apache-2.0, documentation under CC BY
4.0, matching the repository's licences. By opening a pull request you confirm
you have the right to contribute the work under those terms.

## Code of conduct

Be decent. Assume the person on the other side is working in good faith on
something that matters to a community they answer to. Harassment, and
dismissiveness about the communities this software serves, are not welcome
here.
