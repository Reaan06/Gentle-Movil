# gentle-movil bridge (Pi extension)

The official Gentle Movil bridge. It replaces the removed Rust daemon: the agent
process itself serves the two loopback ports the phone reaches through its SSH
tunnel. No binary, no install step, no `sudo`, no dependencies.

Protocol: [`docs/mobile-protocol-spec.md` §9](../docs/mobile-protocol-spec.md)
(`proto: 1`).

## Entry points

| Entry | Use |
|---|---|
| `src/extension.ts` | **Pi / Gentle Shell extension.** `session_start` starts both listeners, `message_end` forwards assistant output to attached devices, `session_shutdown` closes every socket. |
| `server.mjs` | **Standalone process.** Same `createBridge()` module. No agent is attached, so `input` frames are echoed back (`deliver: "echo"`). Useful for `curl`, `doctor`, and the offline tests. |
| `src/bridge.ts` | The server itself: a plain module (`createBridge()`), independent of Pi. |

Load the extension in Pi:

```bash
pi -e ./pi-extension/src/extension.ts
```

or list the absolute path in `settings.json`:

```json
{ "extensions": ["/abs/path/pi-extension/src/extension.ts"] }
```

Run the standalone bridge:

```bash
node pi-extension/server.mjs          # banner + JSON log lines
node pi-extension/server.mjs --quiet  # JSON log lines only
```

## Surface

Both listeners bind `127.0.0.1` only — there is no option to change that.

| Port | Surface |
|---|---|
| 43721 | `GET /api/health` (identity), `GET /api/sessions` (JSON list) |
| 43722 | `GET /ws/device` (WebSocket upgrade), plain HTTP → `404` |

```bash
curl -s http://127.0.0.1:43721/api/health
# {"app":"gentle-shell","bridge":"gentle-movil","proto":1,"version":"0.1.0"}

curl -s http://127.0.0.1:43721/api/sessions
# [{"id":"…","title":"…","status":"idle","cwd":"…","updatedAt":"…","current":true}]

ss -ltn | grep 4372
# LISTEN 0 511 127.0.0.1:43721 ...
# LISTEN 0 511 127.0.0.1:43722 ...
```

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `GENTLE_MOVIL_API_PORT` | `43721` | HTTP API port (invalid values fall back to the default) |
| `GENTLE_MOVIL_DEVICE_PORT` | `43722` | Device channel port |
| `GENTLE_MOVIL_SESSION_DIR` | Pi's own session dir | Where session JSONL files are read from |

Sessions come from Pi's session directory (`PI_SESSION_FILE`, then
`PI_CODING_AGENT_DIR/sessions`, then `~/.pi/agent/sessions`). When none of them
exists, `/api/sessions` returns `[]` — the bridge never invents sessions.

## Failure behaviour

Every failure is one JSON line on stdout (`level`, `event`, `connectionId`, …).
A client that disappears mid-frame is logged as
`ws.client_disconnected_mid_frame`, its socket is dropped, and both listeners
keep serving. A busy port is reported as `extension.bridge_start_failed` and the
agent keeps running.

## Tests

```bash
node --test pi-extension/test/
```

Offline, no dependencies: identity payload, sessions list (empty and populated),
WebSocket attach/echo round-trip, mid-frame disconnect, and the extension wiring
(session start/shutdown, input forwarded to `sendMessage`).
