const express = require('express');
const fs = require('fs');

const { SESSION_STATE_DIR } = require('../paths');
const { openSessionStoreDb } = require('../store/db');
const { getSessionStatus } = require('../store/sessions');

const router = express.Router();

// GET /api/stats - dashboard stats
router.get('/', (req, res) => {
  try {
    const db = openSessionStoreDb();
    const totalSessions = db.prepare('SELECT COUNT(*) as count FROM sessions').get().count;
    const totalTurns = db.prepare('SELECT COUNT(*) as count FROM turns').get().count;
    const recentSessions = db.prepare(
      "SELECT COUNT(*) as count FROM sessions WHERE updated_at > datetime('now', '-7 days')"
    ).get().count;
    db.close();

    // Count active sessions
    let activeSessions = 0;
    try {
      const dirs = fs.readdirSync(SESSION_STATE_DIR, { withFileTypes: true });
      for (const dir of dirs) {
        if (!dir.isDirectory()) continue;
        const status = getSessionStatus(dir.name);
        if (status.status === 'active') activeSessions++;
      }
    } catch {}

    res.json({ totalSessions, totalTurns, recentSessions, activeSessions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
