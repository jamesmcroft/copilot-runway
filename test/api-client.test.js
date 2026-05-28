const test = require('node:test');
const assert = require('node:assert/strict');

const ApiClient = require('../public/api-client');

function stubFetch(response) {
  const calls = [];
  const fn = (path, options) => {
    calls.push({ path, options });
    return Promise.resolve(response);
  };
  return { fn, calls };
}

test('apiJson resolves the JSON body returned by the underlying fetch', async () => {
  const { fn } = stubFetch({ json: async () => ({ ok: true, value: 42 }) });
  const client = ApiClient.createClient(fn);
  const result = await client.apiJson('/api/anything');
  assert.deepEqual(result, { ok: true, value: 42 });
});

test('apiJson forwards an AbortSignal to fetch (issue #49 race guard)', async () => {
  const { fn, calls } = stubFetch({ json: async () => ({}) });
  const client = ApiClient.createClient(fn);

  const controller = new AbortController();
  await client.apiJson('/api/sessions/abc', { signal: controller.signal });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/api/sessions/abc');
  assert.ok(calls[0].options, 'fetch should be called with an options object');
  assert.equal(
    calls[0].options.signal,
    controller.signal,
    'the signal passed to apiJson must reach the underlying fetch'
  );
});

test('apiFetch passes through method, headers, and body unchanged', async () => {
  const { fn, calls } = stubFetch({ json: async () => ({}) });
  const client = ApiClient.createClient(fn);

  const body = JSON.stringify({ folderPath: 'C:/src/example' });
  await client.apiFetch('/api/projects/add', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });

  assert.equal(calls[0].options.method, 'POST');
  assert.deepEqual(calls[0].options.headers, { 'Content-Type': 'application/json' });
  assert.equal(calls[0].options.body, body);
});

test('apiFetch does not mutate the caller options object', async () => {
  const { fn } = stubFetch({ json: async () => ({}) });
  const client = ApiClient.createClient(fn);

  const controller = new AbortController();
  const opts = { signal: controller.signal, method: 'GET' };
  const snapshot = { ...opts };

  await client.apiFetch('/api/sessions/xyz', opts);

  assert.deepEqual(opts, snapshot, 'caller-supplied options must not be mutated');
});

test('an aborted signal causes fetch to reject with AbortError', async () => {
  // Simulate a fetch implementation that honors AbortSignal the way browsers do.
  const fn = (_path, options) => new Promise((_resolve, reject) => {
    if (options && options.signal) {
      options.signal.addEventListener('abort', () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      });
    }
  });
  const client = ApiClient.createClient(fn);

  const controller = new AbortController();
  const pending = client.apiJson('/api/sessions/slow', { signal: controller.signal });
  controller.abort();

  await assert.rejects(pending, (err) => err.name === 'AbortError');
});
