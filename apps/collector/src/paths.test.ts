/**
 * Path translation tests. Run with: node --test (after tsc)
 *
 * These cover the cases that actually bite on this machine: a host root with
 * spaces in it, prefix collisions on segment boundaries, and the round trip
 * that outbound translation depends on.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { PathMapError, PathMapper } from './paths.js';

const REAL = '/Volumes/Macintosh HD 1/Projects/Atom:/host/code/root1';

test('parses a host prefix containing spaces', () => {
  const m = PathMapper.parse(REAL);
  assert.equal(m.entries[0]!.hostPrefix, '/Volumes/Macintosh HD 1/Projects/Atom');
  assert.equal(m.entries[0]!.containerPrefix, '/host/code/root1');
});

test('splits on the last colon, not the first', () => {
  // A Windows-style host path would otherwise split at the drive colon.
  const m = PathMapper.parse('/c:/Users/x:/host/code/w');
  assert.equal(m.entries[0]!.hostPrefix, '/c:/Users/x');
  assert.equal(m.entries[0]!.containerPrefix, '/host/code/w');
});

test('inbound: host → container', () => {
  const m = PathMapper.parse(REAL);
  assert.equal(
    m.toContainer('/Volumes/Macintosh HD 1/Projects/Atom/atom-otp-service/app/x.ts'),
    '/host/code/root1/atom-otp-service/app/x.ts',
  );
});

test('outbound: container → host', () => {
  const m = PathMapper.parse(REAL);
  assert.equal(
    m.toHost('/host/code/root1/atom-otp-service/app/x.ts'),
    '/Volumes/Macintosh HD 1/Projects/Atom/atom-otp-service/app/x.ts',
  );
});

test('round trip is lossless', () => {
  const m = PathMapper.parse(REAL);
  const host = '/Volumes/Macintosh HD 1/Projects/Atom/fnf-microservice/README.md';
  assert.equal(m.toHost(m.toContainer(host)), host);
});

test('the prefix itself maps with no trailing slash', () => {
  const m = PathMapper.parse(REAL);
  assert.equal(m.toContainer('/Volumes/Macintosh HD 1/Projects/Atom'), '/host/code/root1');
  assert.equal(m.toHost('/host/code/root1'), '/Volumes/Macintosh HD 1/Projects/Atom');
});

test('matches only on segment boundaries', () => {
  // '/host/code/root10' must NOT match the prefix '/host/code/root1'.
  const m = PathMapper.parse('/a/b:/host/code/root1');
  assert.throws(() => m.toHost('/host/code/root10/x'), PathMapError);
});

test('first matching entry wins, in declared order', () => {
  const m = PathMapper.parse('/a/b/inner:/host/code/inner,/a/c:/host/code/outer');
  assert.equal(m.toContainer('/a/b/inner/f'), '/host/code/inner/f');
  assert.equal(m.toContainer('/a/c/f'), '/host/code/outer/f');
});

test('refuses a config where one entry shadows another', () => {
  // '/a' would swallow '/a/b', leaving the second mapping dead.
  assert.throws(
    () => PathMapper.parse('/a:/host/code/a,/a/b:/host/code/b'),
    /shadowed by entry 1/,
  );
});

test('refuses shadowed container prefixes too', () => {
  assert.throws(
    () => PathMapper.parse('/a:/host/code,/b:/host/code/b'),
    /container prefix/,
  );
});

test('unmapped paths throw rather than being stored raw', () => {
  const m = PathMapper.parse(REAL);
  assert.throws(() => m.toContainer('/somewhere/else'), PathMapError);
  assert.throws(() => m.toHost('/host/code/unmapped/x'), PathMapError);
});

test('toHostIfMapped passes unmapped paths through', () => {
  const m = PathMapper.parse(REAL);
  // An agent invoked outside any code root still has a real cwd worth keeping.
  assert.equal(m.toHostIfMapped('/tmp/scratch'), '/tmp/scratch');
});

test('rejects relative and malformed entries', () => {
  assert.throws(() => PathMapper.parse('relative/path:/host/code/a'), PathMapError);
  assert.throws(() => PathMapper.parse('/a/b'), PathMapError);
  assert.throws(() => PathMapper.parse(''), PathMapError);
});

test('assertHostPath catches a container path before insert', () => {
  assert.throws(
    () => PathMapper.assertHostPath('/host/code/root1/x', 'projects.path'),
    /Refusing to store container path/,
  );
  assert.doesNotThrow(() => PathMapper.assertHostPath('/Users/me/repo', 'projects.path'));
});
