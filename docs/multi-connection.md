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

## List connections

```sh
rootbound connection list
```

The active connection is marked with `*`.

To inspect only the current connection:

```sh
rootbound connection current
```

This also reports whether the running Rootbound runtime belongs to that connection.

## Add another connection

Run:

```sh
rootbound connection add work
```

Replace `work` with any short label that makes sense to you, for example `personal`, `client-acme`, or `second-account`.

The guided setup:

1. checks `tunnel-client`;
2. discovers available OpenAI tunnel IDs when possible;
3. asks which tunnel this connection should use;
4. asks for a tunnel Runtime API key;
5. writes the runtime key to a private connection-scoped file;
6. validates the tunnel with `tunnel-client doctor`;
7. saves the connection only after tunnel setup succeeds.

For the long-lived tunnel daemon, use a restricted runtime key with only the permissions needed to read/use the tunnel. Rootbound does not silently persist `OPENAI_API_KEY` as a tunnel runtime credential.

Each new connection gets isolated local files under:

```text
state/connections/<connection-id>/
```

including its own tunnel configuration, managed tunnel profile, and runtime key.

## Switch connection

```sh
rootbound connection switch work
```

If Rootbound is stopped, this only changes which connection will be used on the next `rootbound connect` or `rootbound start`.

If Rootbound is running, the switch is transactional:

```text
validate target tunnel
        ↓
remember current project + connection
        ↓
stop current runtime
        ↓
start same project with target connection
        ↓
wait for tunnel /readyz = HTTP 200
        ↓
persist target as active
```

The active connection is not persisted until the target runtime is actually ready.

If the target fails to start, Rootbound attempts to restart the previous project + connection tuple. When restoration succeeds, the previous connection remains active.

Typical failure code:

```text
CONNECTION_SWITCH_FAILED_RESTORED
```

If both the target and restoration fail:

```text
CONNECTION_SWITCH_FAILED_RESTORE_FAILED
```

Rootbound never reports the failed target as active in either case.

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

New connection-scoped profiles configure a tunnel health URL file and Rootbound requires the tunnel's `/readyz` endpoint to return HTTP 200 before publishing the runtime as ready.

Process existence alone is not considered successful startup for new connection profiles.

The original legacy/default connection keeps a compatibility fallback so an existing installation is not broken merely because its old managed YAML predates the health URL setting.

## Environment overrides

`ROOTBOUND_TUNNEL_ARGV_JSON` remains available for the existing advanced/environment-only workflow.

However, once Rootbound is launching an explicit saved connection, that connection wins. A stale global tunnel argv override is not allowed to redirect an explicit connection switch.

Managed scoped tunnel launches also remove generic tunnel credential/id environment variables that could otherwise override the selected YAML profile.

## Runtime mutation safety

The installed `rootbound` entrypoint serializes operations that mutate the single Rootbound runtime:

```text
rootbound connect
rootbound start
rootbound stop
rootbound connection switch
rootbound tunnel clear
```

A second concurrent mutation fails with:

```text
RUNTIME_MUTATION_BUSY
```

rather than racing the first operation.

## Tunnel cleanup

`tunnel clear` operates on the active connection.

Rootbound refuses to clear tunnel files belonging to the running connection:

```text
CONNECTION_IN_USE
```

Stop Rootbound or switch to another connection first.

Connection-scoped cleanup removes only that connection's tunnel config, managed YAML, runtime key, and health URL artifact. It does not delete the files of another connection.

## Security boundaries

Connection registry metadata does not contain runtime API keys.

Runtime keys remain in separate private files. On POSIX systems Rootbound writes them with owner-only permissions; Windows uses the existing Rootbound private-file ACL hardening path.

Runtime API keys must not appear in:

- `connection-registry.json`;
- `tunnel.json`;
- the managed tunnel YAML;
- `runtime.json`;
- normal logs;
- diagnostics;
- CLI status output.

## Codex authentication

Switching a Rootbound connection does not switch or copy Codex OAuth credentials.

If local Codex reports an authentication failure such as a revoked OAuth token, fix the local Codex authentication separately. The OpenAI tunnel connection and Codex authentication are intentionally treated as separate layers.

## Release validation

The feature is guarded by tests for:

- connection registry durability and legacy reconciliation;
- connection-scoped tunnel isolation;
- environment precedence;
- runtime mutation locking;
- scoped `/readyz` startup;
- successful connection switching;
- failed switch rollback;
- tunnel secret/profile hardening;
- release-contract test wiring.

Before release, run:

```sh
npm run validate:release
```

and perform a real two-ChatGPT-workspace/two-tunnel smoke test on macOS.
