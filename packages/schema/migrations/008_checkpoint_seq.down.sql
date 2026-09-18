-- Rollback of 008_checkpoint_seq.
--
-- DATA LOSS: minimal, but the consequence is real. Dropping next_seq forces
-- the collector back to deriving the resume seq from max(seq), which
-- duplicates the open turn on every poll (that bug is why this column exists).
--
-- Roll this back only together with a collector version that does not read the
-- column, and expect duplicate turns if you then resume tailing an open
-- transcript.

ALTER TABLE ingest_checkpoints DROP CONSTRAINT IF EXISTS ingest_checkpoints_next_seq_positive;
ALTER TABLE ingest_checkpoints DROP COLUMN IF EXISTS next_seq;
