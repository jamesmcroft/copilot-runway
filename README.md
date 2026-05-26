# Copilot Runway

A local web dashboard for visualizing and orchestrating [GitHub Copilot CLI](https://github.com/features/copilot/cli/) sessions across all your projects.

If you work across multiple repos with several Copilot CLI sessions running at once, Runway gives you a single control tower to see what's happening, read conversation history, and send prompts without switching terminals.

## Features

- **Project sidebar**: auto-discovers projects from the Copilot CLI data store; add custom folders on the fly
- **Session list**: view all sessions for a project, filter by active/inactive, sorted by most recent activity
- **Live status**: detects active sessions via PID lock files with process verification
- **Conversation viewer**: read full session history with Markdown rendering (GFM, code blocks, tables)
- **Send prompts**: send one-shot prompts to new or existing sessions, streamed back via SSE
- **Resizable detail panel**: drag to resize, double-click to collapse, auto-expands on session select
- **Agent selection**: choose custom agents for new or existing sessions; Runway remembers the last-used agent per session
- **Localhost only**: binds to `127.0.0.1` with CORS protection

## Prerequisites

- **Node.js 18+**
- **GitHub Copilot CLI** installed and on your `PATH` (`copilot --version` should work)

## Install

Run it instantly with npx (no install required):

```bash
npx copilot-runway
```

Or install globally for a permanent command:

```bash
npm install -g copilot-runway
copilot-runway
```

The server starts and opens your browser automatically:

```
  Copilot Runway running at http://127.0.0.1:3847
```

### From source

```bash
git clone https://github.com/jamesmcroft/copilot-runway.git
cd copilot-runway
npm install
npm start
```

### Development mode

```bash
npm run dev
```

Uses `node --watch` to auto-restart the server on file changes.

## How it works

Runway reads from the Copilot CLI's local data stores (read-only) to build the dashboard:

| Source                                           | What it provides                                               |
| ------------------------------------------------ | -------------------------------------------------------------- |
| `~/.copilot/session-store.db`                    | Session history, conversation turns, checkpoints, file changes |
| `~/.copilot/data.db`                             | Project list (repos you've used with the CLI)                  |
| `~/.copilot/session-state/<id>/workspace.yaml`   | Session name, working directory, branch, git root              |
| `~/.copilot/session-state/<id>/inuse.<pid>.lock` | Active session detection (PID verified against OS)             |

Custom projects and app settings are stored in `~/.runway/` to keep Runway's data separate from the CLI's databases:

| File                            | Purpose                                                           |
| ------------------------------- | ----------------------------------------------------------------- |
| `~/.runway/projects.json`       | Custom project folders added through the dashboard                |
| `~/.runway/session-agents.json` | Last-used agent per session (auto-populated when sending prompts) |

When you send a prompt, Runway spawns a `copilot` process with `-p "your prompt" --output-format json` and streams the JSONL output back to the browser via Server-Sent Events. You can optionally select a custom agent (via the CLI's `--agent` flag) — Runway remembers your choice per session.

## Project structure

```
copilot-runway/
├── server.js          # Express backend — API routes, SQLite queries, CLI spawning
├── bin/
│   └── copilot-runway.js  # CLI entry point (npx / global install)
├── public/
│   ├── index.html     # Single-page app shell
│   ├── styles.css     # Light and dark themed styles
│   ├── app.js         # Frontend — rendering, themes, resize, markdown, API calls
│   ├── logo.svg       # App logo
│   └── favicon.svg    # Browser tab icon
├── .github/
│   ├── workflows/ci.yml   # CI + npm publish pipeline
│   ├── dependabot.yml
│   └── ISSUE_TEMPLATE/
├── package.json
├── LICENSE
└── README.md
```

## API reference

All endpoints are localhost-only with CORS origin protection.

| Method | Path                                              | Description                                                                     |
| ------ | ------------------------------------------------- | ------------------------------------------------------------------------------- |
| `GET`  | `/api/projects`                                   | List all projects (CLI + custom), sorted by recent activity                     |
| `POST` | `/api/projects/add`                               | Add a custom project folder (`{ folderPath, name? }`)                           |
| `GET`  | `/api/sessions?cwd=...&limit=50&active_only=true` | List sessions, optionally filtered by directory                                 |
| `GET`  | `/api/sessions/active`                            | List all active sessions across all projects                                    |
| `GET`  | `/api/sessions/:id`                               | Session detail with full conversation, checkpoints, and files                   |
| `POST` | `/api/sessions/send`                              | Send a prompt (SSE stream). Body: `{ prompt, sessionId?, cwd?, name?, agent? }` |
| `GET`  | `/api/agents`                                     | List available custom agents (cached 5 min)                                     |
| `GET`  | `/api/stats`                                      | Dashboard stats (total sessions, active count, recent activity)                 |

## Configuration

| Environment variable | Default | Description                                 |
| -------------------- | ------- | ------------------------------------------- |
| `PORT`               | `3847`  | Server port (change in `server.js` for now) |

Theme preference and panel width are stored in the browser's `localStorage`.

## Contributing

Contributions are welcome. To get started:

1. Fork the repo and clone your fork
2. `npm install`
3. `npm run dev` to start with auto-reload
4. Make your changes and test locally
5. Open a PR with a clear description of what you changed and why

## License

[MIT](LICENSE)
