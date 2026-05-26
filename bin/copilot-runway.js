#!/usr/bin/env node

// Copilot Runway CLI entry point
// Sets cwd to the package root so Express can find public/ and node_modules/

const path = require('path');
process.chdir(path.join(__dirname, '..'));

require('../server.js');
