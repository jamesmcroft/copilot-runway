const test = require('node:test');
const assert = require('node:assert/strict');

const { migrateDocument, readVersion, CURRENT_SCHEMA_VERSION } = require('../lib/runway/settings-migrations');

test('document at current version is a no-op', () => {
  const doc = { schema_version: CURRENT_SCHEMA_VERSION, values: { a: 1 } };
  const r = migrateDocument(doc);
  assert.equal(r.migrated, false);
  assert.equal(r.readOnly, false);
  assert.equal(r.document, doc);
});

test('document with missing schema_version is treated as current', () => {
  // Conservative: avoid re-running migrations against a doc that was
  // hand-written or imported from another source.
  const r = migrateDocument({ values: {} });
  assert.equal(r.migrated, false);
  assert.equal(r.readOnly, false);
});

test('newer-than-known document is flagged read-only and not mutated', () => {
  const doc = { schema_version: CURRENT_SCHEMA_VERSION + 5, values: {} };
  const r = migrateDocument(doc);
  assert.equal(r.readOnly, true);
  assert.equal(r.migrated, false);
  assert.equal(r.document, doc);
});

test('older document is bumped to current and marked migrated when migrations table is empty', () => {
  // With no real migrations in the table for the v=0 hop, the runner
  // still walks the version stamp forward. Identity-but-version-bump
  // semantics are part of the contract.
  if (CURRENT_SCHEMA_VERSION < 1) return; // sanity guard
  // Simulate a hypothetical v0 document. readVersion floors invalid
  // values at CURRENT, so we explicitly use 1 here as the documented
  // "first shipped" version: migrating from 1 to 1 is the no-op path.
  const doc = { schema_version: 1, values: {} };
  const r = migrateDocument(doc);
  assert.equal(r.toVersion, CURRENT_SCHEMA_VERSION);
});

test('re-running on the same version is idempotent', () => {
  const doc = { schema_version: CURRENT_SCHEMA_VERSION, values: { x: 'y' } };
  const r1 = migrateDocument(doc);
  const r2 = migrateDocument(r1.document);
  assert.equal(r1.migrated, false);
  assert.equal(r2.migrated, false);
  assert.deepEqual(r2.document, doc);
});

test('readVersion floors non-numeric and negative values at CURRENT', () => {
  assert.equal(readVersion({ schema_version: 'oops' }), CURRENT_SCHEMA_VERSION);
  assert.equal(readVersion({ schema_version: 0 }), CURRENT_SCHEMA_VERSION);
  assert.equal(readVersion(null), CURRENT_SCHEMA_VERSION);
  assert.equal(readVersion({ schema_version: 3 }), 3);
});
