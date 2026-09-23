"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const strict_1 = __importDefault(require("node:assert/strict"));
const node_test_1 = require("node:test");
const tokens_js_1 = require("./tokens.js");
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
(0, node_test_1.test)('the parts reconstruct the generated total_input_tokens exactly', () => {
    const working = (0, tokens_js_1.tokenWorking)(REPORTED);
    strict_1.default.ok(working);
    strict_1.default.deepEqual(working.parts.map((p) => p.key), ['input', 'cache_read', 'cache_write']);
    // This is migration 004's generated column, recomputed: coalesce(input,0)
    // + coalesce(cache_read,0) + coalesce(cache_write,0).
    strict_1.default.equal(working.totalIn, Number(REPORTED.total_input_tokens));
    strict_1.default.equal(working.output, 62884);
});
/**
 * The whole reason this module exists. `total_input_tokens` is generated with
 * `coalesce(…, 0)`, so an unreported turn arrives as a real 0 and no
 * null-check can catch it — `token_source` is the only signal.
 */
(0, node_test_1.test)('a turn that reported no usage has no breakdown, rather than a breakdown of zeroes', () => {
    strict_1.default.equal((0, tokens_js_1.tokenWorking)(UNREPORTED), null);
    strict_1.default.equal((0, tokens_js_1.tokenWorking)(null), null);
    // And the trap it guards: the raw column really does say zero.
    strict_1.default.equal(Number(UNREPORTED.total_input_tokens), 0);
});
/**
 * Turns 17550 and 8610 report more in the 5m/1h buckets than in the
 * cache-write total — by 1,135 and 2,890 tokens. Both figures are the
 * provider's own, accumulated over the turn's assistant messages, so neither
 * is corrected here; the disagreement is surfaced instead.
 */
(0, node_test_1.test)('cache-write buckets that exceed their own total are flagged, not silently fixed', () => {
    const working = (0, tokens_js_1.tokenWorking)(SPLIT_EXCEEDS);
    strict_1.default.ok(working?.writeSplit);
    strict_1.default.equal(working.writeSplit.sum, 167013);
    strict_1.default.equal(working.writeSplit.exceedsTotal, true);
    // The total still uses the reported cache-write total, unchanged.
    strict_1.default.equal((0, tokens_js_1.sumTokenParts)(working, ['cache_write']), 165878);
    strict_1.default.equal(working.totalIn, Number(SPLIT_EXCEEDS.total_input_tokens));
});
(0, node_test_1.test)('buckets that fit inside their total are not flagged', () => {
    const working = (0, tokens_js_1.tokenWorking)(REPORTED);
    strict_1.default.equal(working?.writeSplit?.exceedsTotal, false);
});
(0, node_test_1.test)('shares are of the input total, and a zero total does not divide by zero', () => {
    const working = (0, tokens_js_1.tokenWorking)(REPORTED);
    const cacheRead = working.parts.find((p) => p.key === 'cache_read');
    strict_1.default.equal((0, tokens_js_1.shareOf)(working, cacheRead), (2797500 / 2994905) * 100);
    const empty = (0, tokens_js_1.tokenWorking)({
        ...REPORTED,
        input_tokens: '0',
        cache_read_tokens: '0',
        cache_write_tokens: '0',
        total_input_tokens: '0',
    });
    strict_1.default.equal((0, tokens_js_1.shareOf)(empty, empty.parts[0]), 0);
});
(0, node_test_1.test)('summing across turns skips the ones that reported nothing', () => {
    const summed = (0, tokens_js_1.sumTokenWorking)([REPORTED, UNREPORTED, SPLIT_EXCEEDS]);
    strict_1.default.equal(summed.reported, 2);
    strict_1.default.equal(summed.unreported, 1);
    strict_1.default.equal(summed.totalIn, 2994905 + 16044099);
    strict_1.default.equal(summed.output, 62884 + 56010);
    strict_1.default.equal(summed.parts.find((p) => p.key === 'input').tokens, 104 + 142);
});
(0, node_test_1.test)('summing nothing but unreported turns yields no parts and no false zero average', () => {
    const summed = (0, tokens_js_1.sumTokenWorking)([UNREPORTED]);
    strict_1.default.equal(summed.reported, 0);
    strict_1.default.equal(summed.unreported, 1);
    strict_1.default.deepEqual(summed.parts, []);
    strict_1.default.equal(summed.totalIn, 0);
});
(0, node_test_1.test)('a share too small to round is shown as small, not as none', () => {
    // 142 of 16,044,099 on turn 17550 — 0.00089%, which two decimals erases.
    strict_1.default.equal((0, tokens_js_1.formatShare)((142 / 16044099) * 100), '<0.01%');
    strict_1.default.equal((0, tokens_js_1.formatShare)(0), '0%');
    strict_1.default.equal((0, tokens_js_1.formatShare)(0.5), '0.50%');
    strict_1.default.equal((0, tokens_js_1.formatShare)(98.9), '99%');
});
