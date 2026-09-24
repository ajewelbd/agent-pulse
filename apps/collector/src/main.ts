/**
 * Collector entry point: startup assertions, backfill, then live tail.
 */
import { mkdtemp, open, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeCodeAdapter } from './adapters/claude-code.js';
import { GeminiCliAdapter } from './adapters/gemini-cli.js';
import type { AgentAdapter } from './adapters/types.js';
import { loadConfig, type CollectorConfig } from './config.js';
import { Db } from './db.js';
import { Ingestor, type IngestStats } from './ingest.js';
import { Redactor } from '@aiuo/schema/redaction';
import { Reconciler } from './reconciler.js';
import { startHookServer } from './server.js';
import { resolveWatchMode, Watcher } from './watcher.js';

const STALE_PARTIAL_MS = 30 * 60 * 1000;

function log(message: string): void {
  process.stdout.write(`${new Date().toISOString()} ${message}\n`);
}

/**
 * Fail loudly when a configured mount is not actually there.
 *
 * This is the assertion the spec insists on: a missing mount must not degrade
 * to "zero turns found". That failure is invisible — the collector runs, logs
 * nothing alarming, and the dashboard is simply empty forever.
 */
async function assertMounts(config: CollectorConfig): Promise<void> {
  const problems: string[] = [];

  for (const agent of config.agents) {
    if (!agent.enabled) continue;
    try {
      const st = await stat(agent.home);
      if (!st.isDirectory()) problems.push(`${agent.key}: ${agent.home} is not a directory`);
    } catch {
      problems.push(
        `${agent.key}: ${agent.home} is not mounted. Add a read-only bind mount for it in compose.yaml, ` +
          `or set AGENT_${agent.key.toUpperCase()}_ENABLED=false.`,
      );
    }
  }

  // An agent's OWN home must be in PATH_MAP too, not just the code roots.
  // Every checkpoint is keyed on the transcript's host path, and the database
  // refuses a /host/... path outright. Without a mapping the collector starts
  // clean, then fails on every single transcript with a constraint violation
  // that names the table rather than the missing config line.
  for (const agent of config.agents) {
    if (!agent.enabled) continue;
    if (config.pathMapper.toHostIfMapped(agent.home).startsWith('/host/')) {
      problems.push(
        `${agent.key}: ${agent.home} is mounted but has no PATH_MAP entry, so its transcript ` +
          `paths cannot be translated back to host paths and no checkpoint can be stored. ` +
          `Add "<host agent dir>:${agent.home}" to PATH_MAP.`,
      );
    }
  }

  for (const mapping of config.pathMapper.entries) {
    try {
      const st = await stat(mapping.containerPrefix);
      if (!st.isDirectory()) {
        problems.push(`PATH_MAP target ${mapping.containerPrefix} is not a directory`);
      }
    } catch {
      problems.push(
        `PATH_MAP maps ${mapping.hostPrefix} → ${mapping.containerPrefix}, but ${mapping.containerPrefix} ` +
          `is not mounted. Every turn under that code root would be dropped.`,
      );
    }
  }

  if (problems.length > 0) {
    throw new Error(`Startup checks failed:\n  - ${problems.join('\n  - ')}`);
  }
}

/** Detect rotation/truncation; on either, restart this file from byte 0. */
interface Checkpoint {
  byteOffset: number;
  inode: string | null;
  fileSize: number | null;
  nextSeq: number;
}

function resumePoint(
  checkpoint: Checkpoint | null,
  inode: string,
  size: number,
): { offset: number; nextSeq: number } {
  // A fresh start, a rotated file, or a truncated one all mean "read from the
  // beginning", and seq numbering restarts with the file.
  if (!checkpoint) return { offset: 0, nextSeq: 1 };
  if (checkpoint.inode !== null && checkpoint.inode !== inode) {
    log(`  file replaced (inode ${checkpoint.inode} → ${inode}), re-reading from 0`);
    return { offset: 0, nextSeq: 1 };
  }
  if (size < checkpoint.byteOffset) {
    log(`  file truncated (${size} < ${checkpoint.byteOffset}), re-reading from 0`);
    return { offset: 0, nextSeq: 1 };
  }
  return { offset: checkpoint.byteOffset, nextSeq: checkpoint.nextSeq };
}

async function scanAgent(
  adapter: AgentAdapter,
  agentId: number,
  db: Db,
  ingestor: Ingestor,
  config: CollectorConfig,
): Promise<IngestStats> {
  const stats: IngestStats = { turns: 0, toolCalls: 0, fileChanges: 0, rawEvents: 0, skipped: 0, failed: 0 };
  const transcripts = await adapter.discover();

  for (const transcript of transcripts) {
    let fileStat;
    try {
      fileStat = await stat(transcript.containerPath);
    } catch {
      // Deleted mid-tail. Its checkpoint stays put; nothing to do.
      continue;
    }

    const hostPath = config.pathMapper.toHostIfMapped(transcript.containerPath);
    const inode = String(fileStat.ino);
    const checkpoint = await db.getCheckpoint(agentId, hostPath);
    const { offset: fromOffset, nextSeq } = resumePoint(checkpoint, inode, fileStat.size);
    if (fromOffset >= fileStat.size) continue;

    const handle = await open(transcript.containerPath, 'r');
    let content: Buffer;
    try {
      content = await handle.readFile();
    } finally {
      await handle.close();
    }

    // One transaction per transcript pass: the checkpoint advances in the same
    // commit as the rows it accounts for, so a crash can never leave an offset
    // ahead of the data. That is the whole reason checkpoints live in Postgres.
    //
    // Scoped per transcript so one unparseable file cannot take down the whole
    // agent's pass. It previously did: a single constraint violation rolled
    // back and aborted the loop, silently ingesting 134 turns instead of 442
    // with no indication of which file was at fault.
    try {
    await db.withTransaction(async (client) => {
      // The resume seq comes from the checkpoint, never from max(seq) in the
      // table: we deliberately re-read the open turn, and deriving its seq from
      // the rows already written would hand it a NEW number every poll and
      // duplicate it without bound. See migration 008.
      const result = adapter.parse(transcript, content, fromOffset, nextSeq);
      const all = result.openTurn ? [...result.turns, result.openTurn] : result.turns;
      if (all.length === 0) return;

      await ingestor.ingestTurns(client, adapter, agentId, transcript, all, stats);

      // The next pass resumes at the open turn's first byte, so it must also
      // resume with that turn's own seq.
      const resumeSeq = result.openTurn ? result.openTurn.seq : nextSeq + result.turns.length;

      await db.saveCheckpoint(client, {
        agentId,
        hostFilePath: hostPath,
        byteOffset: result.checkpointOffset,
        inode,
        fileSize: fileStat.size,
        recordsIngested: all.reduce((n, t) => n + t.rawRecords.length, 0),
        backfilled: true,
        nextSeq: resumeSeq,
      });
    });
    } catch (error) {
      // Name the file. Without it the operator gets a stack trace with no
      // indication of which of 31 transcripts is poisoned.
      stats.failed += 1;
      process.stderr.write(
        `transcript failed, skipping: ${hostPath}\n  ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }

  return stats;
}

async function main(): Promise<void> {
  const config = loadConfig();
  log('collector starting');
  log(`  PATH_MAP: ${config.pathMapper.entries.map((m) => `${m.hostPrefix} → ${m.containerPrefix}`).join(', ')}`);

  await assertMounts(config);
  log('  mounts ok');

  const db = new Db(config.databaseUrl);
  await db.connectWithRetry();
  await db.assertSchemaReady();
  log('  database ok');

  const redactor = new Redactor(undefined, config.redactionDisabled);
  await db.registerRedactionVersion(redactor.version, redactor.patternHash, redactor.patternCount);
  log(`  redaction version ${redactor.version} (${redactor.patternCount} patterns, ${redactor.patternHash})`);

  const scratch = await mkdtemp(join(tmpdir(), 'aiuo-watch-'));
  const watchMode = await resolveWatchMode(config.watchMode, scratch);
  log(`  watch mode: ${watchMode} (configured: ${config.watchMode}, poll interval ${config.watchPollIntervalMs}ms)`);

  const ingestor = new Ingestor(db, config, redactor);

  // Adapter registry. Adding an agent is one entry here plus one adapter file
  // — no migration, no change to the ingest pipeline.
  const codeRoots = config.pathMapper.entries.map((m) => m.containerPrefix);
  const buildAdapter = (agentKey: string, home: string): AgentAdapter | null => {
    switch (agentKey) {
      case 'claude_code':
        return new ClaudeCodeAdapter(home);
      case 'gemini_cli':
        return new GeminiCliAdapter(home, codeRoots, (p) => config.pathMapper.toHostIfMapped(p));
      default:
        return null;
    }
  };

  const adapters: { adapter: AgentAdapter; agentId: number }[] = [];
  for (const agentConfig of config.agents) {
    if (!agentConfig.enabled) continue;
    const adapter = buildAdapter(agentConfig.key, agentConfig.home);
    if (adapter === null) {
      // Enabled with no adapter: say so rather than silently ingesting nothing.
      // Their transcript formats are unverified on this machine, and a parser
      // written against a guessed schema is worse than no parser.
      log(`  WARNING: agent "${agentConfig.key}" is enabled but has no adapter yet — ignoring.`);
      continue;
    }
    adapters.push({ adapter, agentId: await db.getAgentId(agentConfig.key) });
  }
  if (adapters.length === 0) throw new Error('No agent adapters enabled — nothing to collect.');

  const server = startHookServer({
    port: config.port,
    sharedSecret: config.sharedSecret,
    db,
    agentIdFor: (key) => db.getAgentId(key),
    // Stored compactions are derived from already-redacted columns, but they
    // are still content, and a later pattern-set change has to be able to find
    // every row written under the old set.
    redactionVersion: redactor.version,
  });
  log(`  hook receiver on :${config.port} (published as 127.0.0.1:${config.port})`);

  let scanning = false;
  let rescanQueued = false;
  const scan = async (label: string): Promise<void> => {
    if (scanning) {
      rescanQueued = true;
      return;
    }
    scanning = true;
    try {
      for (const { adapter, agentId } of adapters) {
        const stats = await scanAgent(adapter, agentId, db, ingestor, config);
        if (stats.turns > 0 || stats.skipped > 0 || stats.failed > 0) {
          log(
            `${label}: ${adapter.key} — ${stats.turns} turns, ${stats.toolCalls} tool calls, ` +
              `${stats.fileChanges} file changes` +
              (stats.skipped > 0 ? `, ${stats.skipped} skipped (no cwd)` : '') +
              // Never let a failed transcript hide in a success line.
              (stats.failed > 0 ? `, ${stats.failed} TRANSCRIPT(S) FAILED` : ''),
          );
        }
      }
    } catch (error) {
      // A bad transcript must not kill the collector — it would stop watching
      // every other agent too.
      process.stderr.write(`scan error: ${error instanceof Error ? error.stack : String(error)}\n`);
    } finally {
      scanning = false;
      if (rescanQueued) {
        rescanQueued = false;
        void scan(label);
      }
    }
  };

  log('backfill starting (ingesting all pre-existing history)');
  await scan('backfill');
  log(`backfill complete: ${JSON.stringify(await db.counts())}`);

  const watcher = new Watcher({
    mode: watchMode,
    pollIntervalMs: config.watchPollIntervalMs,
    roots: config.agents.filter((a) => a.enabled).map((a) => a.home),
    onChange: () => void scan('tail'),
  });
  watcher.start();
  log('live tail started');

  const reconcilerRunner = new Reconciler(db);
  const reconciler = setInterval(() => {
    void reconcilerRunner
      .run(STALE_PARTIAL_MS)
      .then((s) => {
        const parts: string[] = [];
        if (s.partialsClosed > 0) parts.push(`${s.partialsClosed} stale partial(s) closed`);
        if (s.matched > 0) parts.push(`${s.matched} proxy call(s) matched`);
        if (s.ambiguous > 0) parts.push(`${s.ambiguous} ambiguous`);
        if (s.providersUpgraded > 0) parts.push(`${s.providersUpgraded} provider(s) upgraded to proxy`);
        if (s.tokensFilled > 0) parts.push(`${s.tokensFilled} turn(s) token-filled`);
        if (parts.length > 0) log(`reconciler: ${parts.join(', ')}`);
      })
      // Must never kill the collector: reconciliation is an enrichment pass,
      // and losing it is far cheaper than losing the tail.
      .catch((error: unknown) => {
        process.stderr.write(`reconciler error: ${error instanceof Error ? error.message : String(error)}\n`);
      });
  }, 60_000);

  const shutdown = async (signal: string): Promise<void> => {
    log(`${signal} received, shutting down`);
    clearInterval(reconciler);
    watcher.stop();
    server.close();
    await db.end();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((error: unknown) => {
  process.stderr.write(`\n${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
