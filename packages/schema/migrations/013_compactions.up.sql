-- 013_compactions — what a turn was folded into, and with what settings.
--
-- A compaction is not an observation of the agent. Everything else in this
-- schema is a record of something that happened outside it; this is a record
-- of something the operator did inside the dashboard. It is stored anyway,
-- because the output is only interpretable alongside the settings that
-- produced it: the same turn at length 'brief' with prompts only, and at
-- 'detailed' with diffs, give two documents that look equally authoritative
-- and say very different amounts. Keeping the parameters beside the text is
-- what makes an old compaction re-readable rather than merely re-readable-ish.
--
-- WHO WRITES THIS. Not the dashboard. Its pool sets
-- default_transaction_read_only=on and that is a property worth more than the
-- convenience of writing from the page that has the data — see
-- CLAUDE.md, "the dashboard connection is read-only". The dashboard POSTs to
-- the collector (POST /v1/compactions, shared secret, same as hooks) and the
-- collector inserts. The read path stays in apps/web/src/lib/queries.ts.
--
-- ON REDACTION. `output` is derived text: it is assembled from prompt_text and
-- response_text, which the collector already redacted on the way in, so no
-- unredacted value can reach this table that was not already in those columns.
-- redaction_version is recorded all the same, because a later pattern-set
-- change has to be able to find every row written under the old set, and a
-- derived row is no less in need of that than the row it came from.
--
-- ON PROVENANCE. `summarized` is the field that matters most here. False means
-- `output` IS the assembled record; true means a model rewrote it. Conflating
-- the two would leave a summary indistinguishable from the transcript it came
-- from, which is the one thing the compact panel exists to keep apart.
--
-- Rollback: 013_compactions.down.sql

CREATE TABLE compactions (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  -- History belongs to the turn whose detail page produced it. CASCADE because
  -- a compaction of a deleted turn is not a record of anything.
  turn_id             bigint NOT NULL REFERENCES turns(id) ON DELETE CASCADE,

  -- Idempotency, as everywhere else that accepts a write over HTTP: the client
  -- generates this before it posts, so a retry after a timeout cannot produce a
  -- second row for one press of the button.
  request_id          uuid NOT NULL UNIQUE,

  created_at          timestamptz NOT NULL DEFAULT now(),

  -- The settings, which are the point of storing this at all.
  provider            text NOT NULL,
  model               text NOT NULL,
  length              text NOT NULL,
  -- Which material went in. An array rather than five booleans so that adding
  -- a sixth kind of material does not need a migration to record it.
  parts               text[] NOT NULL,

  -- Whether a model rewrote the assembly, and what it said if it did not.
  summarized          boolean NOT NULL,
  reason              text,

  output              text NOT NULL,

  -- Real counts when the provider reported them, NULL when it did not.
  -- ABSENCE IS NOT ZERO: a NULL here means the provider said nothing, and the
  -- UI must render it as such rather than as a free call.
  input_tokens        bigint,
  output_tokens       bigint,
  -- The dashboard's own chars/4 guess, kept separate from the counts above so
  -- an estimate can never be read as a measurement.
  estimated_input_tokens bigint NOT NULL,

  redaction_version   int NOT NULL REFERENCES redaction_versions(version),

  CONSTRAINT compactions_length_known CHECK (length IN ('brief','standard','detailed')),
  CONSTRAINT compactions_parts_not_empty CHECK (cardinality(parts) > 0),
  -- A summary with no model behind it is a contradiction, and an unsummarised
  -- row with no reason gives the UI nothing to explain itself with.
  CONSTRAINT compactions_reason_when_not_summarized CHECK (
    summarized OR reason IS NOT NULL
  ),
  CONSTRAINT compactions_tokens_nonnegative CHECK (
    (input_tokens IS NULL OR input_tokens >= 0)
    AND (output_tokens IS NULL OR output_tokens >= 0)
  )
);

COMMENT ON TABLE compactions IS
  'Operator-initiated compactions of a turn, with the settings that produced each one. Written by the collector, never by the dashboard, whose pool is read-only.';
COMMENT ON COLUMN compactions.summarized IS
  'false = output IS the locally assembled record; true = a model rewrote it. Never conflate the two — the panel and this column exist to keep them apart.';
COMMENT ON COLUMN compactions.parts IS
  'Which material was included: prompt, response, commands, files, diffs. An array so new material kinds need no migration.';
COMMENT ON COLUMN compactions.input_tokens IS
  'Provider-reported prompt tokens. NULL = not reported, NEVER 0.';
COMMENT ON COLUMN compactions.estimated_input_tokens IS
  'The dashboard''s chars/4 estimate of the assembled block. An estimate, kept apart from input_tokens so the two are never read as the same thing.';

-- The history panel's only query: one turn's compactions, newest first.
CREATE INDEX compactions_turn_created_idx ON compactions (turn_id, created_at DESC);
