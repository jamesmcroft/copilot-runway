// Forward-only migration runner for the settings documents (issue #53).
//
// Each migration is a pure function (doc) => doc that takes the
// just-loaded document at version N and returns a document at version
// N+1. The runner walks the table from the on-disk version up to
// CURRENT_SCHEMA_VERSION, rewriting after every successful step.
//
// Versioning rules:
//   * If on-disk version === CURRENT_SCHEMA_VERSION: no-op.
//   * If on-disk version < CURRENT: apply migrations[onDisk], migrations[onDisk+1], ...
//     up to CURRENT. Re-run on the same version is idempotent (returns
//     { migrated: false }).
//   * If on-disk version > CURRENT: refuse to mutate. Caller treats the
//     document as read-only and logs a warning. We never downgrade.
//
// Missing schema_version is treated as 1 (the first shipped version) so
// hand-rolled or pre-versioned files do not get re-stamped as something
// they are not.

const { CURRENT_SCHEMA_VERSION } = require('./settings-schema');

// Migration table. Keys are the source version. migrations[N] takes a
// v=N document and returns a v=N+1 document. Identity stub at 1 keeps
// the runner exercisable even before any real migrations land.
const migrations = {
  // 1 -> 2: not yet defined. Leave this key absent so any future
  // upgrade lands here. v1 is the current schema.
};

function readVersion(doc) {
  if (!doc || typeof doc !== 'object') return CURRENT_SCHEMA_VERSION;
  const v = doc.schema_version;
  if (typeof v === 'number' && Number.isInteger(v) && v >= 1) return v;
  return CURRENT_SCHEMA_VERSION;
}

// Walk the migration table from the document's on-disk version up to
// CURRENT_SCHEMA_VERSION. Returns:
//   { migrated: bool, document, readOnly: bool, fromVersion, toVersion }
//
// migrated:  true when at least one migration ran.
// readOnly:  true when the on-disk version is newer than we know about.
// document:  the (possibly migrated) document. Always returned.
function migrateDocument(doc) {
  const fromVersion = readVersion(doc);
  if (fromVersion > CURRENT_SCHEMA_VERSION) {
    return {
      migrated: false,
      readOnly: true,
      document: doc,
      fromVersion,
      toVersion: fromVersion,
    };
  }
  if (fromVersion === CURRENT_SCHEMA_VERSION) {
    return {
      migrated: false,
      readOnly: false,
      document: doc,
      fromVersion,
      toVersion: fromVersion,
    };
  }
  let cur = doc;
  for (let v = fromVersion; v < CURRENT_SCHEMA_VERSION; v++) {
    const step = migrations[v];
    if (typeof step !== 'function') {
      // No migration registered for this hop. Bump the version stamp
      // and continue. This lets us reserve future version numbers
      // without forcing a no-op migration for every increment.
      cur = { ...cur, schema_version: v + 1 };
      continue;
    }
    cur = step(cur) || cur;
    cur = { ...cur, schema_version: v + 1 };
  }
  return {
    migrated: true,
    readOnly: false,
    document: cur,
    fromVersion,
    toVersion: CURRENT_SCHEMA_VERSION,
  };
}

module.exports = {
  migrations,
  migrateDocument,
  readVersion,
  CURRENT_SCHEMA_VERSION,
};
