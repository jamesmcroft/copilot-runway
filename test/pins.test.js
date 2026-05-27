const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Isolate the pins file under a temp HOME so we do not stomp on a real
// ~/.runway/pins.json while running tests. paths.js resolves HOME_DIR at
// require time, so we must set the env var before any module loads.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'runway-pins-test-'));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;

const { PINS_FILE } = require('../lib/paths');
const {
  loadPins,
  savePins,
  pinSession,
  unpinSession,
  PinsCorruptError,
} = require('../lib/runway/pins');

function resetPinsFile() {
  try { fs.unlinkSync(PINS_FILE); } catch {}
}

// Suppress expected console.error noise from the negative-path tests so
// test output stays readable. Restored after the suite.
const originalConsoleError = console.error;
test.before(() => { console.error = () => {}; });
test.after(() => { console.error = originalConsoleError; });

test('loadPins returns empty when file is missing', () => {
  resetPinsFile();
  assert.deepEqual(loadPins(), { sessions: [] });
});

test('loadPins throws PinsCorruptError when file is malformed JSON', () => {
  resetPinsFile();
  fs.writeFileSync(PINS_FILE, '{ not json');
  assert.throws(() => loadPins(), PinsCorruptError);
});

test('loadPins throws PinsCorruptError when file is not a JSON object', () => {
  resetPinsFile();
  fs.writeFileSync(PINS_FILE, JSON.stringify(['a', 'b']));
  assert.throws(() => loadPins(), PinsCorruptError);
});

test('loadPins tolerates missing sessions key (forward-compatible)', () => {
  resetPinsFile();
  fs.writeFileSync(PINS_FILE, JSON.stringify({ unrelated: 'value' }));
  assert.deepEqual(loadPins(), { sessions: [] });
});

test('pinSession does NOT clobber a malformed pins file', () => {
  // Regression: previously loadPins swallowed parse errors and returned
  // empty, so the next savePins would overwrite the user's real pins
  // (or an unreadable file) with `{ "sessions": [] }`. The contract is
  // now: refuse to write until the user fixes the file.
  resetPinsFile();
  const malformed = '{ not json';
  fs.writeFileSync(PINS_FILE, malformed);
  assert.throws(() => pinSession('abc'), PinsCorruptError);
  assert.equal(fs.readFileSync(PINS_FILE, 'utf8'), malformed);
});

test('unpinSession does NOT clobber a malformed pins file', () => {
  resetPinsFile();
  const malformed = 'totally not json at all';
  fs.writeFileSync(PINS_FILE, malformed);
  assert.throws(() => unpinSession('abc'), PinsCorruptError);
  assert.equal(fs.readFileSync(PINS_FILE, 'utf8'), malformed);
});

test('pinSession persists and deduplicates', () => {
  resetPinsFile();
  pinSession('abc');
  pinSession('def');
  pinSession('abc'); // duplicate is a no-op
  const pins = loadPins();
  assert.deepEqual(pins.sessions.sort(), ['abc', 'def']);
});

test('unpinSession removes the given id', () => {
  resetPinsFile();
  pinSession('a'); pinSession('b'); pinSession('c');
  unpinSession('b');
  assert.deepEqual(loadPins().sessions.sort(), ['a', 'c']);
});

test('savePins drops non-string entries', () => {
  resetPinsFile();
  savePins({ sessions: ['a', 42, null, 'b', undefined] });
  assert.deepEqual(loadPins().sessions.sort(), ['a', 'b']);
});

test('savePins is atomic (no leftover tmp file on success)', () => {
  resetPinsFile();
  pinSession('xyz');
  const files = fs.readdirSync(path.dirname(PINS_FILE));
  const leftover = files.filter(f => f.startsWith('pins.json.') && f.endsWith('.tmp'));
  assert.deepEqual(leftover, []);
});
