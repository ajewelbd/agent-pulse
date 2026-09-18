-- Rollback of 001_foundation.
--
-- Preconditions: migrations 002-007 must already be rolled back. If any table
-- still has a model_normalized generated column, the DROP FUNCTION below fails
-- (correctly) rather than silently leaving a dangling dependency.
--
-- Data loss: none — this migration creates no tables.

DROP FUNCTION IF EXISTS normalize_model_id(text);

DROP TYPE IF EXISTS cost_source;
DROP TYPE IF EXISTS duration_source;
DROP TYPE IF EXISTS attribution;
DROP TYPE IF EXISTS change_type;
DROP TYPE IF EXISTS turn_status;
DROP TYPE IF EXISTS provider_source;
DROP TYPE IF EXISTS token_source;
DROP TYPE IF EXISTS capture_layer;

-- btree_gist is left installed on purpose: dropping a shared extension can
-- break unrelated objects in the same database, and an unused extension costs
-- nothing. Drop it by hand with `DROP EXTENSION btree_gist;` if this database
-- is dedicated to this project and you want a truly clean slate.
