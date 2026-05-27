const test = require('node:test');
const assert = require('node:assert/strict');

const { isPathWithinProject } = require('../public/path-match');

test('equal paths match', () => {
  assert.equal(isPathWithinProject('C:\\src\\foo', 'C:\\src\\foo'), true);
  assert.equal(isPathWithinProject('/home/me/foo', '/home/me/foo'), true);
});

test('child directories match on both separators', () => {
  assert.equal(isPathWithinProject('C:\\src\\foo\\sub', 'C:\\src\\foo'), true);
  assert.equal(isPathWithinProject('C:\\src\\foo\\a\\b', 'C:\\src\\foo'), true);
  assert.equal(isPathWithinProject('/home/me/foo/sub', '/home/me/foo'), true);
});

test('trailing separator on the project path does not break matching', () => {
  assert.equal(isPathWithinProject('C:\\src\\foo\\sub', 'C:\\src\\foo\\'), true);
  assert.equal(isPathWithinProject('/home/me/foo/sub', '/home/me/foo/'), true);
});

test('sibling directories with a shared prefix do NOT match (issue #32 regression)', () => {
  assert.equal(isPathWithinProject('C:\\src\\foo-bar', 'C:\\src\\foo'), false);
  assert.equal(isPathWithinProject('C:\\src\\foo-bar\\sub', 'C:\\src\\foo'), false);
  assert.equal(isPathWithinProject('/home/me/foo-bar', '/home/me/foo'), false);
  assert.equal(isPathWithinProject('/home/me/foobar', '/home/me/foo'), false);
});

test('Windows path matching is case-insensitive', () => {
  assert.equal(isPathWithinProject('c:\\Src\\Foo\\Sub', 'C:\\src\\foo'), true);
  assert.equal(isPathWithinProject('C:\\SRC\\FOO', 'c:\\src\\foo'), true);
});

test('POSIX path matching is case-sensitive', () => {
  assert.equal(isPathWithinProject('/home/me/Foo', '/home/me/foo'), false);
});

test('empty or missing inputs return false', () => {
  assert.equal(isPathWithinProject('', 'C:\\src\\foo'), false);
  assert.equal(isPathWithinProject('C:\\src\\foo', ''), false);
  assert.equal(isPathWithinProject(null, 'C:\\src\\foo'), false);
  assert.equal(isPathWithinProject('C:\\src\\foo', undefined), false);
});

test('mixed separators on Windows-style paths still match', () => {
  // git sometimes returns POSIX-style paths even on Windows.
  assert.equal(isPathWithinProject('C:/src/foo/sub', 'C:\\src\\foo'), true);
  assert.equal(isPathWithinProject('C:\\src\\foo\\sub', 'C:/src/foo'), true);
});
