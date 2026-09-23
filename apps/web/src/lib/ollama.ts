import type { CompactModel } from './compact';

/**
 * Talking to a local Ollama daemon.
 *
 * Every shape in this file was read off a running daemon on 2026-09-23 —
 * Ollama 0.34.2, `GET /api/tags` and `POST /api/chat` — not recalled. The
 * fields actually observed are named in the interfaces below; anything not
 * listed there was not present and is not relied on.
 *
 * Why this exists alongside the Anthropic path: the dashboard's whole premise
 * is that this database never leaves the machine, and a compaction is a bundle
 * of prompts and responses. Ollama keeps that true. It is the only provider
 * here that does.
 */

/** Default is the daemon's own; in compose the host is reached by name. */
export function ollamaBaseUrl(): string {
  return (process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434').replace(/\/+$/, '');
}

/** The subset of an /api/tags entry this app reads. */
interface TagEntry {
  name?: unknown;
  model?: unknown;
  details?: { parameter_size?: unknown; context_length?: unknown } | null;
  /** Present only on `:cloud` models, which are proxied off this machine. */
  remote_host?: unknown;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * The models this daemon has, as panel options.
 *
 * `remote_host` is surfaced rather than filtered out. A `:cloud` model is
 * served through ollama.com, so picking one sends the block off this machine —
 * the same property the Anthropic path has, and the user is entitled to know
 * which of their own models is which.
 */
export async function listOllamaModels(signal?: AbortSignal): Promise<CompactModel[]> {
  const response = await fetch(`${ollamaBaseUrl()}/api/tags`, { signal, cache: 'no-store' });
  if (!response.ok) throw new Error(`ollama /api/tags returned ${response.status}`);
  const body: unknown = await response.json();
  const models = body && typeof body === 'object' && Array.isArray((body as { models?: unknown }).models)
    ? ((body as { models: TagEntry[] }).models)
    : [];

  return models.flatMap((entry): CompactModel[] => {
    const id = str(entry.name) ?? str(entry.model);
    if (!id) return [];
    const remote = str(entry.remote_host);
    const size = str(entry.details?.parameter_size);
    const ctx = typeof entry.details?.context_length === 'number' ? entry.details.context_length : null;
    const note = [
      size ? `${size} parameters` : null,
      ctx ? `${ctx.toLocaleString('en-US')} token context` : 'context length not reported',
      remote ? `served through ${remote} — this one DOES leave your machine` : 'runs on this machine',
    ]
      .filter(Boolean)
      .join(' · ');
    return [{ provider: 'ollama', id, label: id, note, contextTokens: ctx }];
  });
}

/**
 * The fields of an /api/chat response this app reads.
 *
 * `done_reason` is 'stop' or 'length'. `prompt_eval_count` and `eval_count`
 * are real counts from the daemon, not estimates — which is why the output
 * panel can show exact figures for Ollama, as it does for the Anthropic usage.
 */
export interface OllamaChatResult {
  content: string;
  doneReason: string | null;
  promptEvalCount: number | undefined;
  evalCount: number | undefined;
}

export async function ollamaChat(args: {
  model: string;
  system: string;
  user: string;
  numCtx: number;
  numPredict: number;
  signal?: AbortSignal;
}): Promise<OllamaChatResult> {
  const response = await fetch(`${ollamaBaseUrl()}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal: args.signal,
    body: JSON.stringify({
      model: args.model,
      stream: false,
      messages: [
        { role: 'system', content: args.system },
        { role: 'user', content: args.user },
      ],
      options: {
        // Set explicitly, always. Ollama's default window is far smaller than
        // most models' own, and anything over it is dropped in silence — see
        // planOllamaContext for the run that proved it.
        num_ctx: args.numCtx,
        num_predict: args.numPredict,
        // A summary of a record should not vary run to run.
        temperature: 0,
      },
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`ollama /api/chat returned ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
  }

  const body: unknown = await response.json();
  const message = (body as { message?: { content?: unknown } })?.message;
  const raw = typeof message?.content === 'string' ? message.content : '';

  return {
    // Reasoning models (deepseek-r1 among the ones pulled here) emit their
    // working in <think> blocks ahead of the answer. That is the model talking
    // to itself, not part of the context block, so it is dropped.
    content: raw.replace(/<think>[\s\S]*?<\/think>/g, '').trim(),
    doneReason: str((body as { done_reason?: unknown })?.done_reason),
    promptEvalCount: typeof (body as { prompt_eval_count?: unknown })?.prompt_eval_count === 'number'
      ? (body as { prompt_eval_count: number }).prompt_eval_count
      : undefined,
    evalCount: typeof (body as { eval_count?: unknown })?.eval_count === 'number'
      ? (body as { eval_count: number }).eval_count
      : undefined,
  };
}
