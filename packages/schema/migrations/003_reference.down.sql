-- Rollback of 003_reference.
--
-- DATA LOSS: drops seeded and hand-edited pricing. If you have added real
-- third-party rates, export them first — they are not reproducible from the
-- seed:
--   pg_dump -Fc -t model_pricing -t model_providers "$DATABASE_URL" > pricing.dump
--
-- Preconditions: 004+ rolled back first, since turns.pricing_id references
-- model_pricing. The DROP fails on that FK otherwise, which is the guard.

DROP TABLE IF EXISTS model_pricing;
DROP TABLE IF EXISTS model_providers;
