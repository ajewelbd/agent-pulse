/**
 * Migration runner.
 *
 * Runs as a one-shot `migrate` service, never on app boot: two collector
 * replicas racing each other through DDL is a corruption path, and "it only
 * happens when both start at once" is exactly the bug you cannot reproduce.
 * A session-level advisory lock makes the race impossible even if someone runs
 * this by hand while the service is starting.
 *
 * Commands:
 *   migrate up                 apply every pending migration
 *   migrate down --to <v> --yes  roll back to (and including) version v+1
 *   migrate down --yes         roll back exactly one migration
 *   migrate status             show applied/pending, verify checksums
 *   migrate verify             exit non-zero if any checksum drifted
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Client } = pg;

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

/**
 * Fixed key for pg_advisory_lock. Arbitrary but must never change — a
 * different key would let an old and a new runner hold "the lock"
 * simultaneously and defeat the whole point.
 */
const LOCK_KEY = 8274619283746n;

const LOCK_TIMEOUT_MS = 60_000;
const CONNECT_MAX_ATTEMPTS = 10;

interface Migration {
  version: number;
  name: string;
  upSql: string;
  downSql: string;
  checksum: string;
}

interface AppliedRow {
  version: number;
  name: string;
  checksum: string;
  appliedAt: Date;
}

function loadMigrations(): Migration[] {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'));
  const byVersion = new Map<number, { name: string; up?: string; down?: string }>();

  for (const file of files) {
    const match = /^(\d+)_(.+)\.(up|down)\.sql$/.exec(file);
    if (!match) {
      throw new Error(
        `Migration file "${file}" does not match NNN_name.(up|down).sql — refusing to guess its order.`,
      );
    }
    const version = Number(match[1]);
    const name = match[2]!;
    const direction = match[3] as 'up' | 'down';

    const entry = byVersion.get(version) ?? { name };
    if (entry.name !== name) {
      throw new Error(
        `Version ${version} has two different names ("${entry.name}" and "${name}"). Versions must be unique.`,
      );
    }
    entry[direction] = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    byVersion.set(version, entry);
  }

  const migrations: Migration[] = [];
  for (const [version, entry] of [...byVersion.entries()].sort((a, b) => a[0] - b[0])) {
    if (entry.up === undefined) throw new Error(`Version ${version} has no .up.sql`);
    // Every migration must be reversible. A missing down file is a design
    // error, not something to discover during an incident at 2am.
    if (entry.down === undefined) {
      throw new Error(
        `Version ${version} (${entry.name}) has no .down.sql — every migration must be reversible.`,
      );
    }
    migrations.push({
      version,
      name: entry.name,
      upSql: entry.up,
      downSql: entry.down,
      // Checksum covers BOTH directions: editing a down script after the fact
      // is just as dangerous as editing an up script.
      checksum: createHash('sha256').update(entry.up).update(entry.down).digest('hex').slice(0, 16),
    });
  }
  return migrations;
}

async function connect(): Promise<pg.Client> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set. See .env.example.');
  }

  // The compose healthcheck gates startup, but a healthy postgres can still
  // refuse connections for a beat during recovery. Back off rather than
  // crash-loop the one-shot service.
  let lastError: unknown;
  for (let attempt = 1; attempt <= CONNECT_MAX_ATTEMPTS; attempt++) {
    const client = new Client({ connectionString });
    try {
      await client.connect();
      // Every timestamp in this schema is timestamptz stored UTC. Pinning the
      // session zone keeps date_trunc and any hand-run query consistent with
      // the turns_day_utc_idx expression index.
      await client.query("SET TIME ZONE 'UTC'");
      return client;
    } catch (error) {
      lastError = error;
      await client.end().catch(() => {});
      const delayMs = Math.min(1000 * 2 ** (attempt - 1), 10_000);
      process.stderr.write(
        `postgres not ready (attempt ${attempt}/${CONNECT_MAX_ATTEMPTS}), retrying in ${delayMs}ms\n`,
      );
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw new Error(`Could not connect to postgres after ${CONNECT_MAX_ATTEMPTS} attempts: ${String(lastError)}`);
}

async function ensureRegistry(client: pg.Client): Promise<void> {
  // Bootstrapped by the runner rather than by a migration 000, so that the
  // table recording migrations is never itself a pending migration.
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version      int PRIMARY KEY,
      name         text NOT NULL,
      checksum     text NOT NULL,
      applied_at   timestamptz NOT NULL DEFAULT now(),
      execution_ms int NOT NULL
    )
  `);
}

async function acquireLock(client: pg.Client): Promise<void> {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    const { rows } = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1) AS locked',
      [LOCK_KEY.toString()],
    );
    if (rows[0]?.locked) return;
    if (Date.now() > deadline) {
      throw new Error(
        `Another migration run holds the advisory lock and did not release it within ${LOCK_TIMEOUT_MS}ms.`,
      );
    }
    process.stderr.write('waiting for migration lock…\n');
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function getApplied(client: pg.Client): Promise<AppliedRow[]> {
  const { rows } = await client.query<{
    version: number;
    name: string;
    checksum: string;
    applied_at: Date;
  }>('SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version');
  return rows.map((r) => ({
    version: r.version,
    name: r.name,
    checksum: r.checksum,
    appliedAt: r.applied_at,
  }));
}

/**
 * An applied migration whose file has since been edited means the database and
 * the repository disagree about what the schema is. Silently continuing would
 * let that drift compound.
 */
function checkDrift(migrations: Migration[], applied: AppliedRow[]): string[] {
  const byVersion = new Map(migrations.map((m) => [m.version, m]));
  const problems: string[] = [];
  for (const row of applied) {
    const migration = byVersion.get(row.version);
    if (!migration) {
      problems.push(`version ${row.version} (${row.name}) is applied but its file is missing`);
      continue;
    }
    if (migration.checksum !== row.checksum) {
      problems.push(
        `version ${row.version} (${row.name}) was edited after being applied ` +
          `(recorded ${row.checksum}, file ${migration.checksum})`,
      );
    }
  }
  return problems;
}

async function runUp(client: pg.Client, migrations: Migration[]): Promise<void> {
  const applied = await getApplied(client);
  const drift = checkDrift(migrations, applied);
  if (drift.length > 0) {
    throw new Error(`Refusing to migrate — schema drift detected:\n  ${drift.join('\n  ')}`);
  }

  const appliedVersions = new Set(applied.map((a) => a.version));
  const pending = migrations.filter((m) => !appliedVersions.has(m.version));

  if (pending.length === 0) {
    process.stdout.write('Nothing to apply — schema is up to date.\n');
    return;
  }

  for (const migration of pending) {
    const label = `${String(migration.version).padStart(3, '0')}_${migration.name}`;
    process.stdout.write(`applying  ${label} … `);
    const startedAt = Date.now();
    // One transaction per migration: a failure rolls that migration back
    // completely and leaves every earlier one applied, so a re-run resumes
    // from the failure rather than from zero.
    await client.query('BEGIN');
    try {
      await client.query(migration.upSql);
      await client.query(
        `INSERT INTO schema_migrations (version, name, checksum, execution_ms)
         VALUES ($1, $2, $3, $4)`,
        [migration.version, migration.name, migration.checksum, Date.now() - startedAt],
      );
      await client.query('COMMIT');
      process.stdout.write(`ok (${Date.now() - startedAt}ms)\n`);
    } catch (error) {
      await client.query('ROLLBACK');
      process.stdout.write('FAILED\n');
      throw error;
    }
  }
}

async function runDown(client: pg.Client, migrations: Migration[], toVersion: number | null): Promise<void> {
  const applied = await getApplied(client);
  if (applied.length === 0) {
    process.stdout.write('Nothing to roll back.\n');
    return;
  }

  const byVersion = new Map(migrations.map((m) => [m.version, m]));
  // Newest first — a rollback must unwind in reverse dependency order.
  const targets = [...applied]
    .sort((a, b) => b.version - a.version)
    .filter((row) => (toVersion === null ? row.version === applied[applied.length - 1]!.version : row.version > toVersion));

  if (targets.length === 0) {
    process.stdout.write(`Already at or below version ${toVersion}.\n`);
    return;
  }

  for (const row of targets) {
    const migration = byVersion.get(row.version);
    if (!migration) {
      throw new Error(
        `Cannot roll back version ${row.version} (${row.name}) — its .down.sql is missing from the repository.`,
      );
    }
    const label = `${String(migration.version).padStart(3, '0')}_${migration.name}`;
    process.stdout.write(`reverting ${label} … `);
    const startedAt = Date.now();
    await client.query('BEGIN');
    try {
      await client.query(migration.downSql);
      await client.query('DELETE FROM schema_migrations WHERE version = $1', [migration.version]);
      await client.query('COMMIT');
      process.stdout.write(`ok (${Date.now() - startedAt}ms)\n`);
    } catch (error) {
      await client.query('ROLLBACK');
      process.stdout.write('FAILED\n');
      throw error;
    }
  }
}

async function showStatus(client: pg.Client, migrations: Migration[]): Promise<number> {
  const applied = await getApplied(client);
  const appliedByVersion = new Map(applied.map((a) => [a.version, a]));
  const drift = checkDrift(migrations, applied);

  process.stdout.write('\n  ver  name                 state    applied at\n');
  process.stdout.write('  ---  -------------------  -------  --------------------------\n');
  for (const migration of migrations) {
    const row = appliedByVersion.get(migration.version);
    const state = row ? (row.checksum === migration.checksum ? 'applied' : 'DRIFT') : 'pending';
    const when = row ? row.appliedAt.toISOString() : '';
    process.stdout.write(
      `  ${String(migration.version).padStart(3, '0')}  ${migration.name.padEnd(19)}  ${state.padEnd(7)}  ${when}\n`,
    );
  }
  process.stdout.write('\n');

  if (drift.length > 0) {
    process.stderr.write(`Schema drift:\n  ${drift.join('\n  ')}\n\n`);
    return 1;
  }
  return 0;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0] ?? 'status';
  const migrations = loadMigrations();

  const client = await connect();
  let exitCode = 0;
  try {
    await ensureRegistry(client);
    await acquireLock(client);

    switch (command) {
      case 'up':
        await runUp(client, migrations);
        break;

      case 'down': {
        // Rollbacks drop tables and delete history. Requiring --yes means a
        // mistyped command in a shell cannot destroy a database.
        if (!argv.includes('--yes')) {
          throw new Error(
            'Refusing to roll back without --yes. Rollbacks are destructive; read the header of the .down.sql first.',
          );
        }
        const toIndex = argv.indexOf('--to');
        const toVersion = toIndex === -1 ? null : Number(argv[toIndex + 1]);
        if (toVersion !== null && Number.isNaN(toVersion)) {
          throw new Error('--to requires a version number, e.g. --to 4');
        }
        await runDown(client, migrations, toVersion);
        break;
      }

      case 'status':
        exitCode = await showStatus(client, migrations);
        break;

      case 'verify': {
        const drift = checkDrift(migrations, await getApplied(client));
        if (drift.length > 0) {
          process.stderr.write(`Schema drift:\n  ${drift.join('\n  ')}\n`);
          exitCode = 1;
        } else {
          process.stdout.write('No drift — database matches the migration files.\n');
        }
        break;
      }

      default:
        throw new Error(`Unknown command "${command}". Use: up | down | status | verify`);
    }
  } finally {
    // Advisory locks are session-scoped, so ending the connection releases the
    // lock even if a migration threw.
    await client.end().catch(() => {});
  }
  process.exit(exitCode);
}

main().catch((error: unknown) => {
  process.stderr.write(`\n${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
