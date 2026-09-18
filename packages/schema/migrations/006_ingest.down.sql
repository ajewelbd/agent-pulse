-- Rollback of 006_ingest.
--
-- DATA LOSS, and worse than it looks:
--
--   * Dropping ingest_checkpoints resets every byte offset. The next collector
--     start re-reads all transcripts from byte 0. That is NOT a disaster —
--     raw_events' UNIQUE (source, external_id) makes re-ingestion a no-op —
--     but only if raw_events survives. Dropping BOTH in this migration means
--     the next start genuinely re-ingests everything from scratch.
--
--   * Dropping raw_events also discards the conflict losers retained under the
--     hooks > logs > proxy precedence rule. Those are not reconstructible from
--     the derived tables.
--
-- Back up first:
--   pg_dump -Fc -t raw_events -t ingest_checkpoints "$DATABASE_URL" > /backups/ingest.dump

DROP TABLE IF EXISTS ingest_checkpoints;
DROP TABLE IF EXISTS raw_events;
