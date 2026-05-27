const fs = require('fs');
const { RUNWAY_DIR, PINS_FILE } = require('../paths');

// Server-side pin storage at ~/.runway/pins.json.
//
// Schema (forward-compatible, additional top-level keys are tolerated):
//   { "sessions": ["<session-id>", ...] }
//
// Read error policy:
//   * ENOENT (file missing) is a normal first-run state; loadPins returns
//     an empty set silently so writes can proceed.
//   * Malformed JSON throws PinsCorruptError. Callers that need to remain
//     responsive (the GET endpoint) catch this and return an empty set
//     for display, but writers (pin / unpin) propagate it so the corrupt
//     file is never overwritten with an empty document and the user's
//     real pins are preserved on disk until they resolve the corruption.
//   * Any other filesystem error (EACCES, EISDIR, ...) is logged and
//     re-thrown so callers can surface a 5xx instead of silently masking
//     a problem and then clobbering the file on the next write.
//
// Writes go through a temp file plus rename so a mid-write crash cannot
// corrupt the file.
//
// Concurrency: Runway is a single local process so the read-modify-write
// in {pin,unpin}Session is safe. Callers from other processes would need
// external locking; that is out of scope for this dashboard.

class PinsCorruptError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'PinsCorruptError';
    if (cause) this.cause = cause;
  }
}

function loadPins() {
  let raw;
  try {
    raw = fs.readFileSync(PINS_FILE, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return { sessions: [] };
    }
    console.error(`[runway] failed to read pins file at ${PINS_FILE}: ${err.message}`);
    throw err;
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    console.error(`[runway] pins file at ${PINS_FILE} is not valid JSON: ${err.message}`);
    throw new PinsCorruptError(
      `pins file at ${PINS_FILE} is not valid JSON`,
      err
    );
  }

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    console.error(`[runway] pins file at ${PINS_FILE} does not contain a JSON object`);
    throw new PinsCorruptError(
      `pins file at ${PINS_FILE} does not contain a JSON object`
    );
  }

  return {
    sessions: Array.isArray(data.sessions)
      ? data.sessions.filter(x => typeof x === 'string')
      : [],
  };
}

function savePins(pins) {
  const normalized = {
    sessions: Array.isArray(pins && pins.sessions)
      ? Array.from(new Set(pins.sessions.filter(x => typeof x === 'string')))
      : [],
  };
  if (!fs.existsSync(RUNWAY_DIR)) fs.mkdirSync(RUNWAY_DIR, { recursive: true });
  const tmp = `${PINS_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(normalized, null, 2));
  fs.renameSync(tmp, PINS_FILE);
  return normalized;
}

function pinSession(sessionId) {
  const pins = loadPins();
  if (!pins.sessions.includes(sessionId)) pins.sessions.push(sessionId);
  return savePins(pins);
}

function unpinSession(sessionId) {
  const pins = loadPins();
  pins.sessions = pins.sessions.filter(x => x !== sessionId);
  return savePins(pins);
}

module.exports = { loadPins, savePins, pinSession, unpinSession, PinsCorruptError };
