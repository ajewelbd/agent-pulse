"use strict";
/**
 * What a token count is made of.
 *
 * `turns.total_input_tokens` is a generated column — migration 004 defines it
 * as `coalesce(input_tokens,0) + coalesce(cache_read_tokens,0) +
 * coalesce(cache_write_tokens,0)` — so the three parts always reconstruct it
 * exactly. Verified across all 474 turns in this archive on 2026-09-23: zero
 * rows where the sum differs.
 *
 * Two things that column's `coalesce` hides, and that this module exists to
 * surface:
 *
 *   1. A turn whose usage was never reported has NULL in every token column,
 *      and the generated column turns that into **0**. All 16 such turns here
 *      render "0 in" today, which is the one thing the schema's own invariant
 *      forbids: absence is not zero. `tokenWorking()` returns null for them
 *      and `tokenCount()` renders "—".
 *   2. The 5m/1h cache-write buckets are reported separately from the
 *      cache-write total, and they do not always agree. Two turns here (17550
 *      and 8610) report MORE in the buckets than in the total — by 1,135 and
 *      2,890 tokens. Both figures are the provider's; neither is this
 *      system's arithmetic. `writeSplit.exceedsTotal` says so rather than
 *      letting a reader assume one of the numbers is wrong.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.tokenWorking = tokenWorking;
exports.sumTokenParts = sumTokenParts;
exports.shareOf = shareOf;
exports.formatShare = formatShare;
exports.sumTokenWorking = sumTokenWorking;
function n(value) {
    if (value === null || value === undefined || value === '')
        return null;
    const parsed = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}
/**
 * The parts behind a turn's token counts.
 *
 * Returns null when no usage was reported for the turn — there is nothing to
 * break down, and a breakdown of zeroes would assert that the turn used no
 * tokens, which is not what "unknown" means.
 */
function tokenWorking(row) {
    if (!row || row.token_source === 'unknown')
        return null;
    const input = n(row.input_tokens) ?? 0;
    const cacheRead = n(row.cache_read_tokens) ?? 0;
    const cacheWrite = n(row.cache_write_tokens) ?? 0;
    const m5 = n(row.cache_write_5m_tokens);
    const h1 = n(row.cache_write_1h_tokens);
    const parts = [
        {
            key: 'input',
            label: 'Input (uncached)',
            tokens: input,
            what: 'sent and read fresh — the only part that is neither served from nor written to cache',
        },
        {
            key: 'cache_read',
            label: 'Cache read',
            tokens: cacheRead,
            what: 'served from a warm prompt cache, at a fraction of the input rate',
        },
        {
            key: 'cache_write',
            label: 'Cache write',
            tokens: cacheWrite,
            what: 'written into the cache this turn, charged at a premium over input',
        },
    ];
    const splitSum = (m5 ?? 0) + (h1 ?? 0);
    const writeSplit = m5 === null && h1 === null
        ? null
        : { m5: m5 ?? 0, h1: h1 ?? 0, sum: splitSum, exceedsTotal: splitSum > cacheWrite };
    return {
        parts,
        totalIn: input + cacheRead + cacheWrite,
        output: n(row.output_tokens),
        writeSplit,
    };
}
/** Sum of the parts a caller cares about, for a bar segment or a subtotal. */
function sumTokenParts(working, keys) {
    return working.parts.reduce((sum, p) => (keys.includes(p.key) ? sum + p.tokens : sum), 0);
}
/** Each part's share of the input total, for the composition bar. */
function shareOf(working, part) {
    return working.totalIn > 0 ? (part.tokens / working.totalIn) * 100 : 0;
}
/**
 * A percentage that never rounds a real quantity down to nothing.
 *
 * Uncached input is routinely under a thousandth of the total — 142 of
 * 16,044,099 on turn 17550 — and two decimal places renders that as "0.00%",
 * which reads as "none". Same rule as everywhere else here: a small number is
 * not zero.
 */
function formatShare(share) {
    if (share === 0)
        return '0%';
    if (share < 0.01)
        return '<0.01%';
    if (share < 1)
        return `${share.toFixed(2)}%`;
    return `${Math.round(share)}%`;
}
/**
 * Add up the token parts across many turns, skipping the ones with no reported
 * usage — a turn that reported nothing must not pull an average down as if it
 * had reported zero.
 */
function sumTokenWorking(rows) {
    const totals = new Map();
    let output = 0;
    let reported = 0;
    let unreported = 0;
    let template = [];
    for (const row of rows) {
        const working = tokenWorking(row);
        if (working === null) {
            unreported += 1;
            continue;
        }
        reported += 1;
        template = working.parts;
        for (const part of working.parts) {
            totals.set(part.key, (totals.get(part.key) ?? 0) + part.tokens);
        }
        output += working.output ?? 0;
    }
    const parts = template.map((p) => ({ ...p, tokens: totals.get(p.key) ?? 0 }));
    return {
        parts,
        totalIn: parts.reduce((sum, p) => sum + p.tokens, 0),
        output,
        reported,
        unreported,
    };
}
