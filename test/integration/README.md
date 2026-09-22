# Integration lane

These tests need a real PostgreSQL. They are **off by default** so that a clean
clone passes `npm test` with nothing but Node installed.

```bash
docker compose up -d postgres
RC_INTEGRATION=1 DATABASE_URL=postgres://rc:rc@127.0.0.1:55433/rc npm run test:integration
docker compose down -v
```

`DATABASE_URL` may point at any PostgreSQL 14+ you are willing to have the
tests write to: they create their own schema in a scratch namespace
(`rc_integration_test`) and drop it afterwards.

Without `RC_INTEGRATION=1` the lane is excluded by `vitest.config.ts`. With the
flag set but no `DATABASE_URL`, every test in the lane skips itself and says so.
