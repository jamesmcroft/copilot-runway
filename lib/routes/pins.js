const express = require('express');
const { loadPins, pinSession, unpinSession, PinsCorruptError } = require('../runway/pins');

const router = express.Router();

// GET /api/pins - return the current pin set
//
// Corruption is non-fatal here: the UI still works against an empty set
// while the user resolves the on-disk file. Any other read error (e.g.
// EACCES) returns 500 so the user sees a real failure instead of pins
// silently appearing to vanish.
router.get('/', (req, res) => {
  try {
    res.json(loadPins());
  } catch (err) {
    if (err instanceof PinsCorruptError) {
      return res.json({ sessions: [] });
    }
    res.status(500).json({ error: err.message });
  }
});

// POST /api/pins/sessions/:id - pin a session
//
// Read errors (including corruption) propagate as 500 so we never
// overwrite an unreadable pins file with an empty document.
router.post('/sessions/:id', (req, res) => {
  const id = req.params.id;
  if (!id) return res.status(400).json({ error: 'session id is required' });
  try {
    res.json(pinSession(id));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/pins/sessions/:id - unpin a session
router.delete('/sessions/:id', (req, res) => {
  const id = req.params.id;
  if (!id) return res.status(400).json({ error: 'session id is required' });
  try {
    res.json(unpinSession(id));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
