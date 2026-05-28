// REST endpoints for the settings surface (issue #53).
//
//   GET    /api/settings                          -> { schema_version, values }
//   PATCH  /api/settings                          -> partial update; merge then validate
//   PUT    /api/settings                          -> whole-document replace; validated
//   GET    /api/settings/projects/:projectKey     -> { schema_version, overrides }
//   PATCH  /api/settings/projects/:projectKey     -> partial update
//   PUT    /api/settings/projects/:projectKey     -> whole-document replace
//   GET    /api/settings/schema                   -> descriptors generated from constants
//
// projectKey is URL-encoded by the client (it is a raw absolute path).
// Express decodes req.params for us, so we get the literal path back.
//
// Validation errors return 400 with a structured body:
//   { error: 'validation', errors: [{ key, message }, ...] }
// so the client can render inline per-field hints AND a top-of-page
// summary without doing a second round-trip.

const express = require('express');
const settings = require('../runway/settings');

const router = express.Router();

function sendValidationError(res, err) {
  if (err && err.code === 'VALIDATION') {
    return res.status(400).json({ error: 'validation', errors: err.errors || [] });
  }
  if (err && err.code === 'READ_ONLY') {
    return res.status(409).json({ error: 'read-only', message: err.message });
  }
  console.error(`[runway] settings request failed: ${err && err.message}`);
  return res.status(500).json({ error: 'internal', message: (err && err.message) || 'failed' });
}

// Schema must be registered before the catch-all GET /:projectKey could
// shadow it. Mounting at /schema explicitly here keeps the precedence
// obvious regardless of Express version quirks.
router.get('/schema', (req, res) => {
  try {
    res.json(settings.getSchemaDescriptors());
  } catch (err) {
    sendValidationError(res, err);
  }
});

// Resolved view of every setting, applying global then per-project
// override. Optional ?project=<absolute path> narrows the resolution.
// The client uses this to pre-select the default agent in the
// new-session and chat-agent dropdowns without duplicating the merge
// logic in JavaScript (issue #53 iteration 3).
router.get('/resolved', (req, res) => {
  try {
    const raw = req.query.project;
    const projectKey = typeof raw === 'string' && raw.length > 0 ? raw : null;
    res.json(settings.getResolvedValues(projectKey));
  } catch (err) {
    sendValidationError(res, err);
  }
});

router.get('/', (req, res) => {
  try {
    res.json(settings.getGlobalSettings());
  } catch (err) {
    sendValidationError(res, err);
  }
});

router.patch('/', (req, res) => {
  try {
    const body = req.body || {};
    // Accept either a bare values map ({ launchers: { vscode: ... } })
    // or a wrapped document ({ values: { ... } }). The wrapped form
    // mirrors the GET shape so the client can round-trip without
    // unwrapping.
    const patch = (body.values && typeof body.values === 'object') ? body.values : body;
    const next = settings.patchGlobalSettings(patch);
    res.json(next);
  } catch (err) {
    sendValidationError(res, err);
  }
});

router.put('/', (req, res) => {
  try {
    const next = settings.putGlobalSettings(req.body || {});
    res.json(next);
  } catch (err) {
    sendValidationError(res, err);
  }
});

router.get('/projects/:projectKey', (req, res) => {
  try {
    res.json(settings.getProjectSettings(req.params.projectKey));
  } catch (err) {
    sendValidationError(res, err);
  }
});

router.patch('/projects/:projectKey', (req, res) => {
  try {
    const body = req.body || {};
    const patch = (body.overrides && typeof body.overrides === 'object') ? body.overrides : body;
    const next = settings.patchProjectSettings(req.params.projectKey, patch);
    res.json(next);
  } catch (err) {
    sendValidationError(res, err);
  }
});

router.put('/projects/:projectKey', (req, res) => {
  try {
    const next = settings.putProjectSettings(req.params.projectKey, req.body || {});
    res.json(next);
  } catch (err) {
    sendValidationError(res, err);
  }
});

module.exports = router;
