// Parser for the copilot CLI's "no such agent" stderr message.
//
// Pinned to copilot CLI version 1.0.55. There is no documented CLI surface
// that enumerates agents (probed: `copilot --help`, `--version`, `help config`,
// every subcommand). We therefore spawn `copilot --agent __list__ ...` and
// scrape the "available: ..." hint emitted with the resulting error.
//
// Expected stderr shape (illustrative, modeled on CLI 1.0.55 behavior):
//
//   No such agent: __list__, available: agent-alpha, agent-beta,
//   helper-bot, ..., tools:scanner
//
// If the CLI's error wording shifts, the regression test in
// `test/agents.test.js` will fail and force a deliberate update here.

// Matches typical CSI SGR color/style escapes that the CLI may emit.
const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

// Pure parser. Returns an array of agent names, or [] on no match.
// Does not log; callers are responsible for surfacing parse misses.
function parseAgentsFromStderr(stderr) {
  if (typeof stderr !== 'string' || stderr.length === 0) {
    return [];
  }
  const clean = stderr.replace(ANSI_PATTERN, '');
  const match = clean.match(/available:\s*(.+)/i);
  if (!match) {
    return [];
  }
  return match[1]
    .split(',')
    .map(a => a.trim())
    .filter(Boolean);
}

module.exports = { parseAgentsFromStderr };
