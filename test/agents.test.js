const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');

const { parseAgentsFromStderr } = require('../lib/cli/agents-parser');
const { listAgents, resetAgentsCache } = require('../lib/cli/agents');

// Synthetic example modeled on the copilot CLI 1.0.55 stderr shape emitted by
// `--agent __list__ -p x -s`. The wrapper text ("No such agent: __list__,
// available: ...") is the actual CLI contract being pinned; the agent names
// are dummy data covering bare and plugin-namespaced forms. If the CLI's
// error wording shifts, update this and `lib/cli/agents-parser.js` together.
const FIXTURE_1_0_55 = 'No such agent: __list__, available: agent-alpha, agent-beta, helper-bot, sample-agent, demo:runner, demo:planner, plugin-x:agent-one, plugin-x:agent-two, plugin-y:helper, tools:scanner';

const EXPECTED_AGENTS = [
  'agent-alpha',
  'agent-beta',
  'helper-bot',
  'sample-agent',
  'demo:runner',
  'demo:planner',
  'plugin-x:agent-one',
  'plugin-x:agent-two',
  'plugin-y:helper',
  'tools:scanner',
];

// Fake child process. `mode`:
//   'close-with-stderr' - emits stderr chunk then 'close'
//   'error'             - emits 'error' on next tick
function makeChild({ mode, stderr = '', err }) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  if (mode === 'close-with-stderr') {
    setImmediate(() => {
      if (stderr) child.stderr.emit('data', Buffer.from(stderr));
      child.emit('close', 1);
    });
  } else if (mode === 'error') {
    setImmediate(() => child.emit('error', err || new Error('spawn failed')));
  }
  return child;
}

function makeSpawn(plans) {
  const calls = [];
  let i = 0;
  function spawn(args) {
    calls.push({ args });
    const plan = plans[Math.min(i, plans.length - 1)];
    i++;
    if (plan === 'throw') {
      throw new Error('synchronous spawn boom');
    }
    return makeChild(plan);
  }
  return { spawn, calls };
}

// --- parseAgentsFromStderr ---------------------------------------------------

test('parseAgentsFromStderr: CLI 1.0.55 fixture yields expected agents with plugin names preserved', () => {
  const agents = parseAgentsFromStderr(FIXTURE_1_0_55);
  assert.deepEqual(agents, EXPECTED_AGENTS);
  assert.equal(agents.length, 10);
  assert.ok(agents.includes('demo:planner'));
  assert.ok(agents.includes('plugin-x:agent-two'));
});

test('parseAgentsFromStderr: tolerates extra whitespace and trailing newlines', () => {
  const noisy = '\n\n  No such agent: __list__,   available:   foo,   bar ,baz  \n\n';
  assert.deepEqual(parseAgentsFromStderr(noisy), ['foo', 'bar', 'baz']);
});

test('parseAgentsFromStderr: strips ANSI color escapes before matching', () => {
  const colored = '\x1b[31mNo such agent: __list__, \x1b[1mavailable:\x1b[0m foo, bar\x1b[0m';
  assert.deepEqual(parseAgentsFromStderr(colored), ['foo', 'bar']);
});

test('parseAgentsFromStderr: malformed stderr returns []', () => {
  assert.deepEqual(parseAgentsFromStderr('agent not found'), []);
  assert.deepEqual(parseAgentsFromStderr('something completely different'), []);
});

test('parseAgentsFromStderr: empty / non-string input returns []', () => {
  assert.deepEqual(parseAgentsFromStderr(''), []);
  assert.deepEqual(parseAgentsFromStderr(null), []);
  assert.deepEqual(parseAgentsFromStderr(undefined), []);
});

// --- listAgents --------------------------------------------------------------

test('listAgents: success path parses stderr, caches result, and invokes spawn once across calls', async (t) => {
  resetAgentsCache();
  const { spawn, calls } = makeSpawn([{ mode: 'close-with-stderr', stderr: FIXTURE_1_0_55 }]);

  const first = await listAgents({ spawn });
  const second = await listAgents({ spawn });

  assert.deepEqual(first, EXPECTED_AGENTS);
  assert.deepEqual(second, EXPECTED_AGENTS);
  assert.equal(calls.length, 1, 'second call should be served from cache');
  assert.deepEqual(calls[0].args, ['--agent', '__list__', '-p', 'x', '-s']);
});

test('listAgents: parse miss returns [], logs loudly, and does not cache the empty result', async (t) => {
  resetAgentsCache();
  const errCalls = [];
  t.mock.method(console, 'error', (...args) => { errCalls.push(args.join(' ')); });

  const { spawn, calls } = makeSpawn([
    { mode: 'close-with-stderr', stderr: 'agent not found' },
    { mode: 'close-with-stderr', stderr: FIXTURE_1_0_55 },
  ]);

  const first = await listAgents({ spawn });
  assert.deepEqual(first, []);
  assert.ok(errCalls.some(m => m.includes('[runway] agent enumeration: unrecognised copilot CLI stderr shape')));
  assert.ok(errCalls.some(m => m.includes('agent not found')), 'raw stderr should be included in the log');

  // Failure not cached: a follow-up call should re-spawn and recover.
  const second = await listAgents({ spawn });
  assert.deepEqual(second, EXPECTED_AGENTS);
  assert.equal(calls.length, 2);
});

test('listAgents: spawn emits ENOENT-style error -> [] returned and logged', async (t) => {
  resetAgentsCache();
  const errCalls = [];
  t.mock.method(console, 'error', (...args) => { errCalls.push(args.join(' ')); });

  const enoent = Object.assign(new Error('spawn copilot ENOENT'), { code: 'ENOENT' });
  const { spawn } = makeSpawn([{ mode: 'error', err: enoent }]);

  const result = await listAgents({ spawn });
  assert.deepEqual(result, []);
  assert.ok(errCalls.some(m => m.includes('[runway] agent enumeration: copilot CLI invocation failed')));
  assert.ok(errCalls.some(m => m.includes('ENOENT')));
});

test('listAgents: synchronous throw from spawn -> [] returned and logged', async (t) => {
  resetAgentsCache();
  const errCalls = [];
  t.mock.method(console, 'error', (...args) => { errCalls.push(args.join(' ')); });

  const { spawn } = makeSpawn(['throw']);
  const result = await listAgents({ spawn });
  assert.deepEqual(result, []);
  assert.ok(errCalls.some(m => m.includes('[runway] agent enumeration: copilot CLI invocation failed')));
  assert.ok(errCalls.some(m => m.includes('synchronous spawn boom')));
});
