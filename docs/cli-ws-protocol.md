# CLI WebSocket protocol findings (WI-S, issue #16)

Empirical investigation of the GitHub Copilot CLI's advertised local
WebSocket endpoint, performed against `GitHub Copilot CLI 1.0.55-3` on
Windows.

## TL;DR

> **The `~/.copilot/run/ws.{port,token}` endpoint is not active on the
> current CLI build.** No process binds the advertised TCP port, even when
> an interactive session is started with `--remote`. The port and token
> files appear to be either stale leftovers or a vestige from a previous
> version. All handshake variants we tried (`Sec-WebSocket-Protocol`
> subprotocol, `Authorization: Bearer`, `?token=` query string, `/ws` path,
> no-auth) returned `ECONNREFUSED`. The `--remote` flow operates over an
> outbound HTTPS connection to `github.com/copilot/tasks/<id>`, not a local
> socket.

### Headline verdict (write semantics)

**Write capability is unverifiable today.** WI-C (#18) as written cannot
proceed as a "pure Runway change" against the documented `ws.port` /
`ws.token` files because no server answers on those files in this build.

### Recommended next step

**WI-C (#18) needs an upstream CLI feature request.** Ask the Copilot CLI
team to:

1. Confirm whether `~/.copilot/run/ws.{port,token}` is a planned,
   experimental, or deprecated mechanism.
2. Expose a local IPC channel (WebSocket on the loopback interface,
   Unix-domain socket, or named pipe on Windows) that lets a co-located
   orchestrator both observe session events and post user turns into a
   running, idle session.
3. Document the frame schema for any such endpoint.

Until an upstream channel exists, the sibling WIs need to be re-scoped
against whatever Runway can observe through the already-public data
sources it consumes today (the CLI's SQLite session store and the per
session state directory under `~/.copilot/session-state/<id>/`). That
rescope is out of scope for this spike.

## How this was determined

### Environment

| | |
|---|---|
| OS | Windows |
| CLI | GitHub Copilot CLI 1.0.55-3 |
| Port file (`~/.copilot/run/ws.port`) | `57800` (mtime well before any probe) |
| Token file (`~/.copilot/run/ws.token`) | 43 bytes (treated as opaque, value never logged) |

### Probes

All probe scripts live in [`spike/`](../spike/) with their own README.
Reproduce with:

```powershell
node spike/probe-connect.js   # tries 5 handshake variants
node spike/probe-record.js    # would log inbound frames (no frames produced)
node spike/probe-write.js     # would try inbound frame shapes (no connection)
```

### Observed behavior

#### 1. Port file is stale

`~/.copilot/run/ws.port` advertises port `57800`, but no process on the
machine listens on that port:

```
PS> Get-NetTCPConnection -LocalPort 57800 -ErrorAction SilentlyContinue
<no rows>
```

#### 2. All connection attempts fail

`spike/probe-connect.js` tried five handshake variants. Every one returned
`ECONNREFUSED 127.0.0.1:57800`:

```jsonc
{"label":"subprotocol","accepted":false,"closeCode":1006,"error":"connect ECONNREFUSED 127.0.0.1:57800"}
{"label":"authorization-bearer","accepted":false,"closeCode":1006,"error":"connect ECONNREFUSED 127.0.0.1:57800"}
{"label":"query-param","accepted":false,"closeCode":1006,"error":"connect ECONNREFUSED 127.0.0.1:57800"}
{"label":"path-ws-bearer","accepted":false,"closeCode":1006,"error":"connect ECONNREFUSED 127.0.0.1:57800"}
{"label":"no-auth","accepted":false,"closeCode":1006,"error":"connect ECONNREFUSED 127.0.0.1:57800"}
```

#### 3. Active CLI sessions do not bind any TCP port

Multiple CLI sessions were running on the host (paired parent/child
processes). None had any TCP listener:

```
PS> $copilots = Get-Process copilot | Select -Expand Id
PS> Get-NetTCPConnection -State Listen | Where { $_.OwningProcess -in $copilots }
<no rows>
```

#### 4. `--remote` does not bind a local port either

A fresh `copilot --remote` session was started interactively. It connected
to GitHub's hosted task channel:

```
Remote control connected as [REDACTED] (ctrl+e show QR code)
https://github.com/copilot/tasks/[REDACTED-uuid]
```

But the local `ws.port` file's mtime did not change and no copilot PID was
listening on any TCP port. **The current `--remote` feature flows over an
outbound HTTPS or WSS connection to `github.com`, not a local socket.**
Any "remote control" of the session goes round-tripping through GitHub.

## Connection mechanics

Not applicable on the current build. If and when the local endpoint is
exposed, `spike/probe-connect.js` tries the most plausible auth styles.
Run it once the endpoint is live to confirm which is accepted.

## Concurrency findings

Not testable without an active server. The original question (does opening
a second WS client coexist with an attached terminal CLI) cannot be
answered empirically. Recommend re-running this section once the endpoint
exists.

## Write-capability verdict

**No, not on the current build.** There is no reachable local endpoint to
post a frame to. The `--remote` mechanism that does exist routes through
GitHub's hosted task channel, not a local socket, so Runway cannot
interpose on it without an upstream change.

If the upstream team enables the local WS endpoint (or any other local
IPC), the write-capability question becomes empirically answerable using
`spike/probe-write.js`, which tries several plausible inbound frame
shapes.

## Risks and unknowns

- **Version skew**: findings are specific to CLI 1.0.55-3. Older or newer
  builds may behave differently. The `ws.port` / `ws.token` files could be
  from an experimental build the user ran previously.
- **The `--remote` GitHub task channel** could be a viable bridge for
  Runway in the future (it is bidirectional by definition; that is the
  point of "remote control"), but that would shift Runway from a
  local-only tool to one that brokers a remote channel, which is a much
  bigger architectural change and out of scope here.

## Final decision

> **WI-C (#18) needs an upstream CLI feature request.**

There is no local WebSocket bridge to write back into a running session on
CLI 1.0.55-3. Recommend opening a discussion or issue with the GitHub
Copilot CLI team requesting either (a) confirmation of the
`~/.copilot/run/ws.{port,token}` contract and its enablement conditions,
or (b) a local IPC endpoint for orchestrators like Runway.

The rescope path for the sibling WIs (#7, #15, #17, #19) against publicly
available Runway data sources is a separate planning question, not
answered by this spike.
