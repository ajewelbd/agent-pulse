import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatShare, shareOf, sumTokenParts, sumTokenWorking, tokenWorking } from './tokens.js';

/**
 * Fixtures are real rows from this archive, taken verbatim on 2026-09-23.
 * Strings, because that is what pg returns for bigint.
 */

/** Turn 8420: an ordinary priced turn. */
const REPORTED = {
  token_source: 'provider',
  input_tokens: '104',
  cache_read_tokens: '2797500',
  cache_write_tokens: '197301',
  cache_write_5m_tokens: '0',
  cache_write_1h_tokens: '197301',
  output_tokens: '62884',
  total_input_tokens: '2994905',
};

/** Turn 77140: no assistant record carried usage, so every count is NULL. */
const UNREPORTED = {
  token_source: 'unknown',
  input_tokens: null,
  cache_read_tokens: null,
  cache_write_tokens: null,
  cache_write_5m_tokens: null,
  cache_write_1h_tokens: null,
  output_tokens: null,
  // The generated column coalesces the NULLs above to 0. This is the trap.
  total_input_tokens: '0',
};

/** Turn 17550: the provider's 1h bucket exceeds its own cache-write total. */
const SPLIT_EXCEEDS = {
  token_source: 'provider',
  input_tokens: '142',
  cache_read_tokens: '15878079',
  cache_write_tokens: '165878',
  cache_write_5m_tokens: '0',
  cache_write_1h_tokens: '167013',
  output_tokens: '56010',
  total_input_tokens: '16044099',
};

test('the parts reconstruct the generated total_input_tokens exactly', () => {
  const working = tokenWorking(REPORTED);
  assert.ok(working);
  assert.deepEqual(
    working.parts.map((p) => p.key),
    ['input', 'cache_read', 'cache_write'],
  );
  // This is migration 004's generated column, recomputed: coalesce(input,0)
  // + coalesce(cache_read,0) + coalesce(cache_write,0).
  assert.equal(working.totalIn, Number(REPORTED.total_input_tokens));
  assert.equal(working.output, 62884);
});

/**
 * The whole reason this module exists. `total_input_tokens` is generated with
 * `coalesce(…, 0)`, so an unreported turn arrives as a real 0 and no
 * null-check can catch it — `token_source` is the only signal.
 */
test('a turn that reported no usage has no breakdown, rather than a breakdown of zeroes', () => {
  assert.equal(tokenWorking(UNREPORTED), null);
  assert.equal(tokenWorking(null), null);
  // And the trap it guards: the raw column really does say zero.
  assert.equal(Number(UNREPORTED.total_input_tokens), 0);
});

/**
 * Turns 17550 and 8610 report more in the 5m/1h buckets than in the
 * cache-write total — by 1,135 and 2,890 tokens. Both figures are the
 * provider's own, accumulated over the turn's assistant messages, so neither
 * is corrected here; the disagreement is surfaced instead.
 */
test('cache-write buckets that exceed their own total are flagged, not silently fixed', () => {
  const working = tokenWorking(SPLIT_EXCEEDS);
  assert.ok(working?.writeSplit);
  assert.equal(working.writeSplit.sum, 167013);
  assert.equal(working.writeSplit.exceedsTotal, true);
  // The total still uses the reported cache-write total, unchanged.
  assert.equal(sumTokenParts(working, ['cache_write']), 165878);
  assert.equal(working.totalIn, Number(SPLIT_EXCEEDS.total_input_tokens));
});

test('buckets that fit inside their total are not flagged', () => {
  const working = tokenWorking(REPORTED);
  assert.equal(working?.writeSplit?.exceedsTotal, false);
});

test('shares are of the input total, and a zero total does not divide by zero', () => {
  const working = tokenWorking(REPORTED)!;
  const cacheRead = working.parts.find((p) => p.key === 'cache_read')!;
  assert.equal(shareOf(working, cacheRead), (2797500 / 2994905) * 100);

  const empty = tokenWorking({
    ...REPORTED,
    input_tokens: '0',
    cache_read_tokens: '0',
    cache_write_tokens: '0',
    total_input_tokens: '0',
  })!;
  assert.equal(shareOf(empty, empty.parts[0]!), 0);
});

test('summing across turns skips the ones that reported nothing', () => {
  const summed = sumTokenWorking([REPORTED, UNREPORTED, SPLIT_EXCEEDS]);
  assert.equal(summed.reported, 2);
  assert.equal(summed.unreported, 1);
  assert.equal(summed.totalIn, 2994905 + 16044099);
  assert.equal(summed.output, 62884 + 56010);
  assert.equal(summed.parts.find((p) => p.key === 'input')!.tokens, 104 + 142);
});

test('summing nothing but unreported turns yields no parts and no false zero average', () => {
  const summed = sumTokenWorking([UNREPORTED]);
  assert.equal(summed.reported, 0);
  assert.equal(summed.unreported, 1);
  assert.deepEqual(summed.parts, []);
  assert.equal(summed.totalIn, 0);
});

test('a share too small to round is shown as small, not as none', () => {
  // 142 of 16,044,099 on turn 17550 — 0.00089%, which two decimals erases.
  assert.equal(formatShare((142 / 16044099) * 100), '<0.01%');
  assert.equal(formatShare(0), '0%');
  assert.equal(formatShare(0.5), '0.50%');
  assert.equal(formatShare(98.9), '99%');
});
