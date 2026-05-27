const fs = require('fs');
const { RUNWAY_DIR, PINS_FILE } = require('../paths');

// Server-side pin storage at ~/.runway/pins.json.
//
// Schema (forward-compatible, additional top-level keys are tolerated):
//   { "sessions": ["<session-id>", ...] }
//
// A missing file, malformed JSON, or missing/typed-wrong "sessions" key
// all degrade to an empty pin set rather than throwing. Writes go through
// a temp file plus rename so a mid-write crash cannot corrupt the file.
//
// Concurrency: Runway is a single local process so the read-modify-write
// in {pin,unpin}Session is safe. Callers from other processes would need
// external locking; that is out of scope for this dashboard.

function loadPins() {
  try {
    const data = JSON.parse(fs.readFileSync(PINS_FILE, 'utf8'));
    return {
      sessions: Array.isArray(data && data.sessions)
        ? data.sessions.filter(x => typeof x === 'string')
        : [],
    };
  } catch {
    return { sessions: [] };
  }
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

module.exports = { loadPins, savePins, pinSession, unpinSession };
