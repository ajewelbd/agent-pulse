-- 008_checkpoint_seq — make turn numbering deterministic across restarts.
--
-- WHY THIS EXISTS (found by running the collector against 31 real transcripts):
--
-- The tailer checkpoints at the START of the currently-open turn, so that a
-- restart re-reads that turn instead of losing it. Re-reading is safe only if
-- the turn is then written with the SAME seq it had before — turns upsert on
-- (session_id, seq), so a drifting seq turns an idempotent rewrite into an
-- INSERT of a duplicate.
--
-- Deriving the resume seq from the table (max(seq) + 1) does exactly that: the
-- open turn already occupies max(seq), so it comes back as max(seq)+1 on every
-- poll. Observed live: one session grew from 129 real turns to 156 rows in a
-- few minutes of polling, and would have grown without bound.
--
-- Filtering the max by status does not fix it either — a legitimately closed
-- 'aborted' turn (user interrupted a tool) would be excluded from the max and
-- the next turn would then overwrite it.
--
-- So the resume point carries its own seq. It advances in the same transaction
-- as the rows it accounts for, exactly like byte_offset.
--
-- Rollback: 008_checkpoint_seq.down.sql

ALTER TABLE ingest_checkpoints
  ADD COLUMN next_seq int NOT NULL DEFAULT 1;

COMMENT ON COLUMN ingest_checkpoints.next_seq IS
  'Turn seq to assign to the first turn parsed when resuming at byte_offset. Equals the open turn''s own seq when a turn is open, so re-reading it rewrites rather than duplicates.';

ALTER TABLE ingest_checkpoints
  ADD CONSTRAINT ingest_checkpoints_next_seq_positive CHECK (next_seq >= 1);
