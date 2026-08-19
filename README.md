<div align="center">

# Rootbound

### ChatGPT gets local coding hands without starting a Codex model turn.

**Windows + Apple Silicon macOS Technical Preview**

</div>

Rootbound exposes a deliberately small, tested, model-free local coding surface to ChatGPT while keeping Codex as the local trust / sandbox authority.

The V5 goal is simple: **one durable local control plane, one project registry, one persistent state store, one safe public tool contract, and no hidden Codex model fallback.**

> ChatGPT reasons. Rootbound executes accepted local primitives. Codex model work remains a separate explicit choice.

---

## V5 at a glance

Current public surface:

- `rootbound-public-preview-v5`
- 32 public tools
- no public model catalog
- no public Codex agent / turn-start surface
- durable SQLite state
- persistent project registry and `projectRef`
- exact-root trust workflow with backup / rollback
- long-running commands with incremental polling
- interactive stdin / terminate on supported App Server implementations
- continuity bindings and idempotent checkpoints
- zero-context Codex → ChatGPT rescue sessions with integrity matching
- advisory Codex quota state and reset timing when App Server exposes it
- guarded rescue drift detection / rollback / handoff back to the original Codex thread
- on-demand cold-memory search in persisted Codex history
- guarded precise-edit undo / redo
- paginated project reads and searches
- **guided one-command tunnel + project setup via `rootbound connect .`**
- redacted diagnostic export

The exact public tool list is defined in [`src/surface-contracts.mjs`](src/surface-contracts.mjs).

---

## Requirements

- **Node.js >= 22.13.0**
- an accepted local Codex installation
- the supported OpenAI `tunnel-client` available on `PATH`
- Windows or Apple Silicon macOS for the Technical Preview

For the first ChatGPT connection, OpenAI Tunnel still requires a tunnel ID and a runtime API key. **Rootbound handles that through its setup wizard; users should not need to configure tunnel profiles, `argv-json`, MCP command flags, or environment placeholders manually.**

Rootbound does not install Codex for you and does not silently widen project trust.

---

## Install

### Apple Silicon macOS

```sh
sh ./bin/rootbound-install.sh
```

Default layout:

```text
~/Library/Application Support/Rootbound/
├── app/       # installed release
├── state/     # SQLite + private local tunnel setup state
├── runtime/   # runtime state
├── logs/      # supervisor logs
└── backups/   # config backups
```

CLI:

```sh
rootbound help
```

The macOS installer creates `~/.local/bin/rootbound`. If `~/.local/bin` is not already on `PATH`, it adds a small marked block to the current user's login shell profile. Open a new terminal after first install if that PATH entry was newly added.

### Windows

```bat
bin\rootbound-install.cmd
```

Default layout:

```text
%LOCALAPPDATA%\Rootbound\
├── app\
├── state\
├── runtime\
├── logs\
└── backups\
```

CLI:

```bat
%LOCALAPPDATA%\Rootbound\app\bin\rootbound.cmd help
```

The app tree and state tree are intentionally separate so staged upgrades do not replace project state.

---

## Daily-driver setup

### Normal setup: one command

From the project you want ChatGPT to work on:

```sh
rootbound connect .
```

That is the normal setup path. The interactive wizard:

1. resolves the canonical / Git project root;
2. detects `tunnel-client`;
3. reuses `CONTROL_PLANE_TUNNEL_ID` or an existing local tunnel-client profile when one tunnel can be identified safely;
4. asks for a tunnel ID only when none can be detected;
5. reuses an existing runtime API key when present, otherwise asks for it once with hidden terminal input;
6. writes a Rootbound-managed tunnel profile that launches the local **stdio** server directly;
7. keeps the runtime API key out of `tunnel.json`, SQLite, argv and Rootbound logs; on macOS the private local key file is written mode `0600`;
8. runs `tunnel-client doctor` automatically before changing Codex trust;
9. asks before adding exact-root Codex trust;
10. backs up the Codex config before trust mutation;
11. runs the Rootbound doctor against the project and rolls trust back if validation fails;
12. registers the project in SQLite;
13. starts the supervised tunnel runtime.

A typical returning-user flow should therefore be only:

```sh
cd my-project
rootbound connect .
```

If the tunnel and key were already discovered/configured, the wizard skips those setup questions.

When the runtime is running, Rootbound prints the ChatGPT connector settings location so the connector can be created/refreshed while the tunnel is healthy.

### Non-interactive setup

For automation where trust approval and tunnel credentials are already supplied locally:

```sh
CONTROL_PLANE_TUNNEL_ID=tunnel_... \
CONTROL_PLANE_API_KEY=... \
rootbound connect . --yes
```

`--yes` does not invent missing credentials or tunnel IDs; it fails closed if the required setup cannot be resolved without prompting.

### Trust / registry only

To prepare exact-root trust and the project registry without requiring or starting a tunnel:

```sh
rootbound connect . --yes --no-start
```

This is an advanced/offline path; normal users should use plain `rootbound connect .`.

### Check status

```sh
rootbound status
```

### Manage registered projects

List the local Rootbound project registry:

```sh
rootbound project list
```

Remove a stale registry entry by exact stored path or `projectRef`:

```sh
rootbound project remove /path/to/old-project
rootbound project remove project_...
rootbound project remove /path/to/old-project --remove-trust
```

Removing a project deletes its Rootbound registry row and project-scoped Rootbound records through SQLite foreign-key cascade. It **never deletes project files**. By default Codex trust is left unchanged; `--remove-trust` removes the matching exact-root trust block after creating a config backup. Rootbound refuses to remove the project that currently owns the running supervised runtime; switch to another project or stop Rootbound first.

For an old exact-root trust entry that no longer has a Rootbound registry row:

```sh
rootbound trust remove /path/to/old-project
```

Trust removal is backed up first and also refuses to target the currently active Rootbound project.

### Validate the local lane

```sh
rootbound self-test .
```

The self-test verifies the accepted Codex App Server path and performs model-free:

- read authority validation;
- short command execution;
- temporary write + read-back + cleanup when workspace write authority is available.

It does **not** start a Codex model turn.

### Inspect logs / diagnostics

```sh
rootbound logs
rootbound logs --follow
rootbound diagnostic
```

Diagnostic exports are intentionally redacted and do not include command stdout/stderr or stored thread previews.

### Stop

```sh
rootbound stop
```

### Advanced / manual tunnel configuration

The `rootbound tunnel ...` commands remain available for operators who intentionally want to override the guided setup. They are **not required for normal onboarding**.

For example, to use an existing tunnel-client profile manually:

```sh
rootbound tunnel configure --argv-json '["tunnel-client","run","--profile","my-profile"]'
rootbound tunnel show
```

Remove the manual override/configuration with:

```sh
rootbound tunnel clear
```

`ROOTBOUND_TUNNEL_ARGV_JSON` also remains available as a temporary environment override for advanced/debug use. Persistent manual argv config still rejects detectable literal credentials.

---

## Upgrade

Upgrade from an explicit release directory:

```sh
rootbound upgrade --from /path/to/new/rootbound-release
```

The upgrade path:

- stops the runtime first;
- uses staged installation;
- validates before activation;
- preserves the external state tree;
- rolls back the app install when activation fails.

Rootbound intentionally does not invent an implicit network updater in V5.

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

### Codex interruption / quota rescue

- `codex.continuity_resume`
- `codex.quota_status`
- `codex.continuity_handoff`
- `codex.continuity_rollback`
- `codex.continuity_search`

The preferred product flow is deliberately small:

```text
Codex interrupted / quota exhausted
        ↓
@Rootbound continue
        ↓
Rootbound finds and verifies the persisted Codex session
        ↓
ChatGPT continues with the current local worktree
        ↓
Rootbound can inject a verified handoff into the original Codex thread
```

`continuity_resume` ranks persisted sessions using the canonical project root, repository identity when available, branch, compatible Git SHA and `recency_at`. A thread started from a subdirectory of the same Git root can still match. Exact/compatible matches continue directly; genuinely ambiguous matches return candidates instead of guessing.

The resume payload is bounded: Rootbound projects recent visible history plus current worktree facts rather than dumping an entire transcript. The original Codex thread remains available as cold memory through `continuity_search`, using occurrence search when supported and bounded visible-history fallbacks otherwise.

Rootbound keeps the durable continuity binding as internal plumbing. The product flow uses an opaque `rescueRef`. ChatGPT should propagate that ref silently between Rootbound tools when needed; the user should never need to copy a binding or rescue identifier.

Quota state is **advisory**. Resume continues to work when quota state is missing, changed, or still available. Rootbound does not start a Codex model turn to inspect quota or history.

During a rescue, write-capable Rootbound operations are checked against the last known worktree fingerprint. Unexpected branch/HEAD/file drift fails closed and forces reinspection before another write or handoff.

`continuity_rollback` never uses `git reset` and never rewinds work that existed before the rescue. Rootbound snapshots supported files around guarded `precise_edit` / `apply_patch` mutations and restores them only while SHA/existence guards still match. Arbitrary write-capable commands, sensitive/unsupported snapshots, very large degraded worktrees, or low-level undo/redo deliberately change rescue rollback coverage to `partial`; in that state a global rescue rollback is refused rather than pretending it is safe.

`continuity_handoff` revalidates the original thread/project authority, injects a bounded checkpoint into that persisted thread without starting a model turn, and reports the current worktree, observable commits, journaled activity, remaining work supplied by ChatGPT, and current quota state.

### Browser Reader

- `codex.browser_status`
- `codex.browser_tabs`
- `codex.browser_read`

The public Browser Reader remains read-first. Arbitrary clicking / typing / navigation is not part of this public contract.

---

## Security model

Rootbound is designed to fail closed around the local Codex authority.

- remote callers cannot select a stronger permission profile than the local ceiling;
- nested Codex CLI launches from the model-free command lane are rejected;
- project trust is exact-root and explicit;
- trust mutation is backed up and rollback-capable;
- guided tunnel setup validates before trust mutation;
- the guided tunnel runtime key is kept out of `tunnel.json`, SQLite, process argv and Rootbound logs;
- durable argv containing detectable credentials is refused;
- manual tunnel templates cannot persist detectable literal credentials;
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
  "surfaceVersion": "rootbound-public-preview-v5"
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

The durable implementation plan / acceptance checklist lives in [`docs/plans/rootbound-v5.md`](docs/plans/rootbound-v5.md).

The core V5 release suite and macOS guided setup/lifecycle have passed during stabilization. The quota-rescue branch also passes the model-free sandbox release gate; real ChatGPT acceptance of the newly installed 32-tool surface and supported-Windows validation remain before release.

Known release-validation work still includes real ChatGPT acceptance of the quota-rescue flow through the supervised tunnel, one controlled Windows validation run, and final documentation/package review before merge.

---

## Project status

Rootbound is an independent project. It is not an OpenAI product and does not imply OpenAI endorsement.

> **Keep working in ChatGPT. Use Codex when you explicitly need Codex.**
