<div align="center">

# Codexless

### ChatGPT gets local coding hands without starting a Codex model turn.

**Windows + Apple Silicon macOS Technical Preview**

</div>

Codexless exposes a deliberately small, tested, model-free local coding surface to ChatGPT while keeping Codex as the local trust / sandbox authority.

The V5 goal is simple: **one durable local control plane, one project registry, one persistent state store, one safe public tool contract, and no hidden Codex model fallback.**

> ChatGPT reasons. Codexless executes accepted local primitives. Codex model work remains a separate explicit choice.

---

## V5 at a glance

Current public surface:

- `codexless-public-preview-v5`
- 27 public tools
- no public model catalog
- no public Codex agent / turn-start surface
- durable SQLite state
- persistent project registry and `projectRef`
- exact-root trust workflow with backup / rollback
- long-running commands with incremental polling
- interactive stdin / terminate on supported App Server implementations
- continuity bindings and idempotent checkpoints
- guarded precise-edit undo / redo
- paginated project reads and searches
- persistent tunnel configuration without storing literal credentials
- redacted diagnostic export

The exact public tool list is defined in [`src/surface-contracts.mjs`](src/surface-contracts.mjs).

---

## Requirements

- **Node.js >= 22.13.0**
- an accepted local Codex installation
- Windows or Apple Silicon macOS for the Technical Preview
- an authenticated MCP tunnel / remote endpoint path that can launch the local Codexless stdio server

Codexless does not install Codex for you and does not silently widen project trust.

---

## Install

### Apple Silicon macOS

```sh
sh ./bin/codexless-install.sh
```

Default layout:

```text
~/Library/Application Support/Codexless/
├── app/       # installed release
├── state/     # SQLite state
├── runtime/   # runtime state
├── logs/      # supervisor logs
└── backups/   # config backups
```

CLI:

```sh
"$HOME/Library/Application Support/Codexless/app/bin/codexless.sh" help
```

### Windows

```bat
bin\codexless-install.cmd
```

Default layout:

```text
%LOCALAPPDATA%\Codexless\
├── app\
├── state\
├── runtime\
├── logs\
└── backups\
```

CLI:

```bat
%LOCALAPPDATA%\Codexless\app\bin\codexless.cmd help
```

The app tree and state tree are intentionally separate so staged upgrades do not replace project state.

---

## Daily-driver setup

### 1. Configure the tunnel once

Codexless can persist a tunnel argv template locally. Literal credentials are rejected; use environment placeholders instead.

Example:

```sh
codexless tunnel configure --argv-json '["tunnel-client","--token","{env:TUNNEL_TOKEN}","--stdio","{node}","{launchScript}","stdio"]'
```

Then export the secret in the environment that starts Codexless:

```sh
export TUNNEL_TOKEN="..."
```

Inspect the stored non-secret template:

```sh
codexless tunnel show
```

Remove it:

```sh
codexless tunnel clear
```

`CODEXLESS_TUNNEL_ARGV_JSON` remains available as a temporary environment override.

### 2. Connect a project

```sh
codexless connect .
```

`connect`:

1. resolves the canonical / Git root;
2. validates tunnel configuration before touching trust;
3. asks before adding exact-root Codex trust;
4. backs up the Codex config before mutation;
5. runs the doctor against the project;
6. rolls trust back if validation fails;
7. registers the project in SQLite;
8. starts the supervised tunnel runtime.

For non-interactive setup:

```sh
codexless connect . --yes
```

Prepare trust / registry without starting the runtime:

```sh
codexless connect . --yes --no-start
```

### 3. Check status

```sh
codexless status
```

### 4. Validate the local lane

```sh
codexless self-test .
```

The self-test verifies the accepted Codex App Server path and performs model-free:

- read authority validation;
- short command execution;
- temporary write + read-back + cleanup when workspace write authority is available.

It does **not** start a Codex model turn.

### 5. Inspect logs / diagnostics

```sh
codexless logs
codexless logs --follow
codexless diagnostic
```

Diagnostic exports are intentionally redacted and do not include command stdout/stderr or stored thread previews.

### 6. Stop

```sh
codexless stop
```

---

## Upgrade

Upgrade from an explicit release directory:

```sh
codexless upgrade --from /path/to/new/codexless-release
```

The upgrade path:

- stops the runtime first;
- uses staged installation;
- validates before activation;
- preserves the external state tree;
- rolls back the app install when activation fails.

Codexless intentionally does not invent an implicit network updater in V5.

---

## Public tool surface

### Workspace / context

- `codex.workspace_open`
- `codex.project_context`
- `codex.skill_list`
- `codex.skill_read`

`workspace_open` is the preferred V5 entry point. It resolves a canonical project root and durable `projectRef`. It never creates trust as a side effect; unauthorized workspaces return a typed `needs_trust` result.

### Project inspection

- `codex.repo_search`
- `codex.read_many`
- `codex.git_status`
- `codex.git_diff`

`repo_search` and `read_many` use opaque request-bound cursors. Sensitive files such as `.env`, credentials and private keys are excluded / refused by default and require explicit opt-in.

### Editing

- `codex.apply_patch`
- `codex.precise_edit`
- `codex.edit_undo`
- `codex.edit_redo`

`precise_edit` validates hashes and occurrence counts before writing. Non-sensitive successful edits can return a `mutationId`; undo / redo restore exact content only while SHA guards still match. There is no `git reset` based pseudo-undo.

Sensitive paths are never copied into the undo snapshot store.

### Commands

- `codex.command_exec`
- `codex.command_start`
- `codex.command_poll`
- `codex.command_write`
- `codex.command_terminate`

`command_exec` is for short buffered work.

For long-running work:

1. call `command_start`;
2. retain the returned `commandId`;
3. call `command_poll` with the returned cursor;
4. optionally use `command_write` / `command_terminate` where supported.

Long-command output is persisted incrementally in bounded SQLite chunks. Durable commands reject detectable literal credentials before argv reaches SQLite.

The accepted Windows App Server implementation currently uses a buffered worker fallback for long commands; interactive streaming is surfaced as unsupported instead of silently pretending to work.

### Codex history / continuity

- `codex.thread_list`
- `codex.thread_read`
- `codex.thread_items`
- `codex.continuity_bind`
- `codex.continuity_status`
- `codex.continuity_checkpoint`
- `codex.continuity_unbind`

Continuity state survives MCP/runtime restarts through SQLite.

`continuity_bind` and `continuity_checkpoint` accept optional idempotency keys. Checkpoints use fail-closed pending/completed state so an ambiguous network retry does not blindly inject the same checkpoint twice.

### Browser Reader

- `codex.browser_status`
- `codex.browser_tabs`
- `codex.browser_read`

The public Browser Reader remains read-first. Arbitrary clicking / typing / navigation is not part of this public contract.

---

## Security model

Codexless is designed to fail closed around the local Codex authority.

- remote callers cannot select a stronger permission profile than the local ceiling;
- nested Codex CLI launches from the model-free command lane are rejected;
- project trust is exact-root and explicit;
- trust mutation is backed up and rollback-capable;
- durable argv containing detectable credentials is refused;
- tunnel templates cannot persist literal credentials;
- sensitive files are excluded from ordinary search / read flows unless explicitly requested;
- sensitive precise edits do not create undo snapshots;
- diagnostics redact credentials, home paths and sensitive thread data;
- model-turn / token-usage side effects detected during the accepted streaming command lane fail closed.

See [`SECURITY.md`](SECURITY.md) for the broader boundary.

---

## Typed errors

V5 tools progressively use a common machine-readable error shape:

```json
{
  "status": "error",
  "errorCode": "PERMISSION_APPROVAL_REQUIRED",
  "category": "permission",
  "retryable": false,
  "nextActions": ["..."],
  "operation": "workspace_open",
  "surfaceVersion": "codexless-public-preview-v5"
}
```

Clients should prefer `errorCode`, `category` and `retryable` over parsing human error text.

---

## Development

Install dependencies:

```sh
npm ci
```

Run the V5 model-free unit / contract subset:

```sh
npm run test:v5
```

Run the full repository suite:

```sh
npm test
```

Start stdio directly:

```sh
npm run start:stdio
```

Start HTTP directly:

```sh
npm run start:http
```

The V5 GitHub Actions workflow is currently **manual-only** while the branch is being stabilized. It must not be re-enabled on every push until the suite is green and notification noise is under control.

---

## Current V5 status

The V5 implementation is still on the feature branch and has not been merged into `main`.

The durable implementation plan / acceptance checklist lives in [`docs/plans/codexless-v5.md`](docs/plans/codexless-v5.md).

Known release-validation work still includes:

- one clean manual macOS + Windows CI run;
- real-machine `connect` / tunnel acceptance against the intended tunnel client;
- lockfile metadata regeneration with npm rather than hand-editing package integrity data;
- final upgrade / uninstall acceptance on both supported platforms;
- final documentation / release packaging review.

---

## Project status

Codexless is an independent project. It is not an OpenAI product and does not imply OpenAI endorsement.

> **Keep working in ChatGPT. Use Codex when you explicitly need Codex.**
