<div align="center">

# Rootbound

### Give ChatGPT safe local coding access through Codex.

**Apple Silicon macOS Technical Preview**

Current preview: **0.1.0-preview.1**

Windows support is implemented in parts of the codebase but is **not part of this public preview yet**. Real-machine Windows validation is still pending.

</div>

Rootbound connects ChatGPT to a real project on your Mac while keeping Codex as the local trust, sandbox, permission, and execution authority.

> **ChatGPT reasons. Rootbound performs model-free local actions. Codex keeps control of local trust and permissions.**

Rootbound is useful when you want ChatGPT to inspect, edit, test, commit, and continue work in the same local codebase you already use with Codex — without secretly delegating the reasoning to another Codex model.

---

## What is new in 0.1.0-preview.1?

This preview turns Rootbound from a single-tunnel local bridge into a more durable daily-driver runtime.

### Multiple ChatGPT / OpenAI connections on one Mac

Rootbound can persist several tunnel connections and switch between them without clearing your current setup or re-entering every credential.

```sh
rootbound connection list
rootbound connection current
rootbound connection add work
rootbound connection switch work
rootbound connection repair work
rootbound connection remove work
```

Each scoped connection keeps its tunnel configuration and runtime key isolated. Switching a running connection is transactional: Rootbound validates the target, restarts the same project on it, waits for `/readyz`, and restores the previous runtime if the switch fails.

Rootbound calls these **connections**, not ChatGPT accounts. It does not store ChatGPT emails, ChatGPT OAuth tokens, or Codex OAuth credentials in the connection registry.

See [`docs/multi-connection.md`](docs/multi-connection.md) for the detailed lifecycle and safety model.

### Durable rescue across ChatGPT conversations

If Codex is interrupted or reaches quota:

```text
@Rootbound continue
```

Rootbound can start a rescue session tied to the real project, thread, and worktree state.

If that ChatGPT conversation later disappears, a new ChatGPT conversation can call `@Rootbound continue` again and reattach to the same active rescue when Rootbound can prove that the thread and worktree still match.

If the project drifted, the thread conflicts, or the state cannot be proven safe, Rootbound fails closed instead of silently attaching to the wrong work.

### Verified continuity manifests

A handoff back to Codex is no longer only a prose summary.

Rootbound builds a versioned `rootbound.continuity.v1` manifest that separates:

- **verified state** — Git/worktree fingerprints, observed mutations, commits, command/activity evidence;
- **reported context** — summary, decisions, and remaining work supplied by ChatGPT.

The manifest is canonicalized and SHA-256 verified before persistence/injection. Tampered manifests are rejected.

### Quota rescue Autopilot

Rootbound can watch Codex quota state and pre-arm a likely rescue candidate before the limit is reached.

The pre-arm cache is never authoritative. `@Rootbound continue` still revalidates the candidate thread and worktree before using it. Stale candidates expire, real quota recovery disarms them, and unknown/auth-failed quota reads do not destructively change the current state.

### Better compatibility and diagnostics

Rootbound now includes:

```sh
npm run probe:codex -- --cwd /path/to/project
```

This probes the installed Codex/App Server build against Rootbound's critical model-free capabilities without starting a Codex model turn.

The current Apple Silicon macOS compatibility gate explicitly accepts the locally verified ChatGPT-bundled `codex-cli 0.149.0-alpha.4`. Unknown future builds remain fail-closed until re-accepted.

`rootbound doctor` also reports the actual failed prerequisite instead of hiding a Codex/version failure behind a generic project-validation message.

### Clearer runtime logs

```sh
rootbound logs --follow
rootbound logs --follow --new-only
```

Follow mode separates historical log tail from entries generated after the command starts, which makes tunnel/runtime debugging much less ambiguous.

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
@Rootbound inspect this project and explain the architecture
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

You need Node.js `v22.13.0` or newer.

Rootbound uses your local Codex installation as the trust and sandbox layer. It does not install or replace Codex for you.

Install the supported OpenAI `tunnel-client` from:

```text
https://platform.openai.com/settings/organization/tunnels
```

Then verify:

```sh
tunnel-client --help
```

## 2. Install Rootbound

Clone the repository:

```sh
git clone https://github.com/LeoMbm/Rootbound.git
cd Rootbound
```

Install on Apple Silicon macOS:

```sh
sh ./bin/rootbound-install.sh
```

The installer checks Node/Codex, installs the app into your user Library, installs production dependencies, and creates a `rootbound` CLI link under `~/.local/bin`.

If the installer updated your `PATH`, close Terminal and open a new Terminal window.

Verify:

```sh
rootbound version
```

### Windows

Windows support is not part of this public Technical Preview yet. Windows-specific implementation remains in the repository for ongoing validation.

## 3. Connect the project you want ChatGPT to work on

Move into your own project first:

```sh
cd ~/Documents/Dev/my-app
rootbound connect .
```

This is the **Normal setup: one command**. The **guided one-command** flow handles tunnel setup, exact-root Codex trust, Rootbound's runtime-only permission contract, project registration, validation, and runtime startup.

You may see Node's `SQLite is an experimental feature` warning. That warning by itself does not mean Rootbound failed.

### Tunnel setup

Rootbound detects/reuses an existing compatible tunnel when possible. Otherwise it guides you to create one and asks for its `tunnel_...` ID.

It also asks once for a tunnel Runtime API key. The runtime key is stored in dedicated private local state rather than in `tunnel.json`, SQLite, normal logs, or persistent process argv.

Rootbound validates the tunnel before changing Codex trust.

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

Open ChatGPT settings and create a custom MCP app/connector using **Connection: Tunnel**.

Select or paste the same `tunnel_...` ID Rootbound is currently using.

For a single connection, inspect it with:

```sh
rootbound tunnel show
```

For multiple saved connections, use:

```sh
rootbound connection current
```

Rootbound can validate its local side, but it cannot reliably inspect which tunnel the ChatGPT UI currently selected. The ChatGPT connector must point to the same tunnel as the active Rootbound connection.

## 5. Test it

From ChatGPT:

```text
@Rootbound open my workspace and show me the current Git status
```

Then:

```text
@Rootbound find the main entry point of this project and explain it to me
```

For a write flow:

```text
@Rootbound update the README, show me the diff, commit it, and push it
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

Rootbound has one supervised active project runtime at a time. Connecting/starting another registered project switches that runtime.

```sh
rootbound start /path/to/project
rootbound status
rootbound stop
```

## Use several ChatGPT / OpenAI tunnel connections

List them:

```sh
rootbound connection list
rootbound connection current
```

Add another:

```sh
rootbound connection add work
```

Switch:

```sh
rootbound connection switch work
```

Rotate a revoked runtime key without recreating the connection:

```sh
rootbound connection repair work
```

Remove a stopped/unused connection:

```sh
rootbound connection remove work
```

If Rootbound is running, a connection switch keeps the actual running project, starts it on the target connection, requires `/readyz`, and restores the previous runtime if the target cannot become ready.

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

### Pre-existing dirty work

Uncommitted work that existed before rescue is part of the baseline.

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

Check:

```sh
rootbound status
rootbound connection current
```

Make sure ChatGPT is using the same tunnel ID as the active Rootbound connection.

## Runtime key was revoked

For a scoped connection:

```sh
rootbound connection repair <name>
```

Repair validates the replacement before committing it and restores the previous key/config if validation fails.

## Codex auto-updated and Rootbound refuses it

Run:

```sh
npm run probe:codex -- --cwd /path/to/trusted/project
```

The probe bypasses only the exact-version allowlist for evaluation; it still exercises the actual Rootbound authority and model-free capability checks. Do not manually widen the production allowlist until that exact build has been verified.

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

Install dependencies:

```sh
npm ci
```

Focused suite:

```sh
npm run test:v5
```

Full suite:

```sh
npm test
```

Release gate:

```sh
npm run validate:release
```

Probe a newly installed Codex build before widening the exact version gate:

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
