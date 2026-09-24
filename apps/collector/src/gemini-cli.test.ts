/**
 * Gemini CLI adapter tests. Run with: node --test (after tsc)
 *
 * Fixtures are cut-down copies of the line shapes in the three Gemini CLI
 * 0.61.0 sessions on this machine (2026-09-24), including the rewind a quota
 * error caused and the double write of every message that calls a tool.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { GeminiCliAdapter, replayJsonl } from './adapters/gemini-cli.js';
import type { DiscoveredTranscript } from './adapters/types.js';

const header = { sessionId: 's1', projectHash: 'abc', startTime: '2026-09-24T03:36:44.189Z', lastUpdated: '2026-09-24T03:36:44.189Z', kind: 'main' };
const context = { id: 'ctx', timestamp: '2026-09-24T03:36:44.190Z', type: 'user', content: [{ text: '<session_context>\nThis is the Gemini CLI.' }] };
const editor = { id: 'ed', timestamp: '2026-09-24T03:36:45.000Z', type: 'user', content: [{ text: "Here is the user's editor context as a JSON object." }] };
const failed = { id: 'p0', timestamp: '2026-09-24T03:36:46.000Z', type: 'user', content: [{ text: 'create GEMINI.md file' }] };
const error = { id: 'err', timestamp: '2026-09-24T03:36:47.000Z', type: 'error', content: '[API Error: You have exhausted your daily quota on this model.]' };
const prompt = { id: 'p1', timestamp: '2026-09-24T03:37:00.000Z', type: 'user', content: [{ text: 'create GEMINI.md file' }] };
const tokens = { input: 100, output: 10, cached: 40, thoughts: 5, tool: 0, total: 115 };
const streamed = { id: 'g1', timestamp: '2026-09-24T03:37:01.000Z', type: 'gemini', content: '', tokens, model: 'gemini-3.5-flash-lite' };
const withTools = {
  ...streamed,
  toolCalls: [
    {
      id: 'run_shell_command__call_1',
      name: 'run_shell_command',
      args: { command: 'pnpm test' },
      result: [{ functionResponse: { id: 'run_shell_command__call_1', name: 'run_shell_command', response: { output: 'Output: ok' } } }],
      status: 'success',
      timestamp: '2026-09-24T03:37:04.000Z',
    },
  ],
};
const toolResult = { id: 'tr', timestamp: '2026-09-24T03:37:04.002Z', type: 'user', content: [{ functionResponse: { id: 'run_shell_command__call_1' } }] };
const answer = { id: 'g2', timestamp: '2026-09-24T03:37:05.000Z', type: 'gemini', content: 'Done.', tokens, model: 'gemini-3.5-flash-lite' };
const next = { id: 'p2', timestamp: '2026-09-24T03:38:00.000Z', type: 'user', content: [{ text: 'exit' }] };

const lines = (...records: unknown[]): string => records.map((r) => JSON.stringify(r)).join('\n') + '\n';

const session = lines(
  header,
  { $set: { messages: [context], lastUpdated: 'x' } },
  editor,
  failed,
  // The rewind: the failed prompt is dropped, the error is appended after it.
  { $set: { messages: [context, editor] } },
  error,
  prompt,
  streamed,
  withTools, // same id, rewritten once the tool finished
  toolResult,
  answer,
  next,
  { $set: { memoryScratchpad: { version: 1 } } },
);

const transcript: DiscoveredTranscript = {
  containerPath: '/host/agents/gemini/tmp/ai-usages/chats/session-x.jsonl',
  externalSessionId: 'ai-usages/session-x',
  isSidechain: false,
  parentExternalSessionId: null,
};

const adapter = new GeminiCliAdapter('/host/agents/gemini', [], (p) => p);
const parse = (text: string) => adapter.parse(transcript, Buffer.from(text), 0, 1);

test('replay upserts by id and $set.messages replaces the list', () => {
  const { session: s, promptOrder } = replayJsonl(session);
  assert.deepEqual(s.messages?.map((m) => m.id), ['ctx', 'ed', 'err', 'p1', 'g1', 'tr', 'g2', 'p2']);
  assert.equal(s.messages?.find((m) => m.id === 'g1')?.toolCalls?.length, 1);
  assert.equal(s.projectHash, 'abc');
  // The rewound prompt keeps its place in the numbering.
  assert.deepEqual(promptOrder, ['p0', 'p1', 'p2']);
});

test('only typed prompts start turns; tool results and injected context do not', () => {
  const result = parse(session);
  assert.deepEqual(result.turns.map((t) => t.externalTurnId), ['p1']);
  assert.equal(result.openTurn?.externalTurnId, 'p2');
  assert.equal(result.turns[0]!.promptText, 'create GEMINI.md file');
  assert.equal(result.turns[0]!.responseText, 'Done.');
});

test('seq comes from the file, so a rewind leaves a gap instead of a collision', () => {
  const result = parse(session);
  assert.equal(result.turns[0]!.seq, 2);
  assert.equal(result.openTurn?.seq, 3);
});

test('the error before the retried prompt is not charged to it', () => {
  // It lands before p1 in the replayed list, with no turn open.
  assert.equal(parse(session).turns[0]!.status, 'complete');
});

test('a tool call is taken from the final write of its message', () => {
  const [call] = parse(session).turns[0]!.toolCalls;
  assert.equal(call?.toolName, 'run_shell_command');
  assert.equal(call?.command, 'pnpm test');
  assert.equal(call?.stdout, 'Output: ok');
  assert.equal(call?.exitCode, null);
  assert.equal(call?.durationMs, 3000);
  assert.equal(call?.durationSource, 'derived');
});

test('tokens are counted once per message, not once per write', () => {
  const turn = parse(session).turns[0]!;
  // 200 reported, of which 80 cached: input_tokens is the uncached 120.
  assert.equal(turn.inputTokens, 120);
  assert.equal(turn.outputTokens, 30);
  assert.equal(turn.cacheReadTokens, 80);
});

test('re-parsing after an append keeps every existing seq', () => {
  const first = parse(session);
  const grown = parse(session + lines(answer, { id: 'p3', timestamp: '2026-09-24T03:39:00.000Z', type: 'user', content: [{ text: 'hi' }] }));
  assert.equal(grown.turns.find((t) => t.externalTurnId === 'p1')?.seq, first.turns[0]!.seq);
  assert.equal(grown.turns.find((t) => t.externalTurnId === 'p2')?.status, 'complete');
  assert.equal(grown.openTurn?.seq, 4);
});

test('a half-written last line is skipped, not fatal', () => {
  const result = parse(session + '{"id":"g3","type":"gem');
  assert.equal(result.openTurn?.externalTurnId, 'p2');
});
