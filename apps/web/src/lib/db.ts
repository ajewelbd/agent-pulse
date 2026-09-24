import { Pool } from 'pg';

/**
 * Read-only database access for the dashboard.
 *
 * The spec says the dashboard performs no write operations. That is enforced
 * here rather than merely intended: every connection sets
 * `default_transaction_read_only`, so an accidental INSERT/UPDATE/DELETE —
 * from a future feature, a copy-pasted query, or a mistake — fails at the
 * database instead of silently mutating ingested history.
 *
 * In compose, DATABASE_URL points at `postgres:5432` over the compose network,
 * never at the published host port.
 */
declare global {
  // eslint-disable-next-line no-var
  var __agentpulsePool: Pool | undefined;
}

function createPool(): Pool {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set — the dashboard cannot start.');
  }
  const pool = new Pool({
    connectionString,
    max: 8,
    // Everything is timestamptz stored UTC; pinning the session zone keeps
    // date_trunc consistent with the turns_day_utc_idx expression index.
    //
    // default_transaction_read_only is the enforcement of "the dashboard never
    // writes". It is set per connection at the server, so it holds for every
    // statement on every pooled connection, including ones a future feature
    // adds without reading this file.
    options: '-c timezone=UTC -c default_transaction_read_only=on',
  });
  pool.on('error', (error) => {
    console.error('postgres pool error', error);
  });
  return pool;
}

/**
 * Lazily constructed, and it matters.
 *
 * `next build` imports every route module to read its config, so anything
 * thrown at module scope fails the build. A dashboard image must be buildable
 * without a database — the database is a runtime dependency, not a build one.
 * Constructing the pool on first query keeps the missing-URL error where it
 * belongs: at the first request, naming the actual problem.
 *
 * The global cache is for dev mode, which re-evaluates modules on every hot
 * reload; without it the process leaks a pool per reload until Postgres
 * refuses new connections.
 */
export function getPool(): Pool {
  const existing = globalThis.__agentpulsePool;
  if (existing) return existing;
  const pool = createPool();
  globalThis.__agentpulsePool = pool;
  return pool;
}

export async function query<T extends Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const result = await getPool().query(text, params);
  return result.rows as T[];
}

export async function queryOne<T extends Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}
