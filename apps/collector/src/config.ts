/**
 * Collector configuration, parsed and validated once at startup.
 *
 * Everything that can be wrong about the environment should be wrong loudly
 * here, before a single file is read — a misconfigured mount that degrades to
 * "zero turns found" is the failure mode this module exists to prevent.
 */
import { PathMapper } from './paths.js';

export type WatchMode = 'inotify' | 'poll' | 'auto';

export interface AgentConfig {
  key: string;
  enabled: boolean;
  /** Container path of the agent's state directory (a read-only bind mount). */
  home: string;
}

export interface CollectorConfig {
  databaseUrl: string;
  port: number;
  sharedSecret: string;
  pathMapper: PathMapper;
  watchMode: WatchMode;
  watchPollIntervalMs: number;
  maxStdoutBytes: number;
  maxDiffBytes: number;
  maxTurnDiffBytes: number;
  redactionDisabled: boolean;
  agents: AgentConfig[];
  logLevel: string;
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(`${name} is required. See .env.example.`);
  }
  return value;
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer, got "${raw}"`);
  }
  return value;
}

function boolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  return raw.toLowerCase() === 'true' || raw === '1';
}

export function loadConfig(): CollectorConfig {
  const watchModeRaw = (process.env['WATCH_MODE'] ?? 'auto').toLowerCase();
  if (watchModeRaw !== 'inotify' && watchModeRaw !== 'poll' && watchModeRaw !== 'auto') {
    throw new Error(`WATCH_MODE must be inotify | poll | auto, got "${watchModeRaw}"`);
  }

  const sharedSecret = required('COLLECTOR_SHARED_SECRET');
  if (sharedSecret.length < 16) {
    // SECURITY: this header is the only thing standing between a local process
    // and your full prompt history. A short secret is worse than none because
    // it looks like protection.
    throw new Error('COLLECTOR_SHARED_SECRET must be at least 16 characters.');
  }

  const redactionDisabled = boolEnv('REDACTION_DISABLED', false);
  if (redactionDisabled) {
    process.stderr.write(
      'WARNING: REDACTION_DISABLED=true — prompts, command output and diffs will be stored RAW, ' +
        'including any API keys and customer data they contain. Rows are written at redaction_version 0.\n',
    );
  }

  return {
    databaseUrl: required('DATABASE_URL'),
    port: intEnv('COLLECTOR_PORT', 4317),
    sharedSecret,
    pathMapper: PathMapper.parse(required('PATH_MAP')),
    watchMode: watchModeRaw,
    watchPollIntervalMs: intEnv('WATCH_POLL_INTERVAL_MS', 2000),
    maxStdoutBytes: intEnv('COLLECTOR_MAX_STDOUT_BYTES', 8192),
    maxDiffBytes: intEnv('COLLECTOR_MAX_DIFF_BYTES', 262144),
    maxTurnDiffBytes: intEnv('COLLECTOR_MAX_TURN_DIFF_BYTES', 2097152),
    redactionDisabled,
    logLevel: process.env['LOG_LEVEL'] ?? 'info',
    agents: [
      {
        key: 'claude_code',
        enabled: boolEnv('AGENT_CLAUDE_CODE_ENABLED', true),
        home: process.env['AGENT_CLAUDE_CODE_HOME'] ?? '/host/agents/claude',
      },
      // The four below have no verified transcript format on this machine, so
      // they have no adapter yet. They are listed so enabling one is a config
      // change plus an adapter file — nothing else.
      { key: 'codex_cli', enabled: boolEnv('AGENT_CODEX_CLI_ENABLED', false), home: process.env['AGENT_CODEX_CLI_HOME'] ?? '/host/agents/codex' },
      { key: 'qwen_code', enabled: boolEnv('AGENT_QWEN_CODE_ENABLED', false), home: process.env['AGENT_QWEN_CODE_HOME'] ?? '/host/agents/qwen' },
      { key: 'cursor_cli', enabled: boolEnv('AGENT_CURSOR_CLI_ENABLED', false), home: process.env['AGENT_CURSOR_CLI_HOME'] ?? '/host/agents/cursor' },
      { key: 'copilot_cli', enabled: boolEnv('AGENT_COPILOT_CLI_ENABLED', false), home: process.env['AGENT_COPILOT_CLI_HOME'] ?? '/host/agents/copilot' },
      { key: 'gemini_cli', enabled: boolEnv('AGENT_GEMINI_CLI_ENABLED', false), home: process.env['AGENT_GEMINI_CLI_HOME'] ?? '/host/agents/gemini' },
    ],
  };
}
