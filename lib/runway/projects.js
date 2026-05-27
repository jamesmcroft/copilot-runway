const fs = require('fs');
const { CUSTOM_PROJECTS_FILE } = require('../paths');

// Custom projects storage (Runway-owned, dashboard-added folders)
function loadCustomProjects() {
  try {
    return JSON.parse(fs.readFileSync(CUSTOM_PROJECTS_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function saveCustomProjects(projects) {
  fs.writeFileSync(CUSTOM_PROJECTS_FILE, JSON.stringify(projects, null, 2));
}

module.exports = { loadCustomProjects, saveCustomProjects };
