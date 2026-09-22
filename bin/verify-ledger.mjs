#!/usr/bin/env node
// Standalone ledger verifier.
//
// Recomputes every entry hash from genesis and checks prev_seq / prev_hash
// linkage. The point of shipping it as a separate CLI with no build step and
// no dependencies is that an auditor can verify an archive's chain without
// running — or trusting — the archive's application.
//
//   verify-ledger --file exported-chain.json
//   verify-ledger --postgres            # needs DATABASE_URL and the `pg` package
//   verify-ledger --file - < chain.json
//
// Exit codes: 0 chain valid · 1 chain broken · 2 usage or input error.
import { readFileSync } from 'node:fs';
import { verifyChain } from '../src/ledger-core.mjs';

const COLUMNS =
  'seq, prev_seq, contribution_id, entry_type, actor, payload, prev_hash, hash';

function usage(message) {
  if (message) console.error(`verify-ledger: ${message}`);
  console.error(`
Usage:
  verify-ledger --file <path|->      verify an exported JSON array of entries
  verify-ledger --postgres [--table ledger_entries]
                                     verify straight from Postgres (DATABASE_URL)

Export the chain from Postgres without this tool:
  psql "$DATABASE_URL" -At -c \\
    "SELECT json_agg(t ORDER BY seq) FROM (SELECT ${COLUMNS} FROM ledger_entries ORDER BY seq) t" \\
    > chain.json
`);
  process.exit(2);
}

const argv = process.argv.slice(2);
function flag(name) {
  const i = argv.indexOf(name);
  return i === -1 ? null : argv[i + 1] ?? '';
}

async function rowsFromFile(path) {
  const raw = path === '-' ? readFileSync(0, 'utf8') : readFileSync(path, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    usage(`could not parse ${path === '-' ? 'stdin' : path} as JSON: ${err.message}`);
  }
  const rows = Array.isArray(parsed) ? parsed : parsed?.rows ?? parsed?.entries;
  if (!Array.isArray(rows)) usage('expected a JSON array of ledger entries');
  return rows;
}

async function rowsFromPostgres(table) {
  if (!process.env.DATABASE_URL) usage('DATABASE_URL is not set');
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) usage(`invalid table name: ${table}`);
  let pg;
  try {
    pg = await import('pg');
  } catch {
    usage('the `pg` package is not installed (npm i pg), or use --file');
  }
  const client = new (pg.default ?? pg).Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const res = await client.query(`SELECT ${COLUMNS} FROM ${table} ORDER BY seq ASC`);
    return res.rows;
  } finally {
    await client.end();
  }
}

const filePath = flag('--file');
const rows = argv.includes('--postgres')
  ? await rowsFromPostgres(flag('--table') || 'ledger_entries')
  : filePath !== null
    ? await rowsFromFile(filePath || usage('--file needs a path (or - for stdin)'))
    : usage('choose --file or --postgres');

const result = verifyChain(rows);
if (result.ok) {
  console.log(`verify-ledger: OK — ${result.count} entries, chain valid from genesis`);
  process.exit(0);
}
console.error(`verify-ledger: FAIL at seq=${result.seq}: ${result.error}`);
process.exit(1);
