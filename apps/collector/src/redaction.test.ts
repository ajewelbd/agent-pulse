/**
 * Redaction regression tests.
 *
 * Every case here is a real leak found by running secrets through the shipped
 * pattern set, not a hypothetical. The marker SHOULDVANISH stands in for the
 * secret value: if it survives, a live credential would have survived too.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { DEFAULT_PATTERNS, Redactor } from '@aiuo/schema/redaction';

const r = new Redactor();

const MARKER = 'SHOULDVANISH';

/** Cases that leaked under redaction version 1. */
const REGRESSIONS: [name: string, input: string][] = [
  // `\S+` matched only the word "Bearer" and left the token behind. This is
  // the single most likely shape for a credential pasted into a prompt.
  ['auth header, bearer scheme', 'Authorization: Bearer SHOULDVANISH1234567890'],
  ['auth header, basic scheme', 'Authorization: Basic SHOULDVANISH1234567890'],
  ['proxy auth header', 'Proxy-Authorization: Bearer SHOULDVANISH1234567890'],
  ['x-auth-token with scheme', 'X-Auth-Token: Bearer SHOULDVANISH1234567890'],
  // JSON has a quote between the key and the colon, so neither the env nor
  // the header pattern matched — and JSON bodies are exactly what the proxy
  // stores for every request and response.
  ['json api_key', '{"api_key": "SHOULDVANISH-abcdef123456"}'],
  ['json authorization', '{"authorization": "Bearer SHOULDVANISH-abcdef"}'],
  ['json password', '{"password": "SHOULDVANISH-hunter22"}'],
  ['json access_token', '{"access_token":"SHOULDVANISH-abcdef123456"}'],
  ['single-quoted secret', "{'client_secret': 'SHOULDVANISH-abcdef'}"],
];

for (const [name, input] of REGRESSIONS) {
  test(`redacts ${name}`, () => {
    const out = r.redact(input);
    assert.ok(out !== null);
    assert.ok(
      !out.includes(MARKER),
      `secret survived redaction:\n  in:  ${input}\n  out: ${out}`,
    );
  });
}

/** Cases that already worked and must keep working. */
const STILL_COVERED: [name: string, input: string][] = [
  ['anthropic key', 'sk-ant-api03-SHOULDVANISH-abcdefghij'],
  ['openai key', 'sk-proj-SHOULDVANISHabcdefghijklmnop'],
  ['github token', 'ghp_SHOULDVANISHabcdefghijklmnop'],
  ['aws access key id', 'AKIASHOULDVANISH1234'],
  ['slack token', 'xoxb-SHOULDVANISH-abcdefghij'],
  ['env assignment', 'AWS_SECRET_ACCESS_KEY=SHOULDVANISH-abcdef123456'],
  ['yaml assignment', 'api_token: SHOULDVANISH-abcdef123456'],
  ['url credentials', 'postgres://user:SHOULDVANISH-pw@host:5432/db'],
];

for (const [name, input] of STILL_COVERED) {
  test(`still redacts ${name}`, () => {
    const out = r.redact(input);
    assert.ok(out !== null);
    assert.ok(!out.includes(MARKER), `secret survived redaction:\n  out: ${out}`);
  });
}

test('ordinary prose is left alone', () => {
  const input = 'The authorization flow failed because the token had expired.';
  assert.equal(r.redact(input), input);
});

test('a changed pattern set must not reuse a version number', () => {
  // The hash is what makes redaction_version an audit trail rather than a
  // label. If DEFAULT_PATTERNS changes, this assertion fails and the version
  // must be bumped — which is the whole point.
  const current = new Redactor(DEFAULT_PATTERNS);
  assert.equal(current.version, 2, 'version must be bumped whenever patterns change');
  assert.equal(current.patternCount, DEFAULT_PATTERNS.length);
});

test('disabled redaction writes version 0 and still strips NUL', () => {
  const off = new Redactor(DEFAULT_PATTERNS, true);
  assert.equal(off.version, 0);
  assert.equal(off.redact('a\u0000b'), 'ab');
});

test('redaction runs before capping, so a secret cannot be split in half', () => {
  const secret = `sk-ant-${'a'.repeat(60)}`;
  const { text } = r.redactAndCap(`${secret} ${'x'.repeat(500)}`, 200);
  assert.ok(text !== null);
  assert.ok(!text.includes('sk-ant-aaaa'));
});
