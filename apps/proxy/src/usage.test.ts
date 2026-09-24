/**
 * Usage extraction and provider attribution tests.
 *
 * These are the two places where being wrong is silent: a missed usage field
 * records zero tokens (which looks like a measurement), and a wrong host rule
 * bills gateway traffic at direct rates. Both are testable without a network.
 *
 * Run with: pnpm --filter @agentpulse/proxy test
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { providerForHost } from './providers.js';
import { extractFromJson, extractFromSse, extractUsage, requestWantsStream } from './usage.js';

// ---------------------------------------------------------------------------
// Provider attribution
// ---------------------------------------------------------------------------

test('first-party hosts', () => {
  assert.equal(providerForHost('api.anthropic.com'), 'anthropic');
  assert.equal(providerForHost('api.openai.com'), 'openai');
  assert.equal(providerForHost('generativelanguage.googleapis.com'), 'google');
  assert.equal(providerForHost('dashscope.aliyuncs.com'), 'dashscope');
});

test('gateways are not attributed to the vendor they resell', () => {
  // The whole point of Layer 3: these serve claude-* models, and a model-id
  // lookup would wrongly bill them as Anthropic direct.
  assert.equal(providerForHost('openrouter.ai'), 'openrouter');
  assert.equal(providerForHost('api.githubcopilot.com'), 'github-copilot');
  assert.equal(providerForHost('bedrock-runtime.us-east-1.amazonaws.com'), 'aws-bedrock');
  assert.equal(providerForHost('us-central1-aiplatform.googleapis.com'), 'google-vertex');
  assert.equal(providerForHost('my-resource.openai.azure.com'), 'azure');
});

test('vertex is matched before the generic googleapis rule', () => {
  assert.notEqual(providerForHost('us-central1-aiplatform.googleapis.com'), 'google');
});

test('local inference', () => {
  for (const host of ['localhost', '127.0.0.1', 'host.docker.internal', 'mybox.local']) {
    assert.equal(providerForHost(host), 'ollama', host);
  }
});

test('host matching respects label boundaries', () => {
  // 'notopenai.com' must not be attributed to OpenAI.
  assert.equal(providerForHost('notopenai.com'), 'unknown');
  assert.equal(providerForHost('evil-anthropic.com.attacker.net'), 'unknown');
});

test('ports are ignored, and unknown hosts stay unknown', () => {
  assert.equal(providerForHost('api.anthropic.com:443'), 'anthropic');
  assert.equal(providerForHost('example.invalid'), 'unknown');
  assert.equal(providerForHost(''), 'unknown');
});

// ---------------------------------------------------------------------------
// Anthropic usage
// ---------------------------------------------------------------------------

test('anthropic non-streaming, with both cache TTL buckets', () => {
  const u = extractFromJson(JSON.stringify({
    model: 'claude-opus-4-8',
    usage: {
      input_tokens: 2,
      output_tokens: 553,
      cache_read_input_tokens: 12959,
      cache_creation_input_tokens: 19422,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 19422 },
    },
  }));
  assert.equal(u.reported, true);
  assert.equal(u.modelRaw, 'claude-opus-4-8');
  assert.equal(u.inputTokens, 2);
  assert.equal(u.outputTokens, 553);
  assert.equal(u.cacheReadTokens, 12959);
  assert.equal(u.cacheWriteTokens, 19422);
  assert.equal(u.cacheWrite1hTokens, 19422);
  assert.equal(u.cacheWrite5mTokens, 0);
});

test('anthropic streaming: message_delta reports a RUNNING TOTAL, not an increment', () => {
  // Summing the deltas would report 1+5+9 = 15 instead of 9.
  const sse = [
    'event: message_start',
    `data: ${JSON.stringify({ type: 'message_start', message: { model: 'claude-opus-5', usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 500 } } })}`,
    '',
    `data: ${JSON.stringify({ type: 'message_delta', usage: { output_tokens: 5 } })}`,
    '',
    `data: ${JSON.stringify({ type: 'message_delta', usage: { output_tokens: 9 } })}`,
    '',
    'data: [DONE]',
  ].join('\n');
  const u = extractFromSse(sse);
  assert.equal(u.modelRaw, 'claude-opus-5');
  assert.equal(u.inputTokens, 10);
  assert.equal(u.cacheReadTokens, 500);
  assert.equal(u.outputTokens, 9);
  assert.equal(u.reported, true);
});

test('a truncated anthropic stream still yields what was reported', () => {
  const sse = [
    `data: ${JSON.stringify({ type: 'message_start', message: { model: 'claude-opus-5', usage: { input_tokens: 42 } } })}`,
    'data: {"type":"message_delta","usage":{"output_to',  // cut mid-chunk
  ].join('\n');
  const u = extractFromSse(sse);
  assert.equal(u.inputTokens, 42);
  assert.equal(u.outputTokens, null);
  assert.equal(u.reported, true);
});

// ---------------------------------------------------------------------------
// OpenAI-compatible usage
// ---------------------------------------------------------------------------

test('openai non-streaming', () => {
  const u = extractFromJson(JSON.stringify({
    model: 'gpt-4o',
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
  }));
  assert.equal(u.inputTokens, 100);
  assert.equal(u.outputTokens, 20);
  assert.equal(u.cacheReadTokens, null);
});

test('openai cached prompt tokens are split out of prompt_tokens', () => {
  // OpenAI reports cached tokens INSIDE prompt_tokens; Anthropic reports them
  // separately. Without the split, input+cache_read would double-count.
  const u = extractFromJson(JSON.stringify({
    model: 'gpt-4o',
    usage: { prompt_tokens: 1000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 800 } },
  }));
  assert.equal(u.inputTokens, 200);
  assert.equal(u.cacheReadTokens, 800);
  assert.equal((u.inputTokens ?? 0) + (u.cacheReadTokens ?? 0), 1000);
});

test('openai streaming with include_usage', () => {
  const sse = [
    `data: ${JSON.stringify({ model: 'gpt-4o', choices: [{ delta: { content: 'hi' } }] })}`,
    `data: ${JSON.stringify({ model: 'gpt-4o', choices: [], usage: { prompt_tokens: 7, completion_tokens: 3 } })}`,
    'data: [DONE]',
  ].join('\n');
  const u = extractFromSse(sse);
  assert.equal(u.modelRaw, 'gpt-4o');
  assert.equal(u.inputTokens, 7);
  assert.equal(u.outputTokens, 3);
});

// ---------------------------------------------------------------------------
// Absence must be reported as absence, never as zero
// ---------------------------------------------------------------------------

test('a response with no usage reports reported=false, not zeros', () => {
  const u = extractFromJson(JSON.stringify({ model: 'gpt-4o', choices: [] }));
  assert.equal(u.reported, false);
  assert.equal(u.inputTokens, null);
  assert.equal(u.outputTokens, null);
  assert.equal(u.modelRaw, 'gpt-4o');
});

test('openai streaming WITHOUT include_usage reports nothing', () => {
  const sse = `data: ${JSON.stringify({ model: 'gpt-4o', choices: [{ delta: { content: 'x' } }] })}\ndata: [DONE]`;
  const u = extractFromSse(sse);
  assert.equal(u.reported, false);
  assert.equal(u.outputTokens, null);
});

test('malformed and empty bodies do not throw', () => {
  for (const body of ['', 'not json', '{', '<html>502</html>']) {
    const u = extractFromJson(body);
    assert.equal(u.reported, false);
  }
});

test('extractUsage dispatches on content-type', () => {
  const sse = `data: ${JSON.stringify({ type: 'message_start', message: { model: 'm', usage: { input_tokens: 5 } } })}`;
  assert.equal(extractUsage('text/event-stream; charset=utf-8', sse).inputTokens, 5);
  assert.equal(extractUsage('application/json', '{"usage":{"input_tokens":9}}').inputTokens, 9);
});

test('requestWantsStream reads the request body', () => {
  assert.equal(requestWantsStream('{"model":"m","stream":true}'), true);
  assert.equal(requestWantsStream('{"model":"m"}'), false);
  assert.equal(requestWantsStream('garbage'), false);
});
