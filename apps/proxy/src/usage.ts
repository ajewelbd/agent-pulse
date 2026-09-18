/**
 * Usage extraction from provider responses.
 *
 * Two API shapes and two transports, and the streaming variants report usage
 * in a completely different place from the non-streaming ones. Getting this
 * wrong does not error — it silently records zero tokens, which is worse than
 * recording nothing because it looks like a real measurement.
 *
 * Anthropic:
 *   non-streaming  body.usage
 *   streaming      `message_start` carries input/cache counts on
 *                  data.message.usage; `message_delta` carries the running
 *                  output count on data.usage. The output number in
 *                  message_start is a placeholder and must NOT be summed with
 *                  the deltas — the last message_delta already holds the total.
 *
 * OpenAI-compatible:
 *   non-streaming  body.usage {prompt_tokens, completion_tokens}
 *   streaming      usage appears only if the caller sent
 *                  stream_options.include_usage, in a final chunk whose
 *                  `choices` array is empty. When absent, there is nothing to
 *                  report and we must say so rather than record zeros.
 */

export interface ExtractedUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  cacheWrite5mTokens: number | null;
  cacheWrite1hTokens: number | null;
  modelRaw: string | null;
  /** False when the response carried no usage at all — do not store zeros. */
  reported: boolean;
}

export const EMPTY_USAGE: ExtractedUsage = {
  inputTokens: null,
  outputTokens: null,
  cacheReadTokens: null,
  cacheWriteTokens: null,
  cacheWrite5mTokens: null,
  cacheWrite1hTokens: null,
  modelRaw: null,
  reported: false,
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

/** Anthropic `usage` object → our shape. Shared by both transports. */
function readAnthropicUsage(usage: Record<string, unknown>, into: ExtractedUsage): void {
  const input = num(usage['input_tokens']);
  const output = num(usage['output_tokens']);
  const cacheRead = num(usage['cache_read_input_tokens']);
  const cacheWrite = num(usage['cache_creation_input_tokens']);

  if (input !== null) into.inputTokens = input;
  if (output !== null) into.outputTokens = output;
  if (cacheRead !== null) into.cacheReadTokens = cacheRead;
  if (cacheWrite !== null) into.cacheWriteTokens = cacheWrite;

  const creation = usage['cache_creation'];
  if (isRecord(creation)) {
    const five = num(creation['ephemeral_5m_input_tokens']);
    const hour = num(creation['ephemeral_1h_input_tokens']);
    if (five !== null) into.cacheWrite5mTokens = five;
    if (hour !== null) into.cacheWrite1hTokens = hour;
  }
  into.reported = true;
}

/** OpenAI-compatible `usage` object → our shape. */
function readOpenAiUsage(usage: Record<string, unknown>, into: ExtractedUsage): void {
  const prompt = num(usage['prompt_tokens']);
  const completion = num(usage['completion_tokens']);
  if (completion !== null) into.outputTokens = completion;

  // Cached prompt tokens are reported INSIDE prompt_tokens, unlike Anthropic
  // where cache reads are a separate bucket. Subtracting keeps
  // input + cache_read consistent across providers, which is what the
  // dashboard's total_input_tokens assumes.
  const details = usage['prompt_tokens_details'];
  const cached = isRecord(details) ? num(details['cached_tokens']) : null;
  if (cached !== null && cached > 0) {
    into.cacheReadTokens = cached;
    into.inputTokens = prompt === null ? null : Math.max(0, prompt - cached);
  } else if (prompt !== null) {
    into.inputTokens = prompt;
  }
  into.reported = true;
}

/** Parse a non-streaming JSON response body. */
export function extractFromJson(body: string): ExtractedUsage {
  const out: ExtractedUsage = { ...EMPTY_USAGE };
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return out;
  }
  if (!isRecord(parsed)) return out;

  out.modelRaw = str(parsed['model']);

  const usage = parsed['usage'];
  if (!isRecord(usage)) return out;

  // Anthropic and OpenAI usage objects are distinguished by their field names,
  // not by the endpoint — a "compatible" gateway may serve either shape.
  if ('input_tokens' in usage || 'cache_read_input_tokens' in usage) {
    readAnthropicUsage(usage, out);
  } else if ('prompt_tokens' in usage || 'completion_tokens' in usage) {
    readOpenAiUsage(usage, out);
  }
  return out;
}

/**
 * Parse an SSE stream body.
 *
 * Tolerates partial/truncated streams: an aborted request still yields
 * whatever was reported before the abort, which is the honest answer.
 */
export function extractFromSse(body: string): ExtractedUsage {
  const out: ExtractedUsage = { ...EMPTY_USAGE };

  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (payload === '' || payload === '[DONE]') continue;

    let event: unknown;
    try {
      event = JSON.parse(payload);
    } catch {
      continue; // a chunk split across reads; ignore rather than fail the request
    }
    if (!isRecord(event)) continue;

    const type = str(event['type']);

    // --- Anthropic ---
    if (type === 'message_start') {
      const message = event['message'];
      if (isRecord(message)) {
        out.modelRaw = str(message['model']) ?? out.modelRaw;
        const usage = message['usage'];
        if (isRecord(usage)) readAnthropicUsage(usage, out);
      }
      continue;
    }
    if (type === 'message_delta') {
      const usage = event['usage'];
      if (isRecord(usage)) {
        // Overwrites rather than adds: message_delta reports the running
        // total, so summing deltas would multiply the output count.
        const output = num(usage['output_tokens']);
        if (output !== null) out.outputTokens = output;
        out.reported = true;
      }
      continue;
    }

    // --- OpenAI-compatible ---
    if (out.modelRaw === null) out.modelRaw = str(event['model']);
    const usage = event['usage'];
    if (isRecord(usage)) readOpenAiUsage(usage, out);
  }

  return out;
}

export function extractUsage(contentType: string | null, body: string): ExtractedUsage {
  const isSse = (contentType ?? '').toLowerCase().includes('text/event-stream');
  return isSse ? extractFromSse(body) : extractFromJson(body);
}

/** Model requested, read from the REQUEST body — the only source on an error. */
export function modelFromRequest(body: string): string | null {
  try {
    const parsed: unknown = JSON.parse(body);
    return isRecord(parsed) ? str(parsed['model']) : null;
  } catch {
    return null;
  }
}

/** Did the caller ask for a stream? Decides how the response is handled. */
export function requestWantsStream(body: string): boolean {
  try {
    const parsed: unknown = JSON.parse(body);
    return isRecord(parsed) && parsed['stream'] === true;
  } catch {
    return false;
  }
}
