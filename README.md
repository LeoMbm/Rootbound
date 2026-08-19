<div align="center">

# Rootbound

### Keep coding in ChatGPT. Use Codex as the local trust and execution layer.

**Windows + Apple Silicon macOS Technical Preview**

</div>

Rootbound lets ChatGPT work on your local project through Codex without secretly starting a Codex model turn.

In practice, that means ChatGPT can inspect files, search your repo, edit code, run commands, read Git state, and continue interrupted Codex work while Codex remains the local sandbox and permission authority.

> ChatGPT reasons. Rootbound executes approved local actions. Codex stays in control of local trust.

---

## The simple version

If you use ChatGPT and Codex to build software, Rootbound connects the two.

You can think of it like this:

```text
ChatGPT
   ↓
Rootbound
   ↓
Codex local permissions / sandbox
   ↓
Your project
```

ChatGPT gets local coding hands, but it does not bypass the permissions you already gave Codex.

### What can I do with it?

Once Rootbound is connected to a project, you can ask ChatGPT things like:

```text
@Rootbound check why my tests are failing
```

```text
@Rootbound find where authentication is handled
```

```text
@Rootbound fix this bug and run the tests
```

```text
@Rootbound show me what changed in Git
```

And if Codex gets interrupted or runs out of quota:

```text
@Rootbound continue
```

Rootbound can recover the matching Codex conversation, inspect the current worktree, continue safely in ChatGPT, and later hand the updated state back to the original Codex thread.

That continuity loop is one of the main reasons Rootbound exists.

---

## For vibecoders and non-technical users

You do not need to understand MCP internals, App Server RPCs, tunnel profiles, SQLite state, or permission plumbing to use Rootbound.

The normal workflow is intentionally small.

### 1. Install Rootbound

#### Apple Silicon macOS

```sh
sh ./bin/rootbound-install.sh
```

#### Windows

```bat
bin\rootbound-install.cmd
```

Rootbound requires:

- Node.js 22.13 or newer;
- Codex installed locally;
- OpenAI `tunnel-client` available on your machine.

Rootbound does not install Codex for you and does not silently trust folders on your behalf.

### 2. Connect a project

Open a terminal inside your project and run:

```sh
rootbound connect .
```

This is the **normal setup: one command**. Rootbound's guided one-command setup handles the normal connection flow for you:

- detects your real project root;
- detects or asks for the tunnel it needs;
- securely stores the runtime key locally;
- validates the tunnel before changing project trust;
- asks before adding exact project trust to Codex;
- registers the project;
- starts Rootbound.

For returning projects, most of this is reused automatically.

### 3. Connect Rootbound to ChatGPT

When Rootbound starts successfully, it prints the connector information you need for ChatGPT.

Once the connector is available in ChatGPT, you can simply mention Rootbound and work against the current project.

### 4. Check that everything works

```sh
rootbound status
```

For a deeper local check:

```sh
rootbound self-test .
```

The self-test checks the Codex App Server path, read access, command execution, and temporary write/read/delete behavior when the current project permissions allow it.

It does not start a Codex model turn.

---

## The interrupted-Codex flow

Rootbound is designed so a Codex interruption does not have to kill your momentum.

```text
Codex is interrupted or unavailable
        ↓
You open ChatGPT
        ↓
@Rootbound continue
        ↓
Rootbound finds the matching Codex thread
        ↓
ChatGPT continues against the current local worktree
        ↓
Rootbound can hand the verified result back to that same Codex thread
```

During this flow Rootbound can:

- match the correct project and persisted Codex conversation;
- inspect the current branch, repository and worktree state;
- surface recent visible Codex history;
- search older visible thread history on demand as cold memory;
- detect external drift before writing or handing work back;
- track supported Rootbound-made changes during rescue;
- roll back those tracked rescue changes without deleting work that already existed before the rescue;
- inject a bounded handoff checkpoint into the original Codex thread without starting a model turn.

Quota information is advisory only. Rootbound continuity does not depend on Codex quota being exhausted.

---

## Everyday commands

### Start or connect a project

```sh
rootbound connect .
```

### Check runtime status

```sh
rootbound status
```

### Run local validation

```sh
rootbound self-test .
```

### Inspect logs

```sh
rootbound logs
```

Follow logs live:

```sh
rootbound logs --follow
```

### Export redacted diagnostics

```sh
rootbound diagnostic
```

### Stop Rootbound

```sh
rootbound stop
```

### Upgrade from a downloaded release directory

```sh
rootbound upgrade --from /path/to/rootbound-release
```

Rootbound uses staged activation and keeps project/state data outside the installed app tree so an app upgrade does not replace your local Rootbound state.

---

## Managing projects

List registered projects:

```sh
rootbound project list
```

Remove an old Rootbound project entry:

```sh
rootbound project remove /path/to/project
```

or:

```sh
rootbound project remove project_...
```

To also remove the matching exact-root Codex trust entry:

```sh
rootbound project remove /path/to/project --remove-trust
```

Removing a Rootbound project never deletes the project files themselves.

For an old Codex trust entry that no longer has a Rootbound project record:

```sh
rootbound trust remove /path/to/project
```

---

# Advanced

The rest of this README is for users who want to understand how Rootbound works internally or operate it more deliberately.

## Design principles

Rootbound follows a few strict rules:

1. **ChatGPT is the reasoning model.**
2. **Rootbound performs model-free local primitives.**
3. **Codex remains the local trust, sandbox and approval authority.**
4. **Rootbound never silently starts a Codex model turn.**
5. **A remote caller cannot widen the locally configured permission ceiling.**
6. **Ambiguous continuity and unsafe rollback situations fail closed instead of guessing.**
7. **Project and continuity state survives Rootbound runtime restarts.**

Rootbound is deliberately not a general multi-agent framework, project manager, cloud memory system, or replacement IDE.

Its focus is the local ChatGPT ↔ Codex continuity and execution loop.

---

## Public tool surface

The current public surface exposes **32 public tools** grouped around a few jobs.

Current surface identifier: `rootbound-public-preview-v5`.

### Workspace and project context

- `codex.workspace_open`
- `codex.project_context`
- `codex.skill_list`
- `codex.skill_read`

`workspace_open` resolves the canonical project/Git root and returns the effective local authority. It never creates trust as a side effect.

### Repository inspection

- `codex.repo_search`
- `codex.read_many`
- `codex.git_status`
- `codex.git_diff`

Reads and searches are paginated. Common secret-bearing files are excluded by default unless explicitly requested.

### Editing

- `codex.apply_patch`
- `codex.precise_edit`
- `codex.edit_undo`
- `codex.edit_redo`

`precise_edit` supports occurrence and SHA guards. Undo/redo restores exact recorded content only while the expected hashes still match.

Rootbound does not use `git reset` as fake undo.

### Commands

- `codex.command_exec`
- `codex.command_start`
- `codex.command_poll`
- `codex.command_write`
- `codex.command_terminate`

Short commands can run buffered. Long-running commands can be started, polled incrementally, written to through stdin where supported, and terminated.

Nested Codex CLI launches are refused on this model-free command lane.

### Codex history and continuity

- `codex.thread_list`
- `codex.thread_read`
- `codex.thread_items`
- `codex.continuity_bind`
- `codex.continuity_status`
- `codex.continuity_checkpoint`
- `codex.continuity_unbind`

Bindings and checkpoints are durable. Optional idempotency keys let callers safely retry operations without blindly duplicating checkpoints.

### Rescue and handoff

- `codex.continuity_resume`
- `codex.continuity_search`
- `codex.continuity_rollback`
- `codex.continuity_handoff`
- `codex.quota_status`

`continuity_resume` is the preferred entry point for `continue`, interruption, and quota-rescue flows.

Rootbound ranks candidate Codex sessions using the canonical project root, repository identity when available, branch, compatible Git SHA and recency. Exact or compatible matches can continue automatically; genuinely ambiguous matches are surfaced instead of guessed.

Cold-memory search uses the best persisted-history API available on the installed Codex runtime and falls back to bounded visible thread history where needed.

### Browser Reader

- `codex.browser_status`
- `codex.browser_tabs`
- `codex.browser_read`

Browser access is intentionally read-only on the public surface. Rootbound can inspect existing connected tabs and DOM snapshots, but it does not expose arbitrary click, fill, submit or navigation primitives here.

---

## Continuation integrity

Rootbound does not treat “a thread exists” as enough proof that it is safe to resume.

It compares continuity signals such as:

- canonical project root;
- repository identity when available;
- branch;
- compatible Git SHA;
- thread working directory;
- recency.

This matters when projects are moved, renamed, duplicated, checked out on another branch, or when multiple Codex conversations exist for similar paths.

If Rootbound cannot establish a safe enough match, it returns structured ambiguity instead of pretending it found the right session.

---

## Rescue rollback

When ChatGPT continues work through a Rootbound rescue session, Rootbound records supported mutations it makes after the rescue baseline.

That allows it to restore those changes later without rewinding unrelated work that was already in the repository.

Important behavior:

- pre-existing dirty files are preserved;
- external changes after Rootbound's recorded SHA cause rollback refusal;
- arbitrary write-capable commands can reduce rollback coverage to partial;
- sensitive or unsupported snapshots are not treated as safely reversible;
- partial coverage causes a global rescue rollback to fail closed;
- `git reset` is never used for rescue rollback.

---

## Persistence

Rootbound stores durable local state in SQLite, including:

- registered projects;
- continuity bindings;
- continuity events and checkpoints;
- durable command metadata;
- bounded incremental command output.

The installed application tree is kept separate from the persistent state tree so staged upgrades can replace the app without replacing user state.

### macOS layout

```text
~/Library/Application Support/Rootbound/
├── app/
├── state/
├── runtime/
├── logs/
└── backups/
```

### Windows layout

```text
%LOCALAPPDATA%\Rootbound\
├── app\
├── state\
├── runtime\
├── logs\
└── backups\
```

---

## Security model

Rootbound is designed to fail closed around local authority.

- project trust is exact-root and explicit;
- Rootbound does not silently widen Codex permissions;
- trust mutations are backed up first;
- guided tunnel setup validates before changing Codex trust;
- the runtime API key is kept out of `tunnel.json`, SQLite, process argv and normal Rootbound logs;
- durable command argv containing detectable credentials is refused;
- common sensitive files are excluded from normal search/read flows unless explicitly requested;
- sensitive edits do not create local undo snapshots;
- diagnostics redact credentials, home paths and sensitive thread data;
- command stdout/stderr and thread previews are excluded from diagnostic exports;
- nested Codex model/CLI launches are blocked from the model-free execution lane.

See [`SECURITY.md`](SECURITY.md) for the full security boundary.

---

## Advanced / manual tunnel configuration

Most users should use:

```sh
rootbound connect .
```

Manual tunnel configuration exists only as an operator/debug escape hatch.

Example:

```sh
rootbound tunnel configure --argv-json '["tunnel-client","run","--profile","my-profile"]'
```

Inspect it with:

```sh
rootbound tunnel show
```

Remove the manual override with:

```sh
rootbound tunnel clear
```

`ROOTBOUND_TUNNEL_ARGV_JSON` can also be used as a temporary environment override for advanced/debug use.

Persistent manual tunnel configuration rejects detectable literal credentials.

---

## Non-interactive setup

For automation where trust approval and tunnel credentials are already supplied locally:

```sh
CONTROL_PLANE_TUNNEL_ID=tunnel_... \
CONTROL_PLANE_API_KEY=... \
rootbound connect . --yes
```

`--yes` does not invent missing values. If setup cannot be completed safely without prompting, Rootbound fails closed.

To configure trust and register a project without starting the tunnel runtime:

```sh
rootbound connect . --yes --no-start
```

---

## Development

Install dependencies:

```sh
npm ci
```

Run the focused Rootbound test suite:

```sh
npm run test:v5
```

Run the full repository suite:

```sh
npm test
```

Run the full release validation:

```sh
npm run validate:release
```

Start the stdio server directly:

```sh
npm run start:stdio
```

Start the HTTP server directly:

```sh
npm run start:http
```

The public tool contract is defined in [`src/surface-contracts.mjs`](src/surface-contracts.mjs).

The internal implementation and acceptance plan lives in [`docs/plans/rootbound-v5.md`](docs/plans/rootbound-v5.md). Version-specific implementation notes belong there rather than in the public product story above.

---

## License

Apache-2.0.

Rootbound is an independent project. It is not an OpenAI product and does not imply OpenAI endorsement.

> **Keep working in ChatGPT. Use Codex when you explicitly need Codex.**
