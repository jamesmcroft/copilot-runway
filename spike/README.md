# CLI WS protocol spike (WI-S, issue #16)

Throwaway investigation scripts. Not wired into runtime. Do not import from
`server.js`, `public/`, or `bin/`. These exist purely to characterize the
GitHub Copilot CLI's local WebSocket endpoint at `127.0.0.1:<ws.port>`.

The findings are written up in `docs/cli-ws-protocol.md`.

## Prereqs

- GitHub Copilot CLI installed and currently running in a terminal somewhere
  on this machine.
- `~/.copilot/run/ws.port` and `~/.copilot/run/ws.token` present.
- `ws` Node package installed (added to root `package.json`).

## Scripts

All scripts read the port and token from `~/.copilot/run/` automatically.

### `probe-connect.js`

Tries three auth styles in sequence and reports which the server accepts:

1. `Sec-WebSocket-Protocol` subprotocol
2. `Authorization: Bearer <token>` header
3. `?token=<token>` query string

```powershell
node spike/probe-connect.js
```

### `probe-record.js`

Connects with the accepted auth style and logs every inbound frame to stdout
as one NDJSON line per frame `{ ts, dir: "in", type, data }`. Optionally
mirrors to a file.

```powershell
node spike/probe-record.js                          # stdout only
node spike/probe-record.js spike/frames-001.ndjson  # also write to file
```

Let it run while you drive the CLI in another terminal: send a short prompt,
trigger a tool call, sit idle, Ctrl+C a turn mid-stream. Stop with Ctrl+C
when done.

### `probe-write.js`

Attempts to send a user message into a running, idle CLI session via the WS.
Tries several plausible frame shapes (the Copilot CLI is closed-source, so
the schema is empirical). All test payloads are innocuous (`echo: spike test`).

```powershell
node spike/probe-write.js
```

Each attempt prints the frame sent, then captures the server's reaction for
~3 seconds (any frames received, close codes, etc).

## Safety

- These scripts only ever connect to `127.0.0.1`. They never exfiltrate the
  token.
- `probe-write.js` only sends innocuous test prompts. It does NOT send
  destructive prompts. Review the script before running.
- Frame logs may contain user content if you have an active session. Do not
  commit raw NDJSON captures. Redact before quoting in the findings doc.
