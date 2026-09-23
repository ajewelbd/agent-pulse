import Anthropic from '@anthropic-ai/sdk';
import { NextResponse } from 'next/server';
import {
  ANTHROPIC_MODELS,
  BUDGETS,
  COMPACT_PARTS,
  EFFORT_BY_LENGTH,
  OUTPUT_TOKENS_BY_LENGTH,
  assembleContext,
  compactionPrompt,
  estimateTokens,
  looksTruncated,
  planOllamaContext,
  type CompactLength,
  type CompactPart,
  type CompactTurn,
} from '@/lib/compact';
import { listOllamaModels, ollamaBaseUrl, ollamaChat } from '@/lib/ollama';
import {
  COMPACT_TURN_LIMIT,
  getCompactCommands,
  getCompactFiles,
  getCompactTurns,
} from '@/lib/queries';

export const dynamic = 'force-dynamic';

/**
 * Fold a hand-picked run of turns into one context block.
 *
 * The block is ALWAYS assembled here from the database, and returned whether or
 * not a model ran. That is the whole shape of this endpoint: assembly is the
 * product, summarisation is an enhancement over it. A machine with no
 * ANTHROPIC_API_KEY gets a complete, honest answer rather than an error, and a
 * machine where the API call fails gets the same answer plus the reason.
 *
 * This is the one route in the dashboard that talks to a network service.
 * Everything else is local by construction, so the two facts the UI has to
 * carry are stated in the response: whether a model ran, and which one.
 */

/** Read-only, like every other statement here. The pool enforces it. */
const MAX_OUTPUT_TOKENS = 16000;

interface Body {
  turnIds?: unknown;
  parts?: unknown;
  length?: unknown;
  provider?: unknown;
  model?: unknown;
  /** False runs assembly only, even when a model is configured. */
  summarize?: unknown;
}

function bad(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

/** Lazily constructed, for the reason the pg pool is: `next build` must not need a key. */
function client(): Anthropic {
  return new Anthropic();
}

export async function POST(request: Request) {
  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return bad('body is not JSON');
  }

  // ids are interpolated nowhere, but they are still checked here: the query
  // casts them to bigint[], and a non-numeric one would surface as a database
  // error rather than as the client mistake it is.
  const ids = Array.isArray(body.turnIds) ? body.turnIds.filter((v): v is string => typeof v === 'string') : [];
  if (ids.length === 0) return bad('no turns selected');
  if (ids.some((id) => !/^\d+$/.test(id))) return bad('turn ids must be numeric');
  if (ids.length > COMPACT_TURN_LIMIT) {
    return bad(`too many turns — ${COMPACT_TURN_LIMIT} is the most one block can hold`);
  }

  const partKeys = new Set(COMPACT_PARTS.map((p) => p.key as string));
  const parts = (Array.isArray(body.parts) ? body.parts : []).filter(
    (p): p is CompactPart => typeof p === 'string' && partKeys.has(p),
  );
  if (parts.length === 0) return bad('nothing to include — pick at least one part');

  const length = (typeof body.length === 'string' && body.length in BUDGETS
    ? body.length
    : 'standard') as CompactLength;

  const provider = body.provider === 'ollama' ? 'ollama' : 'anthropic';
  const requestedModel = typeof body.model === 'string' ? body.model : '';

  // ---- Stage 1: assembly. Always runs. ------------------------------------

  const wantDiffs = parts.includes('diffs');
  const [turnRows, commandRows, fileRows] = await Promise.all([
    getCompactTurns(ids),
    parts.includes('commands') ? getCompactCommands(ids) : Promise.resolve([]),
    parts.includes('files') || wantDiffs ? getCompactFiles(ids, wantDiffs) : Promise.resolve([]),
  ]);

  if (turnRows.length === 0) return NextResponse.json({ error: 'no such turns' }, { status: 404 });

  const byTurn = <T extends { turn_id: string }>(rows: T[], id: string): T[] =>
    rows.filter((r) => r.turn_id === id);

  // The caller's order, not the database's: it is the order the user arranged
  // in the panel, and the block is meant to read the way they arranged it.
  const material: CompactTurn[] = ids
    .map((id) => turnRows.find((t) => t.id === id))
    .filter((t): t is (typeof turnRows)[number] => t !== undefined)
    .map((t) => ({
      ...t,
      commands: byTurn(commandRows, t.id).map((c) => ({
        seq: c.seq,
        tool_name: c.tool_name,
        command: c.command,
        exit_code: c.exit_code,
        duration_ms: c.duration_ms,
        interrupted: c.interrupted,
      })),
      files: byTurn(fileRows, t.id).map((f) => ({
        seq: f.seq,
        path: f.path,
        change_type: f.change_type,
        lines_added: f.lines_added,
        lines_removed: f.lines_removed,
        is_binary: f.is_binary,
        unified_diff: f.unified_diff,
      })),
    }));

  const assembled = assembleContext(material, { parts, length });

  const blockTokens = estimateTokens(assembled);
  const base = {
    assembled,
    turns: material.length,
    missing: ids.length - material.length,
    provider,
    model: requestedModel,
    length,
    parts,
    estimatedInputTokens: blockTokens,
  };

  if (body.summarize === false) {
    return NextResponse.json({ ...base, output: assembled, summarized: false, reason: 'assembly only — no model was asked to run' });
  }

  const { system, user } = compactionPrompt(assembled, length);

  // ---- Stage 2: summarisation. Optional, and allowed to fail. -------------

  if (provider === 'ollama') {
    return summariseWithOllama({ base, assembled, blockTokens, length, requestedModel, system, user });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({
      ...base,
      output: assembled,
      summarized: false,
      reason: 'ANTHROPIC_API_KEY is not set, so no model ran. This is the assembled record itself.',
    });
  }

  const model = ANTHROPIC_MODELS.find((m) => m.id === requestedModel) ?? ANTHROPIC_MODELS[0]!;
  const common = {
    model: model.id,
    max_tokens: MAX_OUTPUT_TOKENS,
    system,
    messages: [{ role: 'user' as const, content: user }],
  };

  try {
    const response = model.fallback
      ? await client().beta.messages.create({
          ...common,
          ...(model.effort ? { output_config: { effort: EFFORT_BY_LENGTH[length] } } : {}),
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
        })
      : await client().messages.create({
          ...common,
          ...(model.effort ? { output_config: { effort: EFFORT_BY_LENGTH[length] } } : {}),
        });

    // Checked before the content is read, not after: a refused turn still
    // returns 200 with content blocks, and treating that as a summary would
    // put the refusal itself into the user's context block.
    if (response.stop_reason === 'refusal') {
      return NextResponse.json({
        ...base,
        output: assembled,
        summarized: false,
        reason: `The model declined to summarise this run${
          response.stop_details?.category ? ` (${response.stop_details.category})` : ''
        }. The assembled record is below, unchanged.`,
      });
    }

    const text = response.content
      .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();

    if (!text) {
      return NextResponse.json({
        ...base,
        output: assembled,
        summarized: false,
        reason: 'The model returned no text. The assembled record is below, unchanged.',
      });
    }

    return NextResponse.json({
      ...base,
      output: text,
      summarized: true,
      // The model that actually answered, which is not necessarily the one
      // asked for — a fallback may have served the turn.
      model: response.model,
      outputTruncated: response.stop_reason === 'max_tokens',
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        cacheReadTokens: response.usage.cache_read_input_tokens,
      },
    });
  } catch (error) {
    // The assembly is still good, so it is still returned. The failure is
    // named rather than swallowed — the panel shows it above the output.
    const reason =
      error instanceof Anthropic.APIError
        ? `${error.name}${error.status ? ` (${error.status})` : ''}: ${error.message}`
        : error instanceof Error
          ? error.message
          : 'unknown error';
    return NextResponse.json({
      ...base,
      output: assembled,
      summarized: false,
      reason: `No model ran — ${reason}. The assembled record is below, unchanged.`,
    });
  }
}

/**
 * The Ollama path.
 *
 * Structurally the same contract as the Anthropic one — the assembled block
 * comes back whatever happens, with a reason when no summary did — but with one
 * extra job the hosted API does not need: proving the model actually read the
 * whole block.
 *
 * Ollama does not refuse an over-long prompt. It drops the overflow and returns
 * HTTP 200 with `done_reason: "stop"`, which is indistinguishable from success.
 * Observed here on 2026-09-23: 4,600 tokens in, 258 evaluated, a confident
 * wrong answer out. So the fit is checked before the call from the model's own
 * reported context length, and the daemon's own `prompt_eval_count` is checked
 * against the window after it. Either check failing means the record is
 * returned instead of a summary nobody could trust.
 */
async function summariseWithOllama(args: {
  base: Record<string, unknown>;
  assembled: string;
  blockTokens: number;
  length: CompactLength;
  requestedModel: string;
  system: string;
  user: string;
}) {
  const { base, assembled, blockTokens, length, requestedModel, system, user } = args;
  const record = (reason: string) =>
    NextResponse.json({ ...base, output: assembled, summarized: false, reason });

  let available;
  try {
    available = await listOllamaModels(AbortSignal.timeout(2500));
  } catch {
    return record(
      `No Ollama daemon at ${ollamaBaseUrl()}, so no model ran. Start one with \`ollama serve\`. The assembled record is below, unchanged.`,
    );
  }

  // Matched against what the daemon actually has: the tray can outlive a model
  // being removed, and asking for a missing one returns a 404 that reads like a
  // bug rather than a stale choice.
  const model = available.find((m) => m.id === requestedModel);
  if (!model) {
    return record(
      `Ollama has no model called "${requestedModel}". Pull it, or pick another. The assembled record is below, unchanged.`,
    );
  }

  const plan = planOllamaContext(blockTokens, model.contextTokens, length);
  if (!plan.fits) {
    return record(
      `This block needs about ${plan.needed.toLocaleString('en-US')} tokens and ${model.id} holds ` +
        `${(model.contextTokens ?? 0).toLocaleString('en-US')}. Ollama would drop the overflow without saying so, ` +
        `so nothing was sent. Use a shorter Length, fewer turns, or a model with a bigger context. ` +
        `The assembled record is below, unchanged.`,
    );
  }

  try {
    const result = await ollamaChat({
      model: model.id,
      system,
      user,
      numCtx: plan.numCtx,
      numPredict: OUTPUT_TOKENS_BY_LENGTH[length],
    });

    // The backstop for everything the pre-check could not know — a tokenizer
    // denser than the estimate assumed, a template longer than expected.
    if (looksTruncated(result.promptEvalCount, plan.numCtx)) {
      return record(
        `${model.id} filled its whole ${plan.numCtx.toLocaleString('en-US')}-token window with the prompt, which means ` +
          `Ollama dropped part of it. Any summary would cover only some of these turns, so it is not shown. ` +
          `The assembled record is below, unchanged.`,
      );
    }

    if (!result.content) {
      return record(`${model.id} returned no text. The assembled record is below, unchanged.`);
    }

    return NextResponse.json({
      ...base,
      output: result.content,
      summarized: true,
      model: model.id,
      outputTruncated: result.doneReason === 'length',
      // Real counts from the daemon, not the char/4 estimate.
      usage: {
        inputTokens: result.promptEvalCount ?? null,
        outputTokens: result.evalCount ?? null,
        cacheReadTokens: null,
      },
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unknown error';
    return record(`No model ran — ${reason}. The assembled record is below, unchanged.`);
  }
}
