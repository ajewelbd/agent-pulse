import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assembleContext,
  estimateTokens,
  looksTruncated,
  planOllamaContext,
  stripIdeBlock,
  type CompactTurn,
} from './compact.js';

/**
 * What these tests are actually defending.
 *
 * The block this module produces is a document someone pastes into a new
 * session days later. By then the database row is out of sight, so anything the
 * block got wrong is indistinguishable from fact. The cases below are the four
 * ways it could lie: inventing a zero, inventing a success, hiding that it
 * abridged something, and hiding which run the turns came from.
 */

const NOW = new Date('2026-09-23T10:00:00Z');

function turn(over: Partial<CompactTurn> = {}): CompactTurn {
  return {
    id: '19',
    seq: 19,
    started_at: new Date('2026-09-22T04:50:00Z'),
    status: 'complete',
    project_name: 'ai-usages',
    agent_key: 'claude_code',
    git_branch: 'main',
    model_raw: 'claude-opus-5',
    external_session_id: '1475f2db-0000-4000-8000-000000000000',
    prompt_text: 'Add CLAUSE.md and related files',
    response_text: 'Added four files.',
    token_source: 'provider',
    total_input_tokens: '6900000',
    output_tokens: '60900',
    cost_usd: '6.65',
    cost_source: 'computed',
    duration_ms: '779000',
    commands: [],
    files: [],
    ...over,
  };
}

const ALL = { parts: ['prompt', 'response', 'commands', 'files'] as const, length: 'standard' as const, now: NOW };

test('an unreported turn renders — for tokens, never 0', () => {
  // total_input_tokens is a generated column coalescing NULLs to 0, so the
  // number in the row IS 0. token_source is what tells them apart.
  const block = assembleContext(
    [turn({ token_source: 'unknown', total_input_tokens: '0', output_tokens: null })],
    { ...ALL, parts: [...ALL.parts] },
  );
  assert.match(block, /— in \/ — out/);
  assert.doesNotMatch(block, /\b0 in\b/);
});

test('an unpriced turn says so rather than $0.00', () => {
  const block = assembleContext([turn({ cost_usd: null, cost_source: 'unpriced' })], {
    ...ALL,
    parts: [...ALL.parts],
  });
  assert.match(block, /not priced/);
  assert.doesNotMatch(block, /\$0\.00/);
});

test('a command with no recorded exit code says unknown, not success', () => {
  const block = assembleContext(
    [
      turn({
        commands: [
          { seq: 1, tool_name: 'Bash', command: 'make test', exit_code: null, duration_ms: '1200', interrupted: false },
        ],
      }),
    ],
    { ...ALL, parts: [...ALL.parts] },
  );
  assert.match(block, /exit unknown/);
  assert.doesNotMatch(block, /exit 0/);
});

test('clipping is announced with the number of characters dropped', () => {
  const long = 'x'.repeat(5000);
  const block = assembleContext([turn({ response_text: long })], {
    parts: ['response'],
    length: 'standard', // response budget 3000
    now: NOW,
  });
  assert.match(block, /\[clipped — 2000 more characters\]/);
});

test('a part that is switched off leaves no trace of itself', () => {
  const block = assembleContext(
    [turn({ files: [{ seq: 1, path: 'a.ts', change_type: 'modified', lines_added: 3, lines_removed: 1, is_binary: false, unified_diff: null }] })],
    { parts: ['prompt'], length: 'brief', now: NOW },
  );
  assert.match(block, /PROMPT/);
  assert.doesNotMatch(block, /FILES/);
  assert.doesNotMatch(block, /RESPONSE/);
});

test('turns from two sessions say so in the header', () => {
  const block = assembleContext(
    [turn(), turn({ seq: 4, external_session_id: 'aaaaaaaa-0000-4000-8000-000000000000' })],
    { ...ALL, parts: [...ALL.parts] },
  );
  assert.match(block, /^2 sessions \(/m);
  assert.match(block, /turns #4–#19 \(2 selected\)/);
});

test('disagreeing branches are listed, not silently reduced to one', () => {
  const block = assembleContext([turn(), turn({ seq: 20, git_branch: 'feature-x' })], {
    ...ALL,
    parts: [...ALL.parts],
  });
  assert.match(block, /branch 2 branches \(main, feature-x\)/);
});

test('the editor block is stripped from the prompt but still reported', () => {
  const block = assembleContext(
    [turn({ prompt_text: '<ide_opened_file>server.ts opened</ide_opened_file>\nfix the bug' })],
    { ...ALL, parts: [...ALL.parts] },
  );
  assert.match(block, /carried an <ide_opened_file> block/);
  assert.match(block, /^fix the bug$/m);
  assert.doesNotMatch(block, /server\.ts opened/);
});

test('stripIdeBlock leaves a prompt without one alone', () => {
  assert.deepEqual(stripIdeBlock('plain prompt'), { text: 'plain prompt', ideKind: null });
});

test('an empty selection assembles to nothing at all', () => {
  assert.equal(assembleContext([], { ...ALL, parts: [...ALL.parts] }), '');
});

test('the token figure is an estimate over characters', () => {
  assert.equal(estimateTokens('abcd'), 1);
  assert.equal(estimateTokens('abcde'), 2);
});

/**
 * The Ollama guards.
 *
 * Measured on this machine on 2026-09-23, Ollama 0.34.2: a ~4,600-token prompt
 * sent with num_ctx 512 returned HTTP 200, done_reason "stop",
 * prompt_eval_count 258, and a wrong answer stated as fact. Nothing in the
 * response says the prompt was cut. These two functions are the only thing
 * standing between that behaviour and a context block that claims to cover
 * turns the model never saw.
 */

test('the plan corrects for how badly chars/4 undercounts a block', () => {
  // Measured 1.52x and 1.58x against qwen2.5-coder's own prompt_eval_count on
  // 2026-09-23. A plan that trusted the raw estimate would size the window a
  // third too small, and Ollama drops the overflow without a word.
  const plan = planOllamaContext(1000, 131072, 'brief');
  assert.equal(plan.needed, 1800 + 800);
  assert.ok(plan.needed > 1000 * 1.58, 'must clear the worst ratio actually observed');
});

test('a block that cannot fit the model window is refused, not sent', () => {
  // 2,000 estimated is ~3,600 real; +800 for the answer clears 4,096.
  const plan = planOllamaContext(2000, 4096, 'brief');
  assert.equal(plan.fits, false);
});

test('a block that fits asks for a window big enough to hold it', () => {
  const plan = planOllamaContext(10000, 32768, 'standard'); // 18,000 + 2,000
  assert.equal(plan.fits, true);
  assert.equal(plan.numCtx, 20480); // 20,000 rounded up to a 1024 boundary
  assert.ok(plan.numCtx >= plan.needed, 'the window must hold the whole prompt');
});

test('the window never exceeds what the model actually has', () => {
  const plan = planOllamaContext(200000, 32768, 'detailed');
  assert.equal(plan.numCtx, 32768);
  assert.equal(plan.fits, false);
});

test('a tiny block still asks for a usable window', () => {
  // Below 4096 there is nothing to gain and the prompt is at risk again.
  assert.equal(planOllamaContext(10, 131072, 'brief').numCtx, 4096);
});

test('a model that reports no context length is attempted, not blocked', () => {
  const plan = planOllamaContext(50000, null, 'brief');
  assert.equal(plan.fits, true);
  assert.ok(plan.numCtx >= plan.needed);
});

test('a prompt that filled the whole window is treated as truncated', () => {
  assert.equal(looksTruncated(4096, 4096), true);
  assert.equal(looksTruncated(4090, 4096), true);
});

test('a prompt with room to spare is not accused of truncation', () => {
  assert.equal(looksTruncated(258, 4096), false);
  assert.equal(looksTruncated(undefined, 4096), false);
});
