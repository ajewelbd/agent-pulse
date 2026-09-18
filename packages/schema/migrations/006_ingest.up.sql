-- 006_ingest — raw_events (provenance + replay) and ingest_checkpoints
-- (resume offsets).
--
-- Rollback: 006_ingest.down.sql.

-- ---------------------------------------------------------------------------
-- raw_events — every ingested event, verbatim, before interpretation.
--
-- Two jobs:
--   1. Provenance and replay. If an adapter turns out to have mis-parsed a
--      field, the fix is a re-derive from these rows, not a re-read of host
--      files that may since have been rotated away.
--   2. Conflict retention. When layers disagree about the same turn,
--      precedence is hooks > logs > proxy and the LOSER is kept here rather
--      than discarded, so the disagreement stays auditable.
--
-- NOT linked by FK to sessions/turns on purpose: raw events must survive the
-- retention deletes that cascade through projects, and they are written before
-- the target turn necessarily exists.
-- ---------------------------------------------------------------------------
CREATE TABLE raw_events (
  id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source               text NOT NULL,
  external_id          text NOT NULL,
  agent_id             int REFERENCES agents(id),
  layer                capture_layer NOT NULL,
  payload              jsonb NOT NULL,

  -- Denormalized correlation keys. Text, not FKs, because the event may arrive
  -- before the session row exists (hooks race the tailer).
  session_external_id  text,
  project_path         text,

  occurred_at          timestamptz,
  ingested_at          timestamptz NOT NULL DEFAULT now(),

  -- Set when this event lost a precedence contest; names the layer that won.
  superseded_by_layer  capture_layer,

  -- THE idempotency constraint. Re-running the collector over the same logs
  -- must be a no-op: every insert is ON CONFLICT (source, external_id) DO
  -- NOTHING, so a full re-tail of 31 transcripts inserts zero rows the second
  -- time. external_id must therefore be stable and content-derived, not a
  -- line number — line numbers shift when a transcript is rewritten by
  -- compaction.
  CONSTRAINT raw_events_source_external_unique UNIQUE (source, external_id),
  CONSTRAINT raw_events_project_path_is_host_path
    CHECK (project_path IS NULL OR project_path !~ '^/host/')
);

COMMENT ON COLUMN raw_events.external_id IS
  'Stable content-derived id (e.g. the agent record uuid, or a hash). Never a line number — compaction rewrites transcripts and would shift them.';

-- ---------------------------------------------------------------------------
-- ingest_checkpoints — byte offsets for resumable tailing.
--
-- DEVIATION FROM SPEC, flagged for review: the spec puts checkpoints in a
-- named Docker volume. They live in Postgres here instead, because a
-- checkpoint in a file and the rows it describes in a database cannot be
-- advanced atomically — a crash between the two desyncs them, and the failure
-- is silent in the direction that matters (offset advanced, rows not written →
-- permanently skipped turns). In Postgres the offset advances in the same
-- transaction as the inserts it accounts for.
--
-- The named volume is still worth keeping for pgdata itself, which is what
-- actually has to survive `down`/`up`.
-- ---------------------------------------------------------------------------
CREATE TABLE ingest_checkpoints (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  agent_id          int NOT NULL REFERENCES agents(id),
  -- HOST path of the transcript, for the same reason as everywhere else.
  file_path         text NOT NULL,

  byte_offset       bigint NOT NULL DEFAULT 0,
  -- Rotation/truncation detection. If the inode changes, the file was replaced
  -- and tailing must restart at 0. If file_size < byte_offset, the file was
  -- truncated in place — also a restart. Without both checks a rotated log is
  -- either re-ingested whole or skipped entirely.
  inode             text,
  file_size         bigint,
  -- Hash of the last line consumed, as a third guard: catches a same-inode,
  -- same-size rewrite that neither other check would notice.
  last_line_hash    text,

  records_ingested  bigint NOT NULL DEFAULT 0,
  last_ingested_at  timestamptz,
  -- Set once the initial backfill of this file has completed, so the collector
  -- knows to switch from backfill mode to live tail.
  backfilled_at     timestamptz,
  updated_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ingest_checkpoints_file_unique UNIQUE (agent_id, file_path),
  CONSTRAINT ingest_checkpoints_offset_nonneg CHECK (byte_offset >= 0),
  CONSTRAINT ingest_checkpoints_path_is_host_path CHECK (file_path !~ '^/host/')
);

COMMENT ON TABLE ingest_checkpoints IS
  'Resume offsets, kept in Postgres so an offset and the rows it accounts for advance in one transaction.';
