const Database = require('better-sqlite3');
const { SESSION_STORE_DB, DATA_DB } = require('../paths');

// Open databases read-only. Callers are responsible for closing.
function openSessionStoreDb() {
  return new Database(SESSION_STORE_DB, { readonly: true, fileMustExist: true });
}

function openDataDb() {
  return new Database(DATA_DB, { readonly: true, fileMustExist: true });
}

module.exports = { openSessionStoreDb, openDataDb };
