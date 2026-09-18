-- 002_registry — extensible lookup tables (agents, providers, redaction
-- versions) and the projects table.
--
-- Rollback: 002_registry.down.sql. Destructive — drops projects.

-- ---------------------------------------------------------------------------
-- agents — one row per CLI coding agent the collector knows about.
--
-- A table rather than an enum so that adding an agent stays "one adapter + one
-- config entry": the collector upserts its own row at startup, no migration.
-- ---------------------------------------------------------------------------
CREATE TABLE agents (
  id            int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  key           text NOT NULL UNIQUE,
  display_name  text NOT NULL,
  notes         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agents_key_shape CHECK (key ~ '^[a-z0-9_]+$')
);

COMMENT ON TABLE agents IS
  'Registry of CLI agents. Rows are upserted by the collector at startup; adding an agent never requires a migration.';

INSERT INTO agents (key, display_name, notes) VALUES
  ('claude_code',  'Claude Code',
   'Layer 1 verified 2026-09-11: ~/.claude/projects/<slug>/<session>.jsonl. Provider-reported usage; no exit codes; full old/new edit payloads.'),
  ('codex_cli',    'Codex CLI',        'Not installed on this machine as of 2026-09-11 — format unverified, no adapter.'),
  ('qwen_code',    'Qwen Code',        'Not installed on this machine as of 2026-09-11 — format unverified, no adapter.'),
  ('cursor_cli',   'Cursor CLI',       'Not installed on this machine as of 2026-09-11 — format unverified, no adapter.'),
  ('copilot_cli',  'GitHub Copilot CLI',
   'Present at ~/.copilot but writes no transcripts (stdio server mode only) — Layer 3 proxy is the only viable source.'),
  ('gemini_cli',   'Gemini CLI',
   'Not a v1 target. Installed here; ~/.gemini/tmp/<projectHash>/chats/*.json has tokens+model but no tool or diff records.');

-- ---------------------------------------------------------------------------
-- providers — who actually served the inference. Distinct from the agent.
--
-- Keys match the spec's vocabulary verbatim (including the hyphen in
-- 'github-copilot') so that config, API and database all speak one dialect.
-- ---------------------------------------------------------------------------
CREATE TABLE providers (
  id            int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  key           text NOT NULL UNIQUE,
  display_name  text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

INSERT INTO providers (key, display_name) VALUES
  ('anthropic',       'Anthropic'),
  ('openai',          'OpenAI'),
  ('google',          'Google'),
  ('dashscope',       'Alibaba DashScope'),
  ('openrouter',      'OpenRouter'),
  ('ollama',          'Ollama (local)'),
  ('github-copilot',  'GitHub Copilot'),
  ('azure',           'Azure OpenAI'),
  ('aws-bedrock',     'AWS Bedrock'),
  ('google-vertex',   'Google Vertex AI'),
  ('unknown',         'Unknown');

-- ---------------------------------------------------------------------------
-- redaction_versions — what the redaction pipeline was doing when a row was
-- written. Rows carry redaction_version so a later pattern-set change is
-- auditable ("which rows were written before we started catching JWTs?").
-- ---------------------------------------------------------------------------
CREATE TABLE redaction_versions (
  version       int PRIMARY KEY,
  pattern_hash  text NOT NULL,
  pattern_count int NOT NULL,
  description   text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Version 0 means "no redaction applied". It exists so the FK on content rows
-- can be NOT NULL from day one; the collector registers version 1+ at startup
-- with the hash of its live pattern set.
INSERT INTO redaction_versions (version, pattern_hash, pattern_count, description)
VALUES (0, 'none', 0, 'No redaction applied. Never valid for production ingest — collector refuses to write with version 0 unless REDACTION_DISABLED=true.');

-- ---------------------------------------------------------------------------
-- projects — a code root the agent was invoked in.
-- ---------------------------------------------------------------------------
CREATE TABLE projects (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  path        text NOT NULL UNIQUE,
  name        text NOT NULL,
  git_remote  text,
  first_seen  timestamptz NOT NULL,
  last_seen   timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),

  -- SECURITY / CORRECTNESS: the collector runs in a container where the code
  -- roots are bind-mounted under /host/code/..., but every path written to the
  -- database must be the HOST path the user actually recognises. Outbound path
  -- translation is easy to forget in one code path and impossible to detect
  -- later (the dashboard just shows paths nobody can open). This constraint
  -- turns that silent corruption into a loud insert failure.
  CONSTRAINT projects_path_is_host_path CHECK (path !~ '^/host/'),
  CONSTRAINT projects_path_absolute     CHECK (path LIKE '/%'),
  CONSTRAINT projects_seen_ordered      CHECK (last_seen >= first_seen)
);

COMMENT ON COLUMN projects.path IS
  'Absolute HOST path. Never a container path — enforced by projects_path_is_host_path.';
