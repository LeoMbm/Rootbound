<div align="center">

# Rootbound

### Give ChatGPT safe local coding access through Codex.

**Apple Silicon macOS Technical Preview**

Current preview: **0.1.0-preview.2**

Windows support is implemented in parts of the codebase but is **not part of this public preview yet**. Real-machine Windows validation is still pending.

</div>

Rootbound connects ChatGPT to a real project on your Mac while keeping Codex as the local trust, sandbox, permission, and execution authority.

> **ChatGPT reasons. Rootbound performs model-free local actions. Codex keeps control of local trust and permissions.**

Rootbound is useful when you want ChatGPT to inspect, edit, test, commit, and continue work in the same local codebase you already use with Codex — without secretly delegating the reasoning to another Codex model.

---

## What is new in 0.1.0-preview.2?

`0.1.0-preview.2` is a compatibility hotfix for fast-moving ChatGPT-bundled Codex builds.

### Rootbound no longer bricks on every compatible Codex auto-update

Older previews exact-version-gated the bundled Codex executable before Rootbound could inspect what that build actually supported. A compatible ChatGPT auto-update such as:

```text
codex-cli 0.149.0-alpha.4
        ↓
codex-cli 0.149.0-alpha.4.1
```

could therefore make `rootbound connect .` fail even though the required Codex App Server contract still worked.

On **Apple Silicon macOS**, Rootbound now separates discovery from trust:

```text
Codex executable discovered
        ↓
known verified build?
   ├─ yes → normal fast path
   └─ no
        ↓
model-free runtime capability probe
        ↓
App Server bootstrap + permission profiles
exact trusted project root
:read-only downscope
model-free command/exec marker
        ↓
PASS → accept that exact build for this process only
FAIL → fail closed
```

Unknown builds are **not** added to a wildcard semver range and are **not** persisted as durable trust. A later binary/version change is probed again. Windows and unsupported platforms remain exact-version/fail-closed for unknown builds.

You can inspect the same compatibility contract manually with:

```sh
npm run probe:codex -- --cwd /path/to/trusted/project
```

`rootbound doctor` reports whether compatibility came from the built-in policy or from the runtime capability probe. Neither path intentionally starts a Codex model turn.

### Also included from preview.1

- multiple isolated ChatGPT/OpenAI tunnel connections with transactional switching;
- durable rescue reattachment across ChatGPT conversations;
- SHA-256 verified continuity manifests;
- quota rescue Autopilot;
- clearer runtime logs;
- precise Doctor prerequisite errors;
- the same **32 public tools** on `rootbound-public-preview-v5`.

See [`docs/multi-connection.md`](docs/multi-connection.md) and [`docs/continuity-runtime.md`](docs/continuity-runtime.md) for the detailed runtime contracts.

---

# How Rootbound works

```text
ChatGPT
   ↓
Rootbound public MCP surface
   ↓
model-free local primitives
   ↓
Codex App Server permissions / sandbox
   ↓
Your project, Git repo and local commands
```

You can ask ChatGPT things like:

```text
@Rootbound find where authentication is handled
```

```text
@Rootbound fix the failing tests and run them again
```

```text
@Rootbound show me what changed in Git
```

```text
@Rootbound continue
```

Rootbound does **not** expose a public Codex model/agent lane. ChatGPT remains the reasoning model.

---

# Beginner setup — from zero

You do not need to understand MCP, JSON-RPC, SQLite, tunnel profiles, or Codex App Server internals.

The normal setup has five parts:

```text
1. Install the prerequisites
2. Install Rootbound
3. Connect a local project
4. Add the matching tunnel in ChatGPT
5. Test it
```

## 1. Prerequisites

Rootbound currently requires:

- **Git**
- **Node.js 22.13 or newer**
- **Codex installed locally**
- OpenAI **`tunnel-client`**
- a ChatGPT account/workspace that can use the required custom MCP app/connector actions

Check Git and Node:

```sh
git --version
node --version
```

Rootbound uses your local Codex installation as the trust and sandbox layer. It does not install or replace Codex for you.

## 2. Install Rootbound

```sh
git clone https://github.com/LeoMbm/Rootbound.git
cd Rootbound
sh ./bin/rootbound-install.sh
```

The installer checks Node/Codex, stages the app under your user Library, installs production dependencies, and creates a `rootbound` CLI link under `~/.local/bin`.

Verify:

```sh
rootbound version
```

### Windows

Windows support is not part of this public Technical Preview yet. Windows-specific implementation remains in the repository for ongoing validation.

## 3. Connect the project you want ChatGPT to work on

```sh
cd ~/Documents/Dev/my-app
rootbound connect .
```

This is the **Normal setup: one command**. The **guided one-command** flow handles tunnel setup, exact-root Codex trust, Rootbound's runtime-only permission contract, project registration, validation, and runtime startup.

You may see Node's `SQLite is an experimental feature` warning. That warning by itself does not mean Rootbound failed.

### Rootbound local permissions

Normal Codex `:workspace` protects Git metadata such as `.git/index.lock`. Rootbound therefore uses a **runtime-only named Codex profile** called `rootbound` for complete Git workflows.

The profile extends `:workspace`, grants `.git` write access inside the active workspace, enables outbound network access, and keeps local binding disabled.

The profile is injected only into Codex App Server processes launched by Rootbound and is **never written into `~/.codex/config.toml`**.

A successful first approval includes output similar to:

```text
Permissions: approved runtime-only rootbound
```

Remote callers can request only the public Rootbound `readOnly` / `inherit` behavior; they cannot select an arbitrary stronger Codex profile.

### Exact-root trust

Rootbound asks for explicit Codex trust for the exact project root. A backup of the Codex config is created before trust mutation.

Successful setup looks similar to:

```text
Rootbound is ready.
Project: /Users/you/Documents/Dev/my-app
Trust: added exact-root trust
Permissions: approved runtime-only rootbound
Tunnel: configured
Runtime: running
```

## 4. Add Rootbound to ChatGPT

Open ChatGPT settings and create a custom MCP app/connector using **Connection: Tunnel**. Select the same tunnel ID Rootbound is currently using.

Inspect the active connection with:

```sh
rootbound connection current
```

Rootbound can validate its local side, but it cannot reliably inspect which tunnel the ChatGPT UI currently selected.

## 5. Test it

From ChatGPT:

```text
@Rootbound open my workspace and show me the current Git status
```

Local health checks:

```sh
rootbound status
rootbound self-test .
rootbound doctor .
```

Doctor and self-test do not intentionally start a Codex model turn.

---

# Daily use

## Reopen or switch project

```sh
cd ~/Documents/Dev/my-app
rootbound connect .
```

Rootbound has one supervised active project runtime at a time. Connecting or starting another registered project switches that runtime.

```sh
rootbound start /path/to/project
rootbound status
rootbound stop
```

## Multiple tunnel connections

```sh
rootbound connection list
rootbound connection current
rootbound connection add work
rootbound connection switch work
rootbound connection repair work
rootbound connection remove work
```

Each scoped connection keeps its tunnel configuration and runtime key isolated. A running connection switch is transactional: Rootbound validates the target, restarts the same project, requires `/readyz`, and restores the previous runtime if the switch fails.

Rootbound calls these **connections**, not ChatGPT accounts. It does not store ChatGPT emails, ChatGPT OAuth tokens, or Codex OAuth credentials in the connection registry.

## Runtime logs

```sh
rootbound logs
rootbound logs --follow
rootbound logs --follow --new-only
```

`--new-only` separates historical log tail from entries generated after follow mode begins.

---

# Continue after Codex is interrupted

The primary rescue entry point is:

```text
@Rootbound continue
```

The flow is:

```text
Codex work is interrupted / quota is exhausted
        ↓
Rootbound selects or consumes a pre-armed candidate
        ↓
project + repo + thread + worktree are revalidated
        ↓
existing durable rescue is reattached, or a new rescue starts
        ↓
ChatGPT receives bounded recent context + real local state
        ↓
ChatGPT continues the work
        ↓
Rootbound creates a verified handoff manifest
        ↓
verified checkpoint is injected back into the original Codex thread
```

A later ChatGPT conversation can reattach to the same rescue if the saved rescue, original thread, and current worktree still agree.

Rootbound refuses ambiguous thread selection, conflicting drift, unsafe rollback, and tampered manifests.

For supported Rootbound mutations, `codex.continuity_rollback` restores only safely snapshotted Rootbound-owned rescue mutations. Rootbound does not implement rescue rollback with `git reset`.

---

# Everyday CLI reference

```sh
rootbound connect .
rootbound start /path/to/project
rootbound status
rootbound stop

rootbound project list
rootbound project remove /path/to/project
rootbound project remove /path/to/project --remove-trust
rootbound trust remove /path/to/project

rootbound connection list
rootbound connection current
rootbound connection add work
rootbound connection switch work
rootbound connection repair work
rootbound connection remove work

rootbound logs
rootbound logs --follow
rootbound logs --follow --new-only

rootbound self-test .
rootbound diagnostic
```

Upgrade from another release directory:

```sh
rootbound upgrade --from /path/to/rootbound-release
```

Rootbound keeps persistent state outside the installed app tree, so a staged upgrade does not replace project/continuity state.

---

# Public tool surface

The current surface exposes **32 public tools**.

Current surface identifier: `rootbound-public-preview-v5`.

### Workspace and context

- `codex.workspace_open`
- `codex.project_context`
- `codex.skill_list`
- `codex.skill_read`

### Repository inspection

- `codex.repo_search`
- `codex.read_many`
- `codex.git_status`
- `codex.git_diff`

### Editing

- `codex.apply_patch`
- `codex.precise_edit`
- `codex.edit_undo`
- `codex.edit_redo`

### Commands

- `codex.command_exec`
- `codex.command_start`
- `codex.command_poll`
- `codex.command_write`
- `codex.command_terminate`

Nested Codex CLI/model launches are refused on the model-free command lane.

### Codex history and durable continuity

- `codex.thread_list`
- `codex.thread_read`
- `codex.thread_items`
- `codex.continuity_bind`
- `codex.continuity_status`
- `codex.continuity_checkpoint`
- `codex.continuity_unbind`

### Rescue / continuation

- `codex.continuity_resume`
- `codex.continuity_search`
- `codex.continuity_rollback`
- `codex.continuity_handoff`
- `codex.quota_status`

`codex.continuity_resume` is the preferred entry point for interruption/quota rescue. `codex.continuity_handoff` persists and injects the bounded verified handoff without starting a model turn. `codex.continuity_rollback` fails closed unless rollback coverage is provably safe.

### Browser Reader

- `codex.browser_status`
- `codex.browser_tabs`
- `codex.browser_read`

Browser Reader is intentionally read-only in the public surface.

---

# Safety model

Rootbound is intentionally fail-closed.

- exact-root trust is explicit;
- public callers cannot widen the local permission ceiling;
- the Rootbound permission profile is process-local;
- connection runtime keys stay outside registry metadata, normal logs, diagnostics, and public status output;
- new scoped tunnel connections require `/readyz` before becoming active;
- connection switches, repair, removal, start/stop, and tunnel mutation are serialized to avoid runtime races;
- common secret-bearing files are excluded from ordinary read/search flows unless explicitly requested;
- diagnostics redact credentials, home paths, and sensitive thread information;
- drift and rollback conflicts stop instead of guessing;
- continuity manifests are integrity checked;
- unknown Apple Silicon macOS Codex builds must pass the model-free capability probe before current-process use;
- no public Rootbound tool silently starts a Codex model turn.

See [`SECURITY.md`](SECURITY.md) for the complete boundary.

---

# Persistence

On macOS, Rootbound keeps application and durable state separate:

```text
~/Library/Application Support/Rootbound/
├── app/
├── state/
│   ├── rootbound.sqlite3
│   ├── connection-registry.json
│   └── connections/
├── runtime/
├── logs/
└── backups/
```

Existing pre-multi-connection tunnel files are preserved as the legacy/default connection rather than destructively migrated.

The multi-connection feature does **not** bump the Rootbound SQLite schema.

---

# Common problems

## `rootbound: command not found`

The CLI normally lives at:

```text
~/.local/bin/rootbound
```

If installation updated your shell profile, open a new Terminal window.

## Connector exists but calls fail

```sh
rootbound status
rootbound connection current
```

Make sure ChatGPT is using the same tunnel ID as the active Rootbound connection.

## Runtime key was revoked

```sh
rootbound connection repair <name>
```

Repair validates the replacement before committing it and restores the previous key/config if validation fails.

## Codex auto-updated

On Apple Silicon macOS, `rootbound connect .` automatically capability-probes an unknown bundled Codex build before use. A compatible build can proceed for the current process without modifying the built-in allowlist.

For an explicit diagnostic:

```sh
npm run probe:codex -- --cwd /path/to/trusted/project
```

If the capability probe fails, Rootbound fails closed. Do not manually add wildcard version ranges to the production policy.

## Project moved or was renamed

Run `rootbound connect .` from the new canonical root. Rootbound intentionally avoids treating stale paths as the same workspace without revalidation.

---

# Advanced / manual tunnel configuration

Most users should use:

```sh
rootbound connect .
```

Manual configuration is an operator/debug escape hatch:

```sh
rootbound tunnel configure --argv-json '["tunnel-client","run","--profile","my-profile"]'
rootbound tunnel show
rootbound tunnel clear
```

`ROOTBOUND_TUNNEL_ARGV_JSON` remains available as an advanced/environment-only override. Explicit saved connections take precedence so a stale global environment override cannot silently redirect a connection switch.

Persistent manual tunnel configuration rejects detectable literal credentials.

---

# Non-interactive setup

```sh
CONTROL_PLANE_TUNNEL_ID=tunnel_... \
CONTROL_PLANE_API_KEY=... \
rootbound connect . --yes
```

`--yes` records consent for the current Rootbound runtime permission contract. Use it only where that authority has already been intentionally approved.

Register/trust without starting the runtime:

```sh
rootbound connect . --yes --no-start
```

---

# Development and release validation

```sh
npm ci
npm run test:v5
npm test
npm run validate:release
```

Probe the currently installed Codex build explicitly:

```sh
npm run probe:codex -- --cwd /path/to/trusted/project
```

The canonical public tool list lives in [`src/surface-contracts.mjs`](src/surface-contracts.mjs).

The detailed V5 acceptance plan lives in [`docs/plans/rootbound-v5.md`](docs/plans/rootbound-v5.md).

---

## License

Apache-2.0.

Rootbound is an independent project. It is not an OpenAI product and does not imply OpenAI endorsement.

## Shoutout

Shoutout to [@liyana31811](https://github.com/liyana31811), creator of [Codexless](https://github.com/liyana31811/Codexless). Their work was an early source of inspiration while Rootbound was taking shape.

> **Keep working in ChatGPT. Use Codex when you explicitly need Codex.**
