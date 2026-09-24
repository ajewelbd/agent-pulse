import { cost, duration, tokenCount, utc, utcClock, utcDay } from './format';

/**
 * Folding a run of turns into one context block.
 *
 * Two stages, deliberately separate:
 *
 *   1. ASSEMBLY (here, pure, no network) turns rows out of the database into
 *      one text block. This always runs, and its output is the thing the user
 *      actually walks away with when no model is configured.
 *   2. SUMMARISATION (the route handler) optionally hands that block to Claude.
 *
 * Keeping them apart is what makes the feature work on a machine with no API
 * key — and it keeps the provenance rule intact, because stage 1 is the only
 * step that reads the record, and it is verifiable by eye.
 *
 * ABSENCE IS NOT ZERO applies here as it does in the UI: an unreported token
 * count is "—" and an unpriced turn is "not priced", never 0. A context block
 * is a document someone will reason from later, so a zero it invented would
 * outlive the session that produced it.
 */

/** What material from each turn goes into the block. Every part is optional. */
export type CompactPart = 'prompt' | 'response' | 'commands' | 'files' | 'diffs';

export const COMPACT_PARTS: ReadonlyArray<{
  key: CompactPart;
  label: string;
  hint: string;
}> = [
  { key: 'prompt', label: 'Prompts', hint: 'What the user asked, editor context stripped.' },
  { key: 'response', label: 'Responses', hint: 'What the agent replied.' },
  { key: 'commands', label: 'Commands', hint: 'Tool calls: name, command line, exit code, duration.' },
  { key: 'files', label: 'File paths', hint: 'Which files changed, and by how many lines.' },
  { key: 'diffs', label: 'Diffs', hint: 'The unified diff bodies. Large — off by default.' },
];

export const DEFAULT_PARTS: CompactPart[] = ['prompt', 'response', 'commands', 'files'];

export type CompactLength = 'brief' | 'standard' | 'detailed';

/**
 * How much of each turn survives assembly.
 *
 * Every cap here is announced in the output when it bites (see `clip`), because
 * a context block that silently dropped half a response would be read later as
 * if that were all there was.
 */
interface Budget {
  prompt: number;
  response: number;
  commands: number;
  files: number;
  diff: number;
  /** Steers the model when one is summarising; ignored by assembly. */
  instruction: string;
}

export const BUDGETS: Record<CompactLength, Budget> = {
  brief: {
    prompt: 600,
    response: 800,
    commands: 10,
    files: 15,
    diff: 0,
    instruction: 'A few sentences per turn at most. Aim for under 300 words total.',
  },
  standard: {
    prompt: 2000,
    response: 3000,
    commands: 30,
    files: 40,
    diff: 2000,
    instruction: 'A short paragraph per turn. Aim for under 800 words total.',
  },
  detailed: {
    prompt: 8000,
    response: 12000,
    commands: 100,
    files: 150,
    diff: 8000,
    instruction: 'Keep specifics: file paths, commands, decisions and their reasons.',
  },
};

/**
 * The models offered in the panel.
 *
 * Two capability flags rather than one list, because the request shape differs
 * per model and getting it wrong is a 400, not a degradation:
 *
 *  - `effort`: `output_config.effort` is accepted on the Claude 5 family and
 *    rejected on Haiku 4.5, so it is only sent where it is supported.
 *  - `fallback`: the server-side refusal fallback chain, which the API
 *    documents for the Opus 5 and Fable tiers. Turn content here is whatever
 *    the user typed at their agent, so a policy decline is possible; with this
 *    on, the same request is re-run on a fallback model inside the one call.
 *
 * Verified against @anthropic-ai/sdk 0.128.0's own types on 2026-09-23:
 * `BetaFallbacksParam = Array<BetaFallbackParam> | 'default'`, and
 * 'server-side-fallback-2026-07-01' is a member of `AnthropicBeta`.
 */
/**
 * Which service runs the summary.
 *
 * `local` is not decoration. The rest of this dashboard never makes an outbound
 * request, and the header says "localhost — nothing here leaves this machine".
 * Sending a block of prompts to a remote API breaks that; sending it to Ollama
 * on this machine does not. The panel groups the dropdown by this flag and says
 * so, because it is the difference that actually matters when the thing being
 * summarised is every prompt you have typed.
 */
export type CompactProviderKey = 'anthropic' | 'ollama';

export const COMPACT_PROVIDERS: Record<CompactProviderKey, { label: string; local: boolean }> = {
  anthropic: { label: 'Anthropic API', local: false },
  ollama: { label: 'Ollama (this machine)', local: true },
};

export interface CompactModel {
  provider: CompactProviderKey;
  /** The provider's own model id, sent verbatim. */
  id: string;
  label: string;
  note: string;
  /** Anthropic only — see below. */
  effort?: boolean;
  fallback?: boolean;
  /**
   * Ollama only: the context window the model was built with, from its own
   * /api/tags entry. Null when Ollama did not report one.
   */
  contextTokens?: number | null;
}

/**
 * The Anthropic models offered in the panel.
 *
 * Two capability flags rather than one list, because the request shape differs
 * per model and getting it wrong is a 400, not a degradation:
 *
 *  - `effort`: `output_config.effort` is accepted on the Claude 5 family and
 *    rejected on Haiku 4.5, so it is only sent where it is supported.
 *  - `fallback`: the server-side refusal fallback chain, which the API
 *    documents for the Opus 5 and Fable tiers.
 *
 * Verified against @anthropic-ai/sdk 0.128.0's own types on 2026-09-23:
 * `BetaFallbacksParam = Array<BetaFallbackParam> | 'default'`, and
 * 'server-side-fallback-2026-07-01' is a member of `AnthropicBeta`.
 *
 * Ollama models are NOT listed here. They are whatever the user has pulled, so
 * they are discovered from the daemon at request time rather than guessed.
 */
export const ANTHROPIC_MODELS: ReadonlyArray<CompactModel> = [
  { provider: 'anthropic', id: 'claude-opus-5', label: 'claude-opus-5', note: 'Default. Best judgement about what mattered in a run.', effort: true, fallback: true },
  { provider: 'anthropic', id: 'claude-sonnet-5', label: 'claude-sonnet-5', note: 'Cheaper, still strong on summarisation.', effort: true, fallback: false },
  { provider: 'anthropic', id: 'claude-haiku-4-5', label: 'claude-haiku-4-5', note: 'Cheapest and fastest. 200K context, so long runs may not fit.', effort: false, fallback: false },
  { provider: 'anthropic', id: 'claude-fable-5-1', label: 'claude-fable-5-1', note: 'Most capable, and the most expensive.', effort: true, fallback: true },
];

export const DEFAULT_COMPACT_MODEL = 'claude-opus-5';
export const DEFAULT_COMPACT_PROVIDER: CompactProviderKey = 'anthropic';

/**
 * Effort follows the length the user asked for.
 *
 * Summarising a transcript is routine work, so even the detailed setting stops
 * at `high` — the levels above it buy thoroughness on hard reasoning, which
 * this is not, and they are billed for.
 */
export const EFFORT_BY_LENGTH: Record<CompactLength, 'low' | 'medium' | 'high'> = {
  brief: 'low',
  standard: 'medium',
  detailed: 'high',
};

/** Room to leave for the summary itself, by the length asked for. */
export const OUTPUT_TOKENS_BY_LENGTH: Record<CompactLength, number> = {
  brief: 800,
  standard: 2000,
  detailed: 4000,
};

export interface ContextPlan {
  /** Prompt estimate, corrected and with room for the answer, in tokens. */
  needed: number;
  /** What to ask Ollama to load the model with. */
  numCtx: number;
  /** False when the block cannot fit this model's window at all. */
  fits: boolean;
}

/**
 * How badly `estimateTokens` undercounts a block of this kind.
 *
 * Measured against qwen2.5-coder's own `prompt_eval_count` on 2026-09-23:
 *
 *   estimate 1,114 → actual 1,765   (1.58×)
 *   estimate 2,143 → actual 3,250   (1.52×)
 *
 * Four characters per token is a rule of thumb for prose. A compacted block is
 * absolute file paths, shell commands and diff punctuation, which tokenise far
 * more densely. Sizing the window off the raw estimate would ask for a window
 * about a third too small — and Ollama's response to a prompt that does not fit
 * is to drop the front of it and report success.
 *
 * 1.8 sits above both measurements with room to spare. Erring high costs some
 * memory; erring low costs a summary of a run the model only partly read.
 */
const TOKEN_ESTIMATE_HEADROOM = 1.8;

/**
 * How big a context window to ask Ollama for, and whether the block fits.
 *
 * This exists because of a failure observed on this machine on 2026-09-23: a
 * ~4,600-token prompt sent with `num_ctx: 512` came back HTTP 200, with
 * `done_reason: "stop"`, `prompt_eval_count: 258`, and a confident wrong
 * answer. Ollama drops whatever does not fit and says nothing — no error, no
 * flag, no truncation notice. Left alone, the panel would summarise a quarter
 * of a run and present it as the whole.
 *
 * So the window is always set explicitly from the model's own reported context
 * length rather than left to Ollama's default, and a block that cannot fit is
 * refused up front instead of being quietly halved.
 *
 * `numCtx` is rounded up to a 1024 boundary and floored at 4096 — below that,
 * loading gains nothing and the prompt is at risk again.
 */
export function planOllamaContext(
  blockTokens: number,
  modelContext: number | null | undefined,
  length: CompactLength,
): ContextPlan {
  const needed =
    Math.ceil(blockTokens * TOKEN_ESTIMATE_HEADROOM) + OUTPUT_TOKENS_BY_LENGTH[length];
  const rounded = Math.max(4096, Math.ceil(needed / 1024) * 1024);
  // No reported context length means no basis to refuse on; ask for what is
  // needed and let the post-call truncation check be the backstop.
  if (!modelContext || modelContext <= 0) return { needed, numCtx: rounded, fits: true };
  return { needed, numCtx: Math.min(rounded, modelContext), fits: needed <= modelContext };
}

/**
 * Did Ollama silently drop the front of the prompt?
 *
 * A prompt that filled the window exactly is the signature: Ollama evaluates
 * right up to `num_ctx` and stops, reporting success. Compared against the
 * window rather than against the estimate, because the char/4 estimate is not
 * accurate enough to accuse the daemon on its own.
 */
export function looksTruncated(promptEvalCount: number | undefined, numCtx: number): boolean {
  if (typeof promptEvalCount !== 'number') return false;
  return promptEvalCount >= numCtx - 8;
}

export interface CompactCommand {
  seq: number;
  tool_name: string;
  command: string | null;
  exit_code: number | null;
  duration_ms: string | null;
  interrupted: boolean;
}

export interface CompactFile {
  seq: number;
  path: string;
  change_type: string;
  lines_added: number | null;
  lines_removed: number | null;
  is_binary: boolean;
  unified_diff: string | null;
}

/** One turn's raw material, as the database has it. */
export interface CompactTurn {
  id: string;
  seq: number;
  started_at: Date | string;
  status: string;
  project_name: string;
  agent_key: string;
  git_branch: string | null;
  model_raw: string | null;
  external_session_id: string;
  prompt_text: string | null;
  response_text: string | null;
  token_source: string;
  total_input_tokens: string | null;
  output_tokens: string | null;
  cost_usd: string | null;
  cost_source: string;
  duration_ms: string | null;
  commands: CompactCommand[];
  files: CompactFile[];
}

export interface AssembleOptions {
  parts: CompactPart[];
  length: CompactLength;
  /** Defaults to now. Passed in by the tests so the output is comparable. */
  now?: Date;
}

/**
 * The editor-focus block Claude Code prefixes a prompt with.
 *
 * Same two tags the list query strips (see IDE_BLOCK_RE in queries.ts) and for
 * the same reason: 240 characters of editor boilerplate ahead of the real
 * request would eat the prompt budget below and tell the reader nothing. The
 * fact that the block was there is kept — it is why the turn cost what it did.
 */
const IDE_BLOCK = /^<(ide_opened_file|ide_selection)>[\s\S]*?<\/\1>\s*/;

export function stripIdeBlock(text: string): { text: string; ideKind: string | null } {
  const match = IDE_BLOCK.exec(text);
  if (!match) return { text, ideKind: null };
  return { text: text.slice(match[0].length), ideKind: match[1] ?? null };
}

/**
 * Cut to `max` characters and say so.
 *
 * The count of what was dropped is part of the output on purpose: someone
 * reading the block later can see that the turn was longer than this, which is
 * the difference between an abridgement and a misrepresentation.
 */
function clip(text: string, max: number): string {
  const trimmed = text.trim();
  if (max <= 0) return `[omitted at this length — ${trimmed.length} characters]`;
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max).trimEnd()}\n… [clipped — ${trimmed.length - max} more characters]`;
}

/**
 * One value if they all agree, otherwise a count and the values themselves.
 *
 * `plural` is spelled out by the caller rather than built with a trailing "s",
 * which produced "2 branchs" the first time this ran against the archive.
 */
function oneOrMany(values: Array<string | null>, plural: string): string {
  const seen = [...new Set(values.map((v) => v ?? '(none)'))];
  if (seen.length === 1) return seen[0]!;
  return `${seen.length} ${plural} (${seen.join(', ')})`;
}

function commandLine(c: CompactCommand): string {
  const bits: string[] = [];
  // Exit code is 'unknown', never 'success': Layer 1 does not record it, and
  // the enrichment pass that would is not built. A 0 here would be invented.
  bits.push(c.exit_code === null ? 'exit unknown' : `exit ${c.exit_code}`);
  if (c.duration_ms !== null) bits.push(duration(c.duration_ms));
  if (c.interrupted) bits.push('interrupted');
  const what = c.command?.replace(/\s+/g, ' ').trim() || '(no command recorded)';
  return `  ${c.seq}. ${c.tool_name} — ${what}  (${bits.join(', ')})`;
}

function fileLine(f: CompactFile): string {
  if (f.is_binary) return `  ${f.path} — ${f.change_type}, binary`;
  const added = f.lines_added === null ? '—' : `+${f.lines_added}`;
  const removed = f.lines_removed === null ? '—' : `-${f.lines_removed}`;
  return `  ${f.path} — ${f.change_type}, ${added}/${removed}`;
}

/**
 * The block itself.
 *
 * Turn order is the caller's order, which is the order the user arranged in the
 * panel. The header states the range by sequence number so the block still says
 * where it came from even if that order is not chronological.
 */
export function assembleContext(turns: CompactTurn[], options: AssembleOptions): string {
  if (turns.length === 0) return '';

  const budget = BUDGETS[options.length];
  const want = new Set(options.parts);
  const seqs = turns.map((t) => t.seq);
  const sessions = [...new Set(turns.map((t) => t.external_session_id))];
  const out: string[] = [];

  const range =
    turns.length === 1
      ? `turn #${seqs[0]}`
      : `turns #${Math.min(...seqs)}–#${Math.max(...seqs)} (${turns.length} selected)`;
  const session =
    sessions.length === 1
      ? `Session ${sessions[0]}`
      : `${sessions.length} sessions (${sessions.join(', ')})`;

  out.push(`${session} · ${range} · compacted ${utc(options.now ?? new Date())}`);
  out.push('');
  out.push(
    `Context: project ${oneOrMany(turns.map((t) => t.project_name), 'projects')}` +
      ` on branch ${oneOrMany(turns.map((t) => t.git_branch), 'branches')}` +
      `, agent ${oneOrMany(turns.map((t) => t.agent_key), 'agents')}` +
      `, model ${oneOrMany(turns.map((t) => t.model_raw), 'models')}.`,
  );
  out.push(
    `Included: ${COMPACT_PARTS.filter((p) => want.has(p.key)).map((p) => p.label.toLowerCase()).join(', ') || 'metadata only'}` +
      ` · length ${options.length}.`,
  );

  for (const turn of turns) {
    const prompt = turn.prompt_text ?? '';
    const { text: asked, ideKind } = stripIdeBlock(prompt);

    out.push('');
    out.push('─'.repeat(72));
    out.push(
      `turn #${turn.seq} · ${utcDay(turn.started_at)} ${utcClock(turn.started_at)} UTC · ${turn.status}` +
        ` · ${tokenCount(turn.total_input_tokens, turn.token_source, false)} in` +
        ` / ${tokenCount(turn.output_tokens, turn.token_source, false)} out` +
        ` · ${cost(turn.cost_usd, turn.cost_source)}` +
        ` · ${duration(turn.duration_ms)}`,
    );
    // Stated even when prompts are excluded: the editor block is context the
    // model was paid to read, so leaving it unmentioned understates the turn.
    if (ideKind) out.push(`(carried an <${ideKind}> block from the editor)`);

    if (want.has('prompt')) {
      out.push('');
      out.push('PROMPT');
      out.push(asked.trim() ? clip(asked, budget.prompt) : '(no prompt text)');
    }

    if (want.has('response')) {
      out.push('');
      out.push('RESPONSE');
      out.push(turn.response_text?.trim() ? clip(turn.response_text, budget.response) : '(no response text stored)');
    }

    if (want.has('commands')) {
      out.push('');
      out.push(`COMMANDS (${turn.commands.length})`);
      if (turn.commands.length === 0) {
        out.push('  (none)');
      } else {
        for (const c of turn.commands.slice(0, budget.commands)) out.push(commandLine(c));
        if (turn.commands.length > budget.commands) {
          out.push(`  … ${turn.commands.length - budget.commands} more not listed at this length`);
        }
      }
    }

    if (want.has('files')) {
      out.push('');
      out.push(`FILES (${turn.files.length})`);
      if (turn.files.length === 0) {
        out.push('  (none)');
      } else {
        for (const f of turn.files.slice(0, budget.files)) out.push(fileLine(f));
        if (turn.files.length > budget.files) {
          out.push(`  … ${turn.files.length - budget.files} more not listed at this length`);
        }
      }
    }

    if (want.has('diffs')) {
      const bodies = turn.files.filter((f) => f.unified_diff);
      out.push('');
      out.push(`DIFFS (${bodies.length})`);
      if (bodies.length === 0) {
        out.push('  (none stored)');
      } else if (budget.diff === 0) {
        // Said once, not once per file. At brief this used to print an
        // identical "omitted" line for every diff in the turn — 15 of them on
        // the first real run — which buried the file list it sat under.
        const chars = bodies.reduce((sum, f) => sum + (f.unified_diff?.length ?? 0), 0);
        out.push(`  (${chars.toLocaleString('en-US')} characters of diff, not included at this length)`);
      } else {
        for (const f of bodies.slice(0, budget.files)) {
          out.push(`--- ${f.path}`);
          out.push(clip(f.unified_diff!, budget.diff));
        }
        if (bodies.length > budget.files) {
          out.push(`… ${bodies.length - budget.files} more diffs not included at this length`);
        }
      }
    }
  }

  return out.join('\n');
}

/**
 * A token estimate, and only ever an estimate.
 *
 * Four characters per token is a rule of thumb, not a measurement — the real
 * count comes from the API's own `usage`, which is what the output panel shows
 * once a model has run. Labelled "est." everywhere it is displayed so the two
 * are never mistaken for each other.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

const SYSTEM = [
  'You compact a run of CLI coding-agent turns into a single context block that a person will paste into a new session to resume the work.',
  '',
  'Write for the next session, not for a reader looking back. What matters is: what was being built, what was decided and why, what is done, what is unfinished, and any constraint the next turn must respect.',
  'Keep concrete identifiers — file paths, command names, error text, branch names. They are the handles the next session needs.',
  'The input is a record. Do not invent anything that is not in it, and where it says a value is unknown, unpriced or clipped, keep that uncertainty rather than resolving it.',
  'Output the context block as plain text. No preamble, no sign-off, no markdown headings.',
].join('\n');

export function compactionPrompt(block: string, length: CompactLength): {
  system: string;
  user: string;
} {
  return {
    system: SYSTEM,
    user: `${BUDGETS[length].instruction}\n\nHere is the record to compact:\n\n${block}`,
  };
}
