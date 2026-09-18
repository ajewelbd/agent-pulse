-- Rollback of 010_proxy.
--
-- DATA LOSS: drops every Layer 3 observation.
--
-- This is worse than it looks for provider attribution. The upstream host is
-- observable only at request time — no transcript records it — so a dropped
-- proxy_requests row cannot be reconstructed from anything else. Turns that
-- were upgraded to provider_source='proxy' keep their provider_id, but the
-- evidence for it is gone.
--
-- Back up first:
--   pg_dump -Fc -t proxy_requests "$DATABASE_URL" > /backups/proxy.dump
--
-- Raw proxy payloads in raw_events (layer='proxy') are NOT dropped here, so a
-- re-derive is possible from those if they were retained.

DROP TABLE IF EXISTS proxy_requests;
