<div align="center">

# Rootbound

### Give ChatGPT safe local coding access through Codex.

**Apple Silicon macOS Technical Preview**

Windows support is implemented in parts of the codebase but is **not part of this public preview yet**. Real-machine Windows validation is still pending.

</div>

Rootbound lets ChatGPT inspect, edit, test, and continue work on a project that lives on your computer, while Codex remains the local permission and sandbox authority.

It is especially useful when you already work with both ChatGPT and Codex and want them to share the same local project safely.

> **ChatGPT reasons. Rootbound performs model-free local actions. Codex keeps control of local trust and permissions.**

---

## What does Rootbound actually do?

Without Rootbound, ChatGPT cannot directly work inside a project on your laptop.

With Rootbound:

```text
ChatGPT
   ↓
Rootbound
   ↓
Codex local permissions / sandbox
   ↓
Your files, Git repo and local commands
```

This means you can ask ChatGPT things like:

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

Rootbound does **not** secretly ask a Codex model to do the reasoning. ChatGPT remains the reasoning model.

### The other big use case: continue interrupted Codex work

If a Codex conversation is interrupted, unavailable, or hits quota, open ChatGPT and say:

```text
@Rootbound continue
```

Rootbound can find the matching persisted Codex conversation, verify that it belongs to the current project, inspect the real worktree, let ChatGPT continue the work, and later hand the verified state back to that same Codex thread.

---

# Beginner setup — from zero

This section assumes you have **never installed Rootbound before**.

You do not need to understand MCP, JSON-RPC, SQLite, tunnel profiles, or Codex App Server internals.

The setup has five parts:

```text
1. Install the prerequisites
2. Install Rootbound
3. Connect one local project
4. Add the Rootbound tunnel in ChatGPT
5. Test it
```

Once this first setup is done, normal daily use is much shorter.

### The whole flow at a glance

If you only want the map before reading the details, it is this:

```text
Install Git + Node + Codex + tunnel-client
                ↓
Clone and install Rootbound
                ↓
cd into YOUR project
                ↓
rootbound connect .
                ↓
Approve the exact project + Rootbound local permissions
                ↓
Add a ChatGPT custom connector using the same tunnel_... ID
                ↓
Ask ChatGPT: @Rootbound show me the Git status
```

---

## Step 1 — Install the prerequisites

Rootbound currently requires:

- **Git**
- **Node.js 22.13 or newer**
- **Codex installed locally**
- OpenAI **`tunnel-client`**
- a ChatGPT account/workspace that can use custom MCP apps/connectors with the actions you need

### 1.1 Check Node.js

First make sure Git is available:

```sh
git --version
```

Then check Node.js.

Open Terminal on macOS:

```sh
node --version
```

You need at least:

```text
v22.13.0
```

If `node` is not found, install a current Node.js release first.

### 1.2 Make sure Codex is installed

Rootbound uses your local Codex installation as the trust and sandbox layer.

You do **not** need to configure Rootbound inside Codex manually. The Rootbound installer detects the supported local Codex installation automatically.

If Codex is missing, the installer will stop instead of installing or replacing it for you.

### 1.3 Install OpenAI `tunnel-client`

ChatGPT cannot call a localhost MCP server directly. Rootbound therefore uses OpenAI Secure MCP Tunnel so the connection stays outbound-only from your machine.

Open the OpenAI Tunnels page:

```text
https://platform.openai.com/settings/organization/tunnels
```

Install the supported `tunnel-client` for your platform from there.

Then verify that it is available:

```sh
tunnel-client --help
```

If that command works, continue.

> You do not need to manually write a tunnel YAML profile for Rootbound. `rootbound connect .` creates and manages the Rootbound **tunnel-client profile** for you. This is separate from the Codex permission profile explained later.

---

## Step 2 — Download and install Rootbound

### 2.1 Clone the repository

```sh
git clone https://github.com/LeoMbm/Rootbound.git
cd Rootbound
```

### 2.2 Install on Apple Silicon macOS

```sh
sh ./bin/rootbound-install.sh
```

The installer:

- checks Node.js;
- locates Codex;
- installs Rootbound into your user Library;
- installs production dependencies;
- creates a `rootbound` CLI link under `~/.local/bin`;
- adds that directory to your shell profile only if necessary.

If the installer says it updated your `PATH`, **close Terminal and open a new Terminal window** before continuing.

Verify the install:

```sh
rootbound version
```

### Windows

Windows support is not part of this public Technical Preview yet. The repository contains Windows-specific implementation work, but it has not completed the same real-machine acceptance required for release.

Do not treat the current Windows paths/scripts as a supported public install until the Windows validation checklist is green.

---

## Step 3 — Connect the project you actually want ChatGPT to work on

Do **not** run the next command from the Rootbound repository unless Rootbound itself is the project you want ChatGPT to edit.

Move into your own project first.

Example:

```sh
cd ~/Documents/Dev/my-app
```

Then run:

```sh
rootbound connect .
```

You may see a Node warning saying that SQLite is experimental. That warning comes from the Node.js SQLite API used by Rootbound and does **not** mean setup failed. Continue unless Rootbound itself prints an error.

This is the **Normal setup: one command**. The guided one-command flow handles the tunnel, Codex trust, project registration, validation, and runtime startup.

### What happens the first time?

Rootbound first checks that `tunnel-client` exists.

You should see something similar to:

```text
Rootbound setup
Checking ChatGPT tunnel prerequisites...
✓ tunnel-client detected
```

### If you already have an OpenAI tunnel

Rootbound tries to discover it automatically.

If exactly one compatible tunnel is found, it can offer to reuse it:

```text
Existing OpenAI tunnel found: tunnel_...
Use this tunnel? [Y/n]
```

Press **Enter** or type `y` to reuse it.

### If you do not have a tunnel yet

Rootbound prints the OpenAI Tunnels page:

```text
No existing OpenAI tunnel was detected.
Create or inspect one here:
  https://platform.openai.com/settings/organization/tunnels

Paste tunnel ID:
```

Open that page, create a tunnel, then copy its ID.

It looks like:

```text
tunnel_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

Paste that ID back into Terminal.

### Rootbound will then ask for a runtime API key

This key is used by `tunnel-client` to use the tunnel. It is **not** your tunnel ID.

Rootbound prints the correct page:

```text
A Tunnel runtime API key is required once.
Create or inspect it here:
  https://platform.openai.com/settings/organization/api-keys

Paste runtime API key (input hidden):
```

Create or select a runtime API key that has access to the tunnel, then paste it.

Your input is hidden while you paste it.

Rootbound stores this runtime key in dedicated private local state instead of putting it in the tunnel profile, SQLite database, command arguments, or normal logs.

### Rootbound validates the tunnel before touching Codex trust

You should then see:

```text
Validating tunnel configuration...
✓ Tunnel ready (tunnel_...)
```

If validation fails, Rootbound rolls back the generated tunnel setup instead of continuing with a half-configured project.

### Rootbound then asks for its dedicated local permission set

Normal Codex `:workspace` access protects Git metadata such as `.git/index.lock`. Rootbound therefore uses a dedicated local Codex profile for complete Git workflows such as:

```text
git add
git commit
git push
```

The first time, Rootbound asks before enabling it for Rootbound:

```text
Rootbound local permissions
Rootbound uses a dedicated runtime-only Codex permission profile so it can stage/commit
Git changes and run outbound commands such as git push.
The profile extends :workspace, grants write access to .git inside the active workspace,
enables outbound network access, and is injected only into Codex App Server processes
launched by Rootbound.
It does not modify ~/.codex/config.toml or Codex's global/default permission profile.

Allow Rootbound to use these local permissions? [Y/n]
```

The runtime-only profile is named `rootbound`. It extends `:workspace`, explicitly allows `.git` writes inside the active workspace, enables outbound network access, and keeps local port binding disabled.

Rootbound does **not** write this profile into `~/.codex/config.toml`. It injects the profile as process-local `-c` overrides only into Codex App Server processes launched by Rootbound. The temporary `default_permissions = ":workspace"` override exists only inside those processes because Codex requires an explicit default when custom permission profiles are present.

Your normal Codex configuration and global/default permission profile remain unchanged. A remote ChatGPT call still cannot choose an arbitrary Codex permission profile; public commands expose only `readOnly` or `inherit`.

Press **Enter** or type `y` if you want Rootbound to perform normal Git write/network workflows in the connected project.

### Rootbound then asks for exact project trust

Example:

```text
Project access
Rootbound needs explicit Codex trust for exactly:
  /Users/you/Documents/Dev/my-app

Allow this exact project root? [Y/n]
```

Press **Enter** or type `y` if this is the project you intended to connect.

Rootbound creates a backup of the Codex config before changing trust.

It then validates the project, registers it locally, and starts the supervised Rootbound runtime.

### Successful output

At the end you should see something similar to:

```text
Rootbound is ready.
Project: /Users/you/Documents/Dev/my-app
Trust: added exact-root trust
Permissions: approved runtime-only rootbound
Tunnel: configured
Runtime: running
ChatGPT connector settings: https://chatgpt.com/#settings/Connectors
```

At this point the local side is ready.

Rootbound can now perform ordinary Git write operations through the approved runtime profile, including `git add`, `git commit`, and outbound operations such as `git push` when you explicitly ask ChatGPT to do them.

---

## Step 4 — Add Rootbound to ChatGPT

Keep the Rootbound runtime running on your computer.

Open the URL printed by Rootbound:

```text
https://chatgpt.com/#settings/Connectors
```

Depending on the current ChatGPT UI, this area may be named **Apps**, **Connectors**, or **Custom apps**.

### 4.1 Enable developer/custom MCP access if ChatGPT asks for it

If your account or workspace requires Developer Mode for custom MCP apps, enable it in ChatGPT settings first.

Availability of custom MCP apps and write/modify actions depends on your current ChatGPT plan and workspace settings.

### 4.2 Create the custom app / connector

Create a new custom MCP app or connector and name it something recognizable, for example:

```text
Rootbound
```

### 4.3 Choose the tunnel connection

For the connection type, choose:

```text
Connection: Tunnel
```

Then either:

- select the tunnel from the list; or
- paste the **same `tunnel_...` ID** that Rootbound used in Step 3.

If you do not remember the tunnel ID, run:

```sh
rootbound tunnel show
```

For a Rootbound-managed tunnel, the output includes:

```text
Tunnel: configured
Tunnel ID: tunnel_...
```

Save/enable the connector.

> The tunnel in ChatGPT and the tunnel used by Rootbound must be the same tunnel ID.

### If your tunnel does not appear in ChatGPT

Check these points:

- the tunnel was created for the correct OpenAI / ChatGPT workspace;
- your account has permission to **Read + Use** that tunnel;
- Rootbound is still running locally;
- the tunnel was created long enough ago to finish provisioning;
- `rootbound status` reports the runtime as running.

New OpenAI tunnels can take a short time to appear in the connector picker.

---

## Step 5 — Test Rootbound from ChatGPT

Open a normal ChatGPT conversation with the Rootbound connector available.

Try a read-only request first:

```text
@Rootbound open my workspace and show me the current Git status
```

Then try:

```text
@Rootbound find the main entry point of this project and explain it to me
```

If those work, your setup is complete.

You can then test a write workflow explicitly, for example:

```text
@Rootbound update the README, show me the diff, commit it, and push it
```

Rootbound will execute those local Git commands through the approved runtime-only Codex profile; ChatGPT still performs the reasoning.

For a local health check you can also run:

```sh
rootbound status
```

and:

```sh
rootbound self-test .
```

`self-test` checks the accepted Codex/App Server path, read access, model-free command execution, and temporary write/read/delete behavior when your local Codex permission profile allows it.

It does not start a Codex model turn.

---

# Daily use

After the first setup, you normally do **not** repeat all of the steps above.

## Reopen a project you already connected

Go to the project:

```sh
cd ~/Documents/Dev/my-app
```

Then run:

```sh
rootbound connect .
```

If the tunnel and exact project trust are already configured, Rootbound reuses them and starts/switches the runtime for that project.

You do not need to create a new ChatGPT connector every time.

## Connect a second project

Go to the other project and run the same command once:

```sh
cd ~/Documents/Dev/another-app
rootbound connect .
```

Rootbound has one supervised active project runtime at a time. Connecting or starting another registered project switches the runtime to that project.

Your ChatGPT Rootbound connector can stay the same because it points to the same secure tunnel.

## Start an already registered project explicitly

```sh
rootbound start /path/to/project
```

If Rootbound was upgraded to a version whose local permission contract changed, `start` may tell you to run `rootbound connect .` once first. That is intentional: Rootbound requires fresh local consent before using a changed `.git` / network permission contract.

## Check which project is active

```sh
rootbound status
```

## Stop Rootbound

```sh
rootbound stop
```

---

# Continue after Codex is interrupted

This is the main continuity flow Rootbound was built around.

Imagine you were working in Codex and the conversation stopped halfway through a task.

You can open ChatGPT and simply say:

```text
@Rootbound continue
```

The intended flow is:

```text
Codex work is interrupted
        ↓
@Rootbound continue
        ↓
Rootbound finds the matching persisted Codex thread
        ↓
Rootbound verifies project / repository / branch / worktree continuity
        ↓
ChatGPT receives bounded recent context + current local state
        ↓
ChatGPT continues the work locally
        ↓
Rootbound can hand the result back to the original Codex thread
```

Rootbound can also search older visible messages from that original Codex conversation on demand when ChatGPT needs more context.

### Why the verification matters

Rootbound does not resume a conversation just because the names look similar.

It checks continuity signals including the canonical project root, repository identity when available, branch, compatible Git SHA, thread working directory, and recency.

If multiple sessions are genuinely ambiguous, Rootbound fails closed and asks instead of silently choosing the wrong one.

### What if the repository already had uncommitted work?

That work is treated as part of the rescue baseline.

For supported Rootbound mutations, rescue rollback can remove only what Rootbound changed after the rescue started while preserving files that were already dirty before the rescue.

If Rootbound cannot prove that rollback is safe, it refuses the rollback instead of using `git reset` or pretending it can restore the state safely.

---

# Common problems

## `rootbound: command not found` on macOS

If the installer updated your shell profile, close Terminal and open a new Terminal window.

Then try:

```sh
rootbound version
```

The CLI link normally lives at:

```text
~/.local/bin/rootbound
```

## `tunnel-client was not found on PATH`

Install the supported Secure MCP Tunnel client from:

```text
https://platform.openai.com/settings/organization/tunnels
```

Then verify:

```sh
tunnel-client --help
```

## Rootbound asks me for a tunnel ID

Create or inspect one here:

```text
https://platform.openai.com/settings/organization/tunnels
```

Copy the value beginning with `tunnel_` and paste it into the Rootbound prompt.

## Rootbound asks me for a runtime API key

Create or inspect runtime API keys here:

```text
https://platform.openai.com/settings/organization/api-keys
```

The key principal must be able to Read + Use the target tunnel.

## The connector exists in ChatGPT but calls fail

Check:

```sh
rootbound status
```

The runtime should be running. The local `tunnel-client` process must stay alive for ChatGPT discovery and tool calls.

Also make sure ChatGPT is connected to the same tunnel ID used by Rootbound.

## I renamed or moved my project

Do not assume the old Rootbound registration should continue matching.

Run `rootbound connect .` from the new canonical project root. Rootbound intentionally fails closed around stale workspace continuity instead of pretending an old path is still the same active workspace.

---

# Everyday CLI reference

Connect/register the current project and start/switch the runtime:

```sh
rootbound connect .
```

Check status:

```sh
rootbound status
```

Run local validation:

```sh
rootbound self-test .
```

View logs:

```sh
rootbound logs
```

Follow logs:

```sh
rootbound logs --follow
```

Export redacted diagnostics:

```sh
rootbound diagnostic
```

List registered projects:

```sh
rootbound project list
```

Remove a stale Rootbound project entry without deleting project files:

```sh
rootbound project remove /path/to/project
```

Remove the Rootbound project entry and its matching exact-root Codex trust block:

```sh
rootbound project remove /path/to/project --remove-trust
```

Remove an old exact-root Codex trust block that no longer has a Rootbound registry entry:

```sh
rootbound trust remove /path/to/project
```

Stop Rootbound:

```sh
rootbound stop
```

Upgrade from a downloaded/new release directory:

```sh
rootbound upgrade --from /path/to/rootbound-release
```

Rootbound uses staged activation and keeps persistent state outside the app tree so a normal app upgrade does not replace your Rootbound project/continuity state.

---

# Advanced

Everything below is optional reading for people who want to understand Rootbound's architecture, security model, public tools, or automation surface.

## Design rules

Rootbound follows a deliberately narrow model:

1. **ChatGPT is the reasoning model.**
2. **Rootbound exposes model-free local primitives.**
3. **Codex remains the local trust / sandbox / approval authority.**
4. **No Rootbound public tool silently starts a Codex model turn.**
5. **A remote caller cannot widen the local permission ceiling.**
6. **Unsafe ambiguity, drift, rollback, or trust situations fail closed.**
7. **Project and continuity state survives Rootbound runtime restarts.**

Rootbound is not intended to become a general IDE, multi-agent framework, cloud memory product, or task manager.

Its focus is the ChatGPT ↔ local project ↔ Codex continuity loop.

---

## Public tool surface

The current surface exposes **32 public tools**.

Current surface identifier: `rootbound-public-preview-v5`.

### Workspace and context

- `codex.workspace_open`
- `codex.project_context`
- `codex.skill_list`
- `codex.skill_read`

`workspace_open` resolves the canonical project/Git root and returns the effective local authority. It never creates or widens trust as a side effect.

### Repository inspection

- `codex.repo_search`
- `codex.read_many`
- `codex.git_status`
- `codex.git_diff`

Reads/searches are bounded and paginated. Common secret-bearing files are excluded by default unless explicitly requested.

### Editing

- `codex.apply_patch`
- `codex.precise_edit`
- `codex.edit_undo`
- `codex.edit_redo`

`precise_edit` can guard expected text, occurrence count and SHA before writing. Non-sensitive successful edits can be undone/redone only while the recorded file hashes still match.

There is no `git reset` based pseudo-undo.

### Commands

- `codex.command_exec`
- `codex.command_start`
- `codex.command_poll`
- `codex.command_write`
- `codex.command_terminate`

Short commands can run buffered. Long commands can be started and polled incrementally, with stdin/terminate where the local App Server implementation supports them.

Nested Codex CLI/model launches are refused on the model-free command lane.

### Codex history and durable continuity

- `codex.thread_list`
- `codex.thread_read`
- `codex.thread_items`
- `codex.continuity_bind`
- `codex.continuity_status`
- `codex.continuity_checkpoint`
- `codex.continuity_unbind`

Bindings and checkpoints survive Rootbound runtime restarts. Optional idempotency keys make retrying a bind/checkpoint safe without blindly injecting duplicates.

### Rescue / continuation

- `codex.continuity_resume`
- `codex.continuity_search`
- `codex.continuity_rollback`
- `codex.continuity_handoff`
- `codex.quota_status`

`codex.continuity_resume` is the preferred entry point for `continue`, interruption and quota-rescue intent.

`codex.continuity_handoff` injects a bounded verified checkpoint back into the original persisted Codex thread without starting a model turn.

`codex.continuity_rollback` restores only safely snapshotted Rootbound-owned rescue mutations and refuses unsafe or partial rollback coverage.

Cold-memory search uses the best visible-history API available on the installed Codex runtime and falls back to bounded persisted thread history where necessary.

### Browser Reader

- `codex.browser_status`
- `codex.browser_tabs`
- `codex.browser_read`

The public Browser Reader is intentionally read-only. It can inspect already-open connected tabs and DOM snapshots; arbitrary click/fill/navigation actions are not exposed by this surface.

---

## Continuation integrity

Rootbound ranks persisted Codex sessions using available continuity evidence instead of only matching a thread name.

Signals include:

- canonical project root;
- repository identity when available;
- branch;
- compatible Git SHA;
- persisted thread cwd;
- recency.

Threads started from a subdirectory of the same Git repository can still match safely.

Moved/renamed stale workspaces do not silently become false-positive resumptions. Genuine ambiguity is returned as structured candidates instead of guessed.

---

## Drift detection and rescue rollback

During an active rescue, Rootbound tracks the known worktree state.

Unexpected branch, HEAD, or tracked-file drift causes write/handoff operations to stop and require reinspection.

For supported Rootbound mutations:

- the rescue baseline is recorded first;
- pre-existing dirty work is preserved;
- file existence/hash guards are checked before restore;
- external edits after Rootbound's last known state cause rollback refusal;
- sensitive/unsupported snapshots are not treated as safely reversible;
- arbitrary write-capable commands can reduce global rollback coverage to `partial`;
- partial coverage causes rescue rollback to fail closed;
- `git reset` is never used.

---

## Persistence

Rootbound stores durable local state in SQLite, including registered projects, continuity bindings/events/checkpoints, durable command metadata, and bounded incremental command output.

The application tree is separate from persistent state so staged upgrades can replace the installed app without replacing user state.

### macOS

```text
~/Library/Application Support/Rootbound/
├── app/
├── state/
├── runtime/
├── logs/
└── backups/
```

### Windows state layout (not yet public-preview supported)

```text
%LOCALAPPDATA%\Rootbound\
├── app\
├── state\
├── runtime\
├── logs\
└── backups\
```

The Windows implementation is retained for ongoing validation, but this release only claims Apple Silicon macOS support.

---

## Security model

Rootbound is designed to fail closed around local Codex authority.

- project trust is exact-root and explicit;
- Rootbound uses a dedicated runtime-only named Codex profile instead of switching Codex to Full Access;
- the profile extends `:workspace`, adds `.git` write access inside the active workspace, enables outbound network access, and keeps local binding disabled;
- the profile is injected only into Rootbound-launched App Server processes and is never written into `~/.codex/config.toml`;
- the process-local Codex default remains `:workspace`; the user's normal Codex default is not changed;
- a versioned local consent marker is required before Rootbound starts with this permission contract;
- remote callers can request only `readOnly` or `inherit`; they cannot name or select a stronger profile;
- Rootbound does not silently widen Codex permissions;
- trust mutation is backed up before modification;
- tunnel validation happens before Codex trust mutation;
- the guided tunnel runtime key is kept out of `tunnel.json`, SQLite, process argv and normal Rootbound logs;
- durable argv containing detectable credentials is refused;
- common sensitive files are excluded from ordinary read/search flows unless explicitly requested;
- sensitive precise edits do not create undo snapshots;
- diagnostics redact credentials, home paths and sensitive thread information;
- diagnostic export excludes command stdout/stderr and thread previews;
- the public execution lane blocks nested Codex model/CLI launches.

See [`SECURITY.md`](SECURITY.md) for the complete security boundary.

---

## Advanced / manual tunnel configuration

Most users should **not** use this section. The normal setup is:

```sh
rootbound connect .
```

Manual tunnel configuration remains available as an operator/debug escape hatch.

Example:

```sh
rootbound tunnel configure --argv-json '["tunnel-client","run","--profile","my-profile"]'
```

Inspect it:

```sh
rootbound tunnel show
```

Remove it:

```sh
rootbound tunnel clear
```

`ROOTBOUND_TUNNEL_ARGV_JSON` can also be used as a temporary advanced/debug override.

Persistent manual tunnel configuration rejects detectable literal credentials.

---

## Non-interactive setup

For automation where the tunnel ID, runtime key, and trust decision are already supplied intentionally:

```sh
CONTROL_PLANE_TUNNEL_ID=tunnel_... \
CONTROL_PLANE_API_KEY=... \
rootbound connect . --yes
```

`--yes` also records consent for the **current Rootbound runtime permission contract** (`.git` write access inside the workspace + outbound network access). Use it only in automation where that authority has already been approved intentionally.

`--yes` does not invent missing tunnel credentials. If setup cannot be resolved safely without prompting, Rootbound fails closed.

To register/trust a project without starting the tunnel runtime:

```sh
rootbound connect . --yes --no-start
```

---

## Development

Install dependencies:

```sh
npm ci
```

Run the focused implementation suite:

```sh
npm run test:v5
```

Run the complete repository suite:

```sh
npm test
```

Run release validation:

```sh
npm run validate:release
```

Start stdio directly:

```sh
npm run start:stdio
```

Start HTTP directly:

```sh
npm run start:http
```

The canonical public tool list lives in [`src/surface-contracts.mjs`](src/surface-contracts.mjs).

Version-specific implementation plans and acceptance checklists live in [`docs/plans/rootbound-v5.md`](docs/plans/rootbound-v5.md) rather than in the public product story above.

---

## License

Apache-2.0.

Rootbound is an independent project. It is not an OpenAI product and does not imply OpenAI endorsement.

## Shoutout

Shoutout to [@liyana31811](https://github.com/liyana31811), creator of [Codexless](https://github.com/liyana31811/Codexless). Their work was an early source of inspiration while Rootbound was taking shape.

> **Keep working in ChatGPT. Use Codex when you explicitly need Codex.**
