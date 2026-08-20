# Rootbound multi-connection profiles

Rootbound can keep several OpenAI tunnel connections on one machine and switch between them without clearing the current tunnel or re-entering credentials.

This is intended for people who use Rootbound from more than one ChatGPT/OpenAI workspace or otherwise need more than one tunnel.

## Terminology

Rootbound calls these **connections**, not ChatGPT accounts.

A connection stores the local configuration required to reach one OpenAI tunnel. Rootbound does not persist a ChatGPT email, ChatGPT OAuth token, or Codex OAuth token in the connection registry.

Codex authentication remains separate from the ChatGPT/OpenAI tunnel connection.

## Existing users

Existing Rootbound installations are migrated non-destructively.

The existing files:

```text
state/tunnel.json
state/tunnel-client.yaml
state/tunnel-runtime.key
```

remain in place and become the `default` legacy connection.

The migration does not change the Rootbound SQLite schema and does not move the existing runtime key. This preserves downgrade compatibility with the previous V5 layout.

## List and inspect connections

```sh
rootbound connection list
rootbound connection current
```

The active connection is marked with `*`. `current` also reports whether the running runtime belongs to that connection and surfaces registry/runtime drift.

## Add another connection

```sh
rootbound connection add work
```

Replace `work` with any short label that makes sense to you, for example `personal`, `client-acme`, or `second-account`.

The guided setup checks `tunnel-client`, discovers tunnel IDs when possible, asks for a tunnel Runtime API key, stores the key in a private connection-scoped file, validates with `tunnel-client doctor`, and saves the connection only after validation succeeds.

For the long-lived daemon, use a restricted runtime key with only the permissions needed to read/use the tunnel. Rootbound does not silently persist `OPENAI_API_KEY` as a tunnel runtime credential.

Each new connection gets isolated local files under:

```text
state/connections/<connection-id>/
```

## Switch connection

```sh
rootbound connection switch work
```

If Rootbound is stopped, this only changes the active connection for the next start.

If Rootbound is running, the switch is transactional:

```text
validate target tunnel
        ↓
remember actual running project + connection
        ↓
stop current runtime
        ↓
start same project with target connection
        ↓
wait for tunnel /readyz = HTTP 200
        ↓
persist target as active
```

If the target fails, Rootbound attempts to restore the previous runtime tuple. Successful restoration returns `CONNECTION_SWITCH_FAILED_RESTORED`; a double failure returns `CONNECTION_SWITCH_FAILED_RESTORE_FAILED`.

## Repair / rotate a runtime key

If a tunnel Runtime API key is revoked or rotated, keep the same connection and run:

```sh
rootbound connection repair work
```

Rootbound refuses to repair a connection that is currently used by the runtime. Stop Rootbound or switch away first.

Repair preserves the tunnel ID, writes the candidate replacement key, and validates it with `tunnel-client doctor`. If validation fails, Rootbound restores the previous key/configuration and returns:

```text
CONNECTION_REPAIR_FAILED_RESTORED
```

If even the local restoration write fails, Rootbound returns:

```text
CONNECTION_REPAIR_RESTORE_FAILED
```

The old key is therefore not intentionally discarded just because a replacement credential is invalid.

## Remove a connection

```sh
rootbound connection remove work
```

Rootbound refuses removal while that connection is used by the running runtime (`CONNECTION_IN_USE`). Otherwise it removes only that connection's tunnel config, managed YAML, runtime key and health URL, then removes the registry entry.

If the removed connection was active while Rootbound was stopped, the first remaining connection becomes active; if none remain, the active connection becomes `none`.

## Doctor

`rootbound doctor` now validates the connection layer as part of the normal model-free health check:

```text
connection-registry
active-connection
tunnel-secret-permissions
tunnel-client-doctor
runtime-connection
tunnel-readiness
```

It reports registry/runtime drift and gives a targeted next action. Doctor still does not start a Codex model turn.

Rootbound can validate only its local side. ChatGPT must still select the same `tunnel_...` ID in the connector UI.

## ChatGPT connector

After switching Rootbound, the ChatGPT custom app/connector you use must select the same OpenAI tunnel as the active Rootbound connection.

Check the active tunnel with:

```sh
rootbound connection current
```

or:

```sh
rootbound tunnel show
```

Rootbound cannot reliably inspect which tunnel the ChatGPT UI currently selected. If ChatGPT points to a different tunnel, the request may never reach the active Rootbound daemon.

## Runtime readiness

New scoped profiles configure a tunnel health URL file and Rootbound requires `/readyz` to return HTTP 200 before publishing the runtime as ready.

Process existence alone is not successful startup for new connection profiles. The original legacy/default connection keeps a compatibility fallback so an existing installation is not broken merely because its old managed YAML predates health URL support.

## Environment overrides

`ROOTBOUND_TUNNEL_ARGV_JSON` remains available for the existing advanced/environment-only workflow.

Once Rootbound is launching an explicit saved connection, that connection wins. A stale global tunnel argv override is not allowed to redirect an explicit connection switch. Managed scoped launches also remove generic tunnel credential/id environment variables that could otherwise override the selected profile.

## Runtime mutation safety

The installed `rootbound` entrypoint serializes operations that mutate the single Rootbound runtime or its active connection/tunnel:

```text
rootbound connect
rootbound start
rootbound stop
rootbound connection switch
rootbound connection repair
rootbound connection remove
rootbound tunnel configure
rootbound tunnel clear
```

A second concurrent mutation fails with `RUNTIME_MUTATION_BUSY` rather than racing the first operation.

## Tunnel configuration safety

`tunnel configure` and `tunnel clear` operate on the active connection. Rootbound refuses to reconfigure or clear files for a connection currently used by the runtime.

The tunnel layer also fails closed when `connection-registry.json` is structurally invalid; it does not silently fall back to the old global tunnel in that case.

## Logs during support

`rootbound logs --follow` now labels the historical tail separately from new entries:

```text
--- previous log tail ---
...
--- following new entries from now ---
```

For debugging only requests generated after the command starts, use:

```sh
rootbound logs --follow --new-only
```

This prevents historical tunnel IDs from being mistaken for current traffic.

## Security boundaries

Connection registry metadata does not contain runtime API keys.

Runtime keys remain in separate private files. On POSIX systems Rootbound writes them with owner-only permissions; Windows uses the existing Rootbound private-file ACL hardening path.

Runtime API keys must not appear in `connection-registry.json`, `tunnel.json`, managed YAML, `runtime.json`, normal logs, diagnostics, or CLI status output.

## Codex authentication

Switching a Rootbound connection does not switch or copy Codex OAuth credentials.

If local Codex reports an authentication failure such as a revoked OAuth token, fix local Codex authentication separately. The OpenAI tunnel connection and Codex authentication are intentionally separate layers.

## Release validation

The release gate covers registry durability, legacy reconciliation, tunnel isolation, environment precedence, runtime mutation locking, `/readyz`, switch rollback, repair rollback, removal cleanup, log-follow UX, secret/profile hardening and release-contract wiring.

Before release, run:

```sh
npm run validate:release
```

and perform a real two-ChatGPT-workspace/two-tunnel smoke test on macOS.
