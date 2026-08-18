# Codexless V5 — Durable Daily Driver Plan

Status: implementation in progress on `feat/thread-history-continuity`.

This document is the durable source of truth for the V5 scope. The V5 is not considered ready merely because features exist; it is ready when the acceptance checklist at the end is satisfied on supported machines.

## Product rule

Codexless V5 is a ChatGPT-first local coding bridge.

- ChatGPT does the reasoning.
- Codexless exposes only accepted model-free local primitives.
- Codex remains the local sandbox / trust authority.
- No hidden model fallback.
- No remote caller may widen the local permission ceiling.
- State that matters to daily use survives MCP and runtime restarts.

## P0 — required for V5

### Control plane

- [x] `codexless connect .`
- [x] `codexless start`
- [x] `codexless status`
- [x] `codexless stop`
- [x] `codexless logs`
- [x] `codexless doctor`
- [x] `codexless self-test`
- [x] `codexless upgrade --from <release-dir>`
- [x] `codexless diagnostic`
- [x] persistent tunnel configuration via `codexless tunnel configure/show/clear`

### Runtime

- [x] supervised tunnel process
- [x] restart limit / stale PID handling
- [x] atomic runtime state
- [x] correlated `runtimeId` in runtime state / supervisor logs
- [x] state tree separated from app install tree
- [x] Mac and Windows layout alignment

### Projects / trust

- [x] canonical real / Git root detection
- [x] deterministic durable `projectRef`
- [x] SQLite project registry
- [x] explicit exact-root trust flow
- [x] config backup before trust mutation
- [x] rollback trust mutation when validation fails
- [x] tunnel validation before trust mutation

### Persistence

- [x] SQLite state store
- [x] projects
- [x] continuity bindings
- [x] events / checkpoints
- [x] durable long-running commands
- [x] incremental command output chunks
- [x] schema migrations through current V5 schema

### Commands

Required public contract:

- [x] `codex.command_exec`
- [x] `codex.command_start`
- [x] `codex.command_poll`
- [x] `codex.command_write`
- [x] `codex.command_terminate`

Acceptance rules:

- [x] nested Codex CLI launches refused
- [x] long-command output paged incrementally by cursor
- [x] output persistence bounded
- [x] interactive App Server streaming on supported implementations
- [x] Windows fallback explicit instead of pretending stdin streaming works
- [x] durable commands reject detectable literal credentials before persistence

### Surface compatibility

- [x] public surface version = `codexless-public-preview-v5`
- [x] current public surface exported from one contract file
- [x] doctor validates V5 dynamically rather than hardcoding tool count
- [x] typed responses include surface version where migrated
- [x] stale ChatGPT snapshot guidance in doctor / docs

### Install / upgrade

- [x] Node >= 22.13.0 runtime gate
- [x] staged installers
- [x] install / state split on Mac
- [x] install / state split on Windows
- [x] uninstall preserves state by default
- [x] explicit state purge
- [x] upgrade preserves state and supports legacy-root migration
- [ ] regenerate lockfile root metadata with npm on a trusted execution machine

## P1 — required before declaring the branch a daily driver

### Workspace primitive

- [x] `codex.workspace_open`
- [x] canonical project / Git root
- [x] durable `projectRef`
- [x] read-only authority inspection
- [x] `needs_trust` response without silently creating trust

### Typed errors

- [x] stable `errorCode`
- [x] stable error `category`
- [x] `retryable`
- [x] `nextActions`
- [x] `operation`
- [x] public surface version on migrated typed responses
- [ ] migrate any remaining legacy tool wrappers that still return ad-hoc error JSON

### Diagnostics / observability

- [x] `codexless diagnostic`
- [x] runtime information
- [x] project / binding / event information
- [x] correlation IDs derived from durable IDs
- [x] runtime log correlation by `runtimeId`
- [x] home path redaction
- [x] credential pattern redaction
- [x] command stdout / stderr excluded from diagnostic export
- [x] thread preview excluded
- [x] tunnel config represented without secret values

### Undo / redo

- [x] guarded `codex.edit_undo`
- [x] guarded `codex.edit_redo`
- [x] exact before / after SHA checks
- [x] refuse undo / redo after external file modification
- [x] no `git reset` implementation
- [x] snapshots remain local
- [x] sensitive paths never enter undo snapshots

### Pagination

- [x] paginated `repo_search`
- [x] opaque request-bound cursor
- [x] paginated `read_many`
- [x] cursor resumes within exact file offset
- [x] file SHA detects source changes between pages
- [x] sensitive files excluded / refused unless explicitly opted in

### Continuity reliability

- [x] persistence across runtime restart
- [x] optional bind idempotency key
- [x] optional checkpoint idempotency key
- [x] fail closed on ambiguous pending checkpoint retry
- [x] key / payload reuse mismatch refused

### Secret boundaries

- [x] durable argv credential detection
- [x] continuity command label redaction
- [x] tunnel literal credential persistence refused
- [x] tunnel `{env:NAME}` placeholders expanded only at runtime
- [x] diagnostic credential redaction
- [x] sensitive file read/search requires explicit opt-in
- [x] sensitive undo snapshot disabled, including canonical realpath check

### ChatGPT compatibility self-test

- [x] accepted Codex executable / App Server validation
- [x] read-only authority validation
- [x] model-free short command validation
- [x] temporary write / read-back / cleanup validation when writable
- [x] no Codex model turn
- [ ] real ChatGPT connection acceptance on current target plans / surfaces

## Public surface

Current contract: 27 tools.

The canonical list is `src/surface-contracts.mjs`; do not duplicate a fixed tool count in runtime validation code.

## CI policy during stabilization

The V5 GitHub Actions workflow is intentionally `workflow_dispatch` only.

Reason: the previous push-triggered matrix produced repeated failing jobs and excessive notifications while the branch was changing rapidly.

Do not restore per-push CI until:

1. `npm run test:v5` passes once on both supported OS families;
2. syntax checks pass;
3. the root lock metadata is regenerated cleanly;
4. one full repository test run is reviewed;
5. CI notification volume / trigger strategy is deliberately chosen.

## Known deterministic CI failures already fixed

- workflow referenced nonexistent `src/error-contract.mjs`
- workflow referenced nonexistent `src/undo-store.mjs`
- old `repo-tools` test expected direct `rg` invocation after V5 pagination changed the implementation
- old hardcoded public-tool counts in doctor / public contract

## Remaining release blockers

### Automated validation

- [ ] trusted-machine `npm ci`
- [ ] trusted-machine `npm run test:v5`
- [ ] trusted-machine `npm test`
- [ ] one manual GitHub Actions matrix run on macOS + Windows
- [ ] inspect and fix every failing job before any automatic trigger is restored

### Real-machine acceptance

Mac:

- [ ] fresh install
- [ ] tunnel configure
- [ ] `connect .`
- [ ] `status`
- [ ] `workspace_open`
- [ ] short command
- [ ] long streaming command / poll / stdin / terminate
- [ ] precise edit + undo + redo + conflict refusal
- [ ] pagination
- [ ] continuity restart + idempotent checkpoint
- [ ] diagnostic export inspection
- [ ] staged upgrade
- [ ] uninstall preserving state

Windows:

- [ ] fresh install into `app/`
- [ ] state preservation outside `app/`
- [ ] tunnel configure
- [ ] `connect .`
- [ ] buffered long-command fallback
- [ ] explicit stdin streaming unsupported error
- [ ] upgrade / uninstall preservation

### Release hygiene

- [x] README rewritten for V5
- [x] durable V5 plan exists
- [ ] review `SECURITY.md` against new secret / undo / tunnel boundaries
- [ ] review `README.zh-CN.md` or clearly mark it stale until translated
- [ ] regenerate npm lock metadata
- [ ] final branch diff review
- [ ] create PR only when validation evidence is attached

## Definition of done

V5 is ready to merge only when all of the following are true:

1. P0 is complete.
2. P1 is complete or an explicit item is consciously deferred to P2.
3. no public tool can silently start a Codex model turn.
4. no normal upgrade deletes Codexless state.
5. no durable command / tunnel / diagnostic path knowingly persists literal credentials.
6. `npm run test:v5` and the full test suite are green on trusted execution.
7. one controlled GitHub Actions run is green on supported OSes.
8. real-machine acceptance covers connect, command, edit, restart, upgrade and uninstall.
9. README / SECURITY / public contract describe the implementation that actually ships.
10. `main` remains untouched until the above evidence exists.
