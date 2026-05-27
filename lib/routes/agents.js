const express = require('express');
const { listAgents } = require('../cli/agents');

const router = express.Router();

// GET /api/agents - list available custom agents
router.get('/', async (req, res) => {
  const agents = await listAgents();
  res.json(agents);
});

module.exports = router;
