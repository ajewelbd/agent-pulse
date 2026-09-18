-- Rollback of 009_turn_identity.
--
-- NON-DESTRUCTIVE: drops an index only, no data is lost.
--
-- Consequence: resumed sessions that re-append their history will duplicate
-- turns again (one extra row per replayed prompt, per resume). Existing rows
-- are unaffected. Roll back only alongside a collector that conflicts on
-- (session_id, seq).

DROP INDEX IF EXISTS turns_session_external_turn_unique;
