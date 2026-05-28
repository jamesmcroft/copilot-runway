const path = require('path');
const fs = require('fs');

const HOME_DIR = process.env.HOME || process.env.USERPROFILE;
const COPILOT_DIR = path.join(HOME_DIR, '.copilot');
const RUNWAY_DIR = path.join(HOME_DIR, '.runway');

const SESSION_STORE_DB = path.join(COPILOT_DIR, 'session-store.db');
const DATA_DB = path.join(COPILOT_DIR, 'data.db');
const SESSION_STATE_DIR = path.join(COPILOT_DIR, 'session-state');

const CUSTOM_PROJECTS_FILE = path.join(RUNWAY_DIR, 'projects.json');
const SESSION_AGENTS_FILE = path.join(RUNWAY_DIR, 'session-agents.json');
const PINS_FILE = path.join(RUNWAY_DIR, 'pins.json');
const SETTINGS_FILE = path.join(RUNWAY_DIR, 'settings.json');
const PROJECT_SETTINGS_FILE = path.join(RUNWAY_DIR, 'project-settings.json');
const LAUNCHERS_FILE = path.join(RUNWAY_DIR, 'launchers.json');

// Ensure ~/.runway exists for Runway-owned config files
if (!fs.existsSync(RUNWAY_DIR)) {
  fs.mkdirSync(RUNWAY_DIR, { recursive: true });
}

module.exports = {
  HOME_DIR,
  COPILOT_DIR,
  RUNWAY_DIR,
  SESSION_STORE_DB,
  DATA_DB,
  SESSION_STATE_DIR,
  CUSTOM_PROJECTS_FILE,
  SESSION_AGENTS_FILE,
  PINS_FILE,
  SETTINGS_FILE,
  PROJECT_SETTINGS_FILE,
  LAUNCHERS_FILE,
};
