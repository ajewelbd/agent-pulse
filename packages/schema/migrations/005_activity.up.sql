-- 005_activity — tool_calls, file_changes, file_change_diffs.
--
-- Rollback: 005_activity.down.sql. Destructive.

-- ---------------------------------------------------------------------------
-- tool_calls — ordered commands and tool invocations within a turn.
-- ---------------------------------------------------------------------------
CREATE TABLE tool_calls (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  turn_id             bigint NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
  seq                 int NOT NULL,
  external_tool_use_id text,

  tool_name           text NOT NULL,
  command             text,
  cwd                 text,

  -- NULL means UNKNOWN, not success.
  --
  -- Verified on this machine 2026-09-11: across 3,822 shell results in Claude
  -- Code transcripts, not one carries an exit code. The full key union is
  -- stdout/stderr/interrupted/isImage/noOutputExpected/… with no exitCode
  -- field at any point. Only backgrounded commands report status, and only as
  -- prose inside a task-notification message.
  --
  -- So this column is NULL for the entire Layer 1 backfill, and the dashboard
  -- must render NULL as "unknown" — rendering it as 0 would report every
  -- failed command in the archive as a success. Layer 2 (PostToolUse hook) is
  -- the only way to populate it going forward.
  exit_code           int,

  -- Capped at ingest (COLLECTOR_MAX_STDOUT_BYTES, default 8 KB) to keep rows
  -- bounded. stdout_bytes_total records the true size so the UI can say how
  -- much was dropped rather than implying the command was quiet.
  stdout_excerpt      text,
  stdout_bytes_total  bigint,
  stdout_truncated    boolean NOT NULL DEFAULT false,

  duration_ms         bigint,
  -- 'derived' for Layer 1: wall-clock between the tool_use and tool_result
  -- records, which includes model latency around the call and is therefore an
  -- upper bound. Never mixed with 'reported' values in aggregates.
  duration_source     duration_source NOT NULL DEFAULT 'unknown',

  started_at          timestamptz,
  interrupted         boolean NOT NULL DEFAULT false,
  is_background       boolean NOT NULL DEFAULT false,
  redaction_version   int NOT NULL REFERENCES redaction_versions(version),
  created_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT tool_calls_turn_seq_unique UNIQUE (turn_id, seq),
  -- Same host-path guarantee as projects.path: a container path here would
  -- render an uncopyable cwd in the UI and silently break any host-side tool
  -- that consumes the API.
  CONSTRAINT tool_calls_cwd_is_host_path CHECK (cwd IS NULL OR cwd !~ '^/host/'),
  CONSTRAINT tool_calls_stdout_bytes_nonneg CHECK (stdout_bytes_total IS NULL OR stdout_bytes_total >= 0)
);

COMMENT ON COLUMN tool_calls.exit_code IS
  'NULL = unknown, not success. Layer 1 transcripts do not record exit codes; only the PostToolUse hook can supply them.';

-- ---------------------------------------------------------------------------
-- file_changes — one row per edit operation, not per file per turn.
--
-- An agent may edit the same file several times in one turn, and each edit has
-- its own diff. Coalescing to one row per file would either lose intermediate
-- diffs or force a synthesized net diff that matches no actual operation. The
-- dashboard groups by path for display; the rows stay lossless.
-- ---------------------------------------------------------------------------
CREATE TABLE file_changes (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  turn_id           bigint NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
  seq               int NOT NULL,
  -- Which command produced it, when that is knowable (hook events link them).
  tool_call_id      bigint REFERENCES tool_calls(id) ON DELETE SET NULL,

  path              text NOT NULL,
  -- Set for change_type='rename'; NULL otherwise.
  old_path          text,
  change_type       change_type NOT NULL,

  lines_added       int,
  lines_removed     int,
  is_binary         boolean NOT NULL DEFAULT false,
  is_truncated      boolean NOT NULL DEFAULT false,

  -- Content hashes of the file before and after. blob_hash_before is what
  -- makes concurrent-human-edit detection possible: when git's idea of the
  -- pre-edit content disagrees with the hash the agent reported, the change is
  -- marked attribution='uncertain' rather than dropped or misattributed.
  blob_hash_before  text,
  blob_hash_after   text,
  attribution       attribution NOT NULL DEFAULT 'agent',

  size_before_bytes bigint,
  size_after_bytes  bigint,
  source            capture_layer NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT file_changes_turn_seq_unique UNIQUE (turn_id, seq),
  CONSTRAINT file_changes_path_is_host_path CHECK (path !~ '^/host/'),
  CONSTRAINT file_changes_old_path_is_host_path CHECK (old_path IS NULL OR old_path !~ '^/host/'),
  CONSTRAINT file_changes_rename_has_old_path CHECK (
    (change_type = 'rename') = (old_path IS NOT NULL)
  ),
  -- A binary file gets change_type and sizes but no diff body, so line counts
  -- are meaningless for it.
  CONSTRAINT file_changes_binary_has_no_lines CHECK (
    NOT is_binary OR (lines_added IS NULL AND lines_removed IS NULL)
  )
);

-- ---------------------------------------------------------------------------
-- file_change_diffs — the diff bodies, 1:1 with file_changes.
--
-- Deliberately a separate table. The turn-list query never selects a diff, but
-- if the body lived on file_changes then any `SELECT *` — or an ORM that
-- generates one — would drag multi-MB TOASTed values through every list page.
-- Splitting it makes that mistake impossible rather than merely discouraged.
-- ---------------------------------------------------------------------------
CREATE TABLE file_change_diffs (
  file_change_id    bigint PRIMARY KEY REFERENCES file_changes(id) ON DELETE CASCADE,
  unified_diff      text NOT NULL,
  -- Size of the diff as produced, BEFORE any truncation — so the UI can say
  -- "showing 256 KB of 4 MB" instead of pretending the diff was small.
  byte_size         bigint NOT NULL,
  is_truncated      boolean NOT NULL DEFAULT false,
  -- SECURITY: diffs contain the same secrets prompts do — .env bodies, keys,
  -- customer data. The redaction pipeline runs over the diff body before this
  -- insert, under the same pattern set and version as prompt/response text.
  redaction_version int NOT NULL REFERENCES redaction_versions(version),
  created_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT file_change_diffs_byte_size_nonneg CHECK (byte_size >= 0)
);

-- Diffs are highly compressible text and are read rarely (turn detail only),
-- which is exactly the profile TOAST compression is for. pglz is the default
-- and is always available; lz4 decompresses several times faster but requires
-- a server built --with-lz4. Try it, fall back silently rather than failing
-- the migration on a server that lacks it.
DO $$
BEGIN
  EXECUTE 'ALTER TABLE file_change_diffs ALTER COLUMN unified_diff SET COMPRESSION lz4';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'lz4 compression unavailable, keeping pglz for file_change_diffs.unified_diff (%)', SQLERRM;
END $$;

COMMENT ON TABLE file_change_diffs IS
  'Diff bodies, split from file_changes so list queries can never pull TOASTed multi-MB values they do not render.';
