-- Rollback of 002_registry.
--
-- DATA LOSS: drops projects, and with it (via ON DELETE CASCADE declared in
-- later migrations) nothing — because 003+ must already be rolled back before
-- this runs. If sessions still exist, the DROP fails on the FK, which is the
-- intended guard.
--
-- Back up first if this database holds real history:
--   pg_dump -Fc -t projects -t agents -t providers "$DATABASE_URL" > projects.dump

DROP TABLE IF EXISTS projects;
DROP TABLE IF EXISTS redaction_versions;
DROP TABLE IF EXISTS providers;
DROP TABLE IF EXISTS agents;
