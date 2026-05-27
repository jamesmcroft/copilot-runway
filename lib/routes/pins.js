const express = require('express');
const { loadPins, pinSession, unpinSession } = require('../runway/pins');

const router = express.Router();

// GET /api/pins - return the current pin set
router.get('/', (req, res) => {
  try {
    res.json(loadPins());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/pins/sessions/:id - pin a session
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
