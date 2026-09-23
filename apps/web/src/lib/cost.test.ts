import assert from 'node:assert/strict';
import { test } from 'node:test';
import { costExact, costWorking, rate, rateWindow, reconcile, sumParts } from './cost.js';

/**
 * These exist because this module is a second implementation of the
 * collector's `computeCost()`, and a breakdown that does not reproduce the
 * stored cost is worse than no breakdown — it shows arithmetic the reader can
 * check, and gets it wrong.
 *
 * Run over every priced turn in this archive on 2026-09-23: all 457 reconcile,
 * largest absolute difference 1.4e-14 against a 1e-8 tolerance.
 */

/** Turn 8420 as stored, verbatim. Strings, because that is what pg returns. */
const TURN_8420 = {
  input_tokens: '104',
  output_tokens: '62884',
  cache_read_tokens: '2797500',
  cache_write_tokens: '197301',
  cache_write_5m_tokens: '0',
  cache_write_1h_tokens: '197301',
  input_usd_per_mtok: '5.000000',
  output_usd_per_mtok: '25.000000',
  cache_read_usd_per_mtok: '0.500000',
  cache_write_5m_usd_per_mtok: '6.250000',
  cache_write_1h_usd_per_mtok: '10.000000',
};

test('the working reproduces a real stored cost', () => {
  const working = costWorking(TURN_8420);
  assert.ok(working);
  const check = reconcile(working, '4.94438000');
  assert.ok(check?.matches, `off by ${check?.difference}`);

  // Each line is tokens × rate ÷ 1e6, and every line is present even at zero —
  // "no cache-write-5m tokens" is a fact worth showing, not a row to hide.
  assert.deepEqual(
    working.parts.map((p) => p.key),
    ['input', 'cache_read', 'cache_write_5m', 'cache_write_1h', 'output'],
  );
  assert.equal(working.parts[0]!.usd, (104 / 1e6) * 5);
  assert.equal(working.parts[4]!.usd, (62884 / 1e6) * 25);
});

/**
 * The rule the collector applies, and the one the old SQL breakdown did not:
 * `perMillion` returns 0 for a NULL rate. The superseded query coalesced a
 * NULL cache-read rate to the input rate, which would have shown a charge the
 * turn was never billed.
 */
test('a NULL rate contributes nothing and does not fall back to the input rate', () => {
  const working = costWorking({
    ...TURN_8420,
    cache_read_usd_per_mtok: null,
  });
  assert.ok(working);
  const cacheRead = working.parts.find((p) => p.key === 'cache_read')!;
  assert.equal(cacheRead.usd, 0);
  assert.equal(cacheRead.rate, null);
  // 2.8M cache-read tokens at the input rate would have added $13.99.
  assert.equal(working.total, costWorking(TURN_8420)!.total - (2797500 / 1e6) * 0.5);
});

test('cache writes the provider did not bucket are billed at the 5m rate', () => {
  const working = costWorking({
    ...TURN_8420,
    cache_write_tokens: '300000',
    cache_write_5m_tokens: '100000',
    cache_write_1h_tokens: '50000',
  });
  assert.ok(working);
  const unsplit = working.parts.find((p) => p.key === 'cache_write_unsplit');
  assert.ok(unsplit, 'the unbucketed remainder must be its own line');
  assert.equal(unsplit.tokens, 150000);
  assert.equal(unsplit.usd, (150000 / 1e6) * 6.25);
});

test('a token count below the reported buckets never produces a negative line', () => {
  const working = costWorking({
    ...TURN_8420,
    cache_write_tokens: '0',
    cache_write_5m_tokens: '100',
    cache_write_1h_tokens: '100',
  });
  assert.ok(working);
  assert.equal(
    working.parts.find((p) => p.key === 'cache_write_unsplit'),
    undefined,
  );
});

test('a turn with no rate row has no working, rather than a working of zeroes', () => {
  assert.equal(costWorking(null), null);
  assert.equal(
    costWorking({
      ...TURN_8420,
      input_usd_per_mtok: null,
      output_usd_per_mtok: null,
    }),
    null,
  );
});

test('reconcile reports a drift rather than hiding it', () => {
  const working = costWorking(TURN_8420)!;
  const check = reconcile(working, '9.99999999');
  assert.equal(check?.matches, false);
  assert.ok(Math.abs(check!.difference) > 1);
});

test('reconcile has nothing to say about an unpriced turn', () => {
  assert.equal(reconcile(costWorking(TURN_8420), null), null);
  assert.equal(reconcile(null, '1.00'), null);
});

test('bar segments sum the lines they cover', () => {
  const working = costWorking(TURN_8420)!;
  assert.equal(
    sumParts(working, ['cache_write_5m', 'cache_write_1h', 'cache_write_unsplit']),
    (197301 / 1e6) * 10,
  );
  assert.equal(sumParts(working, []), 0);
});

/**
 * Every seeded rate row in this database starts at the Unix epoch, which means
 * "always" and not "1 January 1970" — printing the date read as a recorded
 * fact that does not exist.
 */
test('an epoch start is reported as no start date, not as 1970', () => {
  assert.equal(
    rateWindow(new Date(0), null),
    'with no start or end date recorded, so it applies to every turn on this model',
  );
  assert.equal(rateWindow(null, null), 'with no start or end date recorded, so it applies to every turn on this model');
  assert.equal(rateWindow('2026-09-11T00:00:00Z', null), 'in force from 2026-09-11');
  assert.equal(
    rateWindow('2026-09-11T00:00:00Z', '2026-10-01T00:00:00Z'),
    'in force 2026-09-11 to 2026-10-01',
  );
});

test('the working formats to enough precision to be checked by eye', () => {
  // cost() collapses this to "<$0.01"; a column of those would not add up.
  assert.equal(costExact(0.00052), '$0.000520');
  assert.equal(costExact(4.94438), '$4.9444');
  assert.equal(costExact(0), '$0');
  assert.equal(rate(null), 'not priced');
  assert.equal(rate(5), '$5.00 / Mtok');
});
