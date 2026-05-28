const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Isolate HOME so paths.js targets a throwaway directory. paths.js
// resolves HOME at require time so this must happen first.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'runway-settings-test-'));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;

const { SETTINGS_FILE, PROJECT_SETTINGS_FILE, LAUNCHERS_FILE } = require('../lib/paths');
const settings = require('../lib/runway/settings');
const schema = require('../lib/runway/settings-schema');

function reset() {
  for (const f of [SETTINGS_FILE, PROJECT_SETTINGS_FILE, LAUNCHERS_FILE]) {
    try { fs.unlinkSync(f); } catch {}
  }
  settings.invalidateCache();
}

const originalWarn = console.warn;
test.before(() => { console.warn = () => {}; });
test.after(() => { console.warn = originalWarn; });

test('defaults satisfy every descriptor when no file exists', () => {
  reset();
  const doc = settings.getGlobalSettings();
  assert.equal(doc.schema_version, schema.CURRENT_SCHEMA_VERSION);
  for (const d of schema.getDescriptors()) {
    assert.deepEqual(schema.getByPath(doc.values, d.key), d.default,
      `descriptor ${d.key} default should round-trip`);
  }
});

test('resolveSetting falls back to descriptor default with no file', () => {
  reset();
  assert.equal(settings.resolveSetting('launchers.vscode'), 'code');
  assert.equal(settings.resolveSetting('defaults.agent'), '');
});

test('patchGlobalSettings persists and reloads', () => {
  reset();
  const next = settings.patchGlobalSettings({ launchers: { vscode: 'code-insiders' } });
  assert.equal(next.values.launchers.vscode, 'code-insiders');
  settings.invalidateCache();
  assert.equal(settings.resolveSetting('launchers.vscode'), 'code-insiders');
});

test('patch leaves untouched fields alone', () => {
  reset();
  settings.patchGlobalSettings({ launchers: { vscode: 'cursor' } });
  settings.patchGlobalSettings({ defaults: { agent: 'demo-agent' } });
  settings.invalidateCache();
  assert.equal(settings.resolveSetting('launchers.vscode'), 'cursor');
  assert.equal(settings.resolveSetting('defaults.agent'), 'demo-agent');
});

test('put replaces wholesale but defaults backfill missing keys', () => {
  reset();
  settings.patchGlobalSettings({ launchers: { vscode: 'cursor' }, defaults: { agent: 'x' } });
  const next = settings.putGlobalSettings({
    schema_version: 1,
    values: { launchers: { vscode: 'code-insiders' } },
  });
  // launchers.vscode was set; defaults.agent reverts to schema default
  assert.equal(next.values.launchers.vscode, 'code-insiders');
  assert.equal(next.values.defaults.agent, '');
});

test('patch rejects invalid enum value', () => {
  reset();
  assert.throws(() => settings.patchGlobalSettings({ launchers: { vscode: 'sublime' } }),
    err => err.code === 'VALIDATION' && err.errors.some(e => e.key === 'launchers.vscode'));
});

test('per-project override beats global; orphan keys ignored', () => {
  reset();
  settings.patchGlobalSettings({ launchers: { vscode: 'code-insiders' } });
  const projKey = '/abs/path/to/sample-project';
  settings.patchProjectSettings(projKey, { launchers: { vscode: 'cursor' } });
  settings.invalidateCache();
  assert.equal(settings.resolveSetting('launchers.vscode', projKey), 'cursor');
  // Project that does not exist as a key is silently ignored
  assert.equal(settings.resolveSetting('launchers.vscode', '/nope'), 'code-insiders');
});

test('per-project rejects global-only keys', () => {
  reset();
  assert.throws(() => settings.patchProjectSettings('/abs/p', { worktrees: { root: '/tmp/x' } }),
    err => err.code === 'VALIDATION' && err.errors.some(e => e.key === 'worktrees.root'));
});

test('malformed JSON on disk falls back to defaults (no crash)', () => {
  reset();
  fs.writeFileSync(SETTINGS_FILE, '{ not json');
  const doc = settings.getGlobalSettings();
  assert.equal(doc.values.launchers.vscode, 'code');
});

test('non-object JSON on disk falls back to defaults', () => {
  reset();
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(['array']));
  const doc = settings.getGlobalSettings();
  assert.equal(doc.values.launchers.vscode, 'code');
});

test('legacy launchers.json folds into settings on first boot', () => {
  reset();
  fs.writeFileSync(LAUNCHERS_FILE, JSON.stringify({ vscode: 'codium' }));
  const doc = settings.getGlobalSettings();
  assert.equal(doc.values.launchers.vscode, 'codium');
  // settings.json should now exist as a result of the fold
  assert.ok(fs.existsSync(SETTINGS_FILE));
});

test('atomic write leaves no tmp file behind', () => {
  reset();
  settings.patchGlobalSettings({ launchers: { vscode: 'code' } });
  const leftover = fs.readdirSync(path.dirname(SETTINGS_FILE))
    .filter(f => f.startsWith('settings.json.') && f.endsWith('.tmp'));
  assert.deepEqual(leftover, []);
});

test('cache is invalidated by mutation', () => {
  reset();
  settings.getGlobalSettings();
  settings.patchGlobalSettings({ launchers: { vscode: 'code-insiders' } });
  // No invalidateCache call: the patch path should refresh the cache itself
  assert.equal(settings.resolveSetting('launchers.vscode'), 'code-insiders');
});

test('getSchemaDescriptors omits validate and exposes enum', () => {
  const out = settings.getSchemaDescriptors();
  assert.equal(out.schema_version, schema.CURRENT_SCHEMA_VERSION);
  const vscode = out.descriptors.find(d => d.key === 'launchers.vscode');
  assert.ok(vscode);
  assert.deepEqual(vscode.enum, ['code', 'code-insiders', 'cursor', 'codium']);
  assert.equal(typeof vscode.validate, 'undefined');
});

test('getProjectSettings returns empty overrides for unknown project', () => {
  reset();
  const out = settings.getProjectSettings('/unknown/path');
  assert.deepEqual(out.overrides, {});
});

test('newer-than-known global document is read-only', () => {
  reset();
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify({
    schema_version: 999,
    values: { launchers: { vscode: 'cursor' } },
  }));
  assert.equal(settings.resolveSetting('launchers.vscode'), 'cursor');
  assert.throws(
    () => settings.patchGlobalSettings({ launchers: { vscode: 'code' } }),
    err => err.code === 'READ_ONLY'
  );
});
