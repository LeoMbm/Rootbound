# Codexless V5 — Durable Daily Driver Plan

Status: implementation substantially complete on `feat/thread-history-continuity`; release validation is still pending.

This document is the durable source of truth for V5. Features existing in source is not enough: V5 is ready only when the validation / real-machine checklist below is green.

## Product rule

- ChatGPT does the reasoning.
- Codexless exposes accepted model-free local primitives.
- Codex remains the local sandbox / trust authority.
- No hidden model fallback.
- No remote caller may widen the local permission ceiling.
- Daily-driver state survives MCP / runtime restarts.

## P0 — implementation

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
- [x] `codexless tunnel configure/show/clear`

### Runtime

- [x] supervised tunnel process
- [x] restart limit / stale PID handling
- [x] atomic runtime state
- [x] correlated `runtimeId` in state / logs
- [x] app tree separated from state tree
- [x] Mac / Windows layout alignment

### Projects / trust

- [x] canonical real / Git root
- [x] deterministic durable `projectRef`
- [x] SQLite project registry
- [x] explicit exact-root trust flow
- [x] Codex config backup
- [x] trust rollback when validation fails
- [x] tunnel validation before trust mutation

### Persistence

- [x] SQLite state store
- [x] projects
- [x] continuity bindings / events / checkpoints
- [x] durable commands
- [x] incremental command output chunks
- [x] schema migration through current V5 schema

### Command contract

- [x] `codex.command_exec`
- [x] `codex.command_start`
- [x] `codex.command_poll`
- [x] `codex.command_write`
- [x] `codex.command_terminate`
- [x] nested Codex CLI launch refusal
- [x] incremental cursor polling
- [x] bounded output persistence
- [x] native streaming where accepted
- [x] explicit Windows fallback / unsupported stdin behavior
- [x] durable argv secret guard before SQLite persistence

### Surface compatibility

- [x] public surface = `codexless-public-preview-v5`
- [x] canonical tool list in `src/surface-contracts.mjs`
- [x] current public tool count = 27
- [x] dynamic doctor validation (no fixed tool-count dependency)
- [x] `surfaceVersion` on migrated typed responses
- [x] stale snapshot reconnect guidance

### Install / upgrade

- [x] Node >= 22.13.0 runtime / installer gate
- [x] staged activation
- [x] Mac `app/` vs state separation
- [x] Windows `app/` vs state separation
- [x] uninstall preserves state by default
- [x] explicit state purge
- [x] upgrade preserves state / handles legacy root layout
- [ ] regenerate npm lock root metadata using npm on trusted execution

## P1 — implementation

### Workspace

- [x] `codex.workspace_open`
- [x] canonical project / Git root
- [x] stable `projectRef`
- [x] read-only authority inspection
- [x] `needs_trust` without trust side effect

### Typed errors

- [x] stable `errorCode`
- [x] `category`
- [x] `retryable`
- [x] `nextActions`
- [x] `operation`
- [x] `surfaceVersion`
- [x] command tools migrated
- [x] workspace migrated
- [x] repo / construction tools migrated
- [x] thread / continuity tools migrated
- [x] project context / skills migrated
- [x] Browser Reader migrated

### Diagnostics / observability

- [x] `codexless diagnostic`
- [x] runtime / project / binding / event information
- [x] durable-ID correlation
- [x] runtime log correlation by `runtimeId`
- [x] home-path redaction
- [x] credential-pattern redaction
- [x] command stdout / stderr excluded
- [x] command argv excluded
- [x] thread preview excluded
- [x] tunnel status without secret values

### Undo / redo

- [x] `codex.edit_undo`
- [x] `codex.edit_redo`
- [x] before / after SHA guards
- [x] external-change conflict refusal
- [x] no `git reset`
- [x] snapshots local only
- [x] sensitive paths never snapshot
- [x] canonical realpath sensitive check

### Pagination

- [x] paginated `repo_search`
- [x] opaque request-bound cursor
- [x] paginated `read_many`
- [x] exact file offset resume
- [x] file SHA detects source changes
- [x] sensitive read/search explicit opt-in

### Continuity reliability

- [x] restart persistence
- [x] bind idempotency key
- [x] checkpoint idempotency key
- [x] fail closed on ambiguous pending checkpoint
- [x] key / payload mismatch refusal

### Secret boundaries

- [x] durable argv credential detection
- [x] continuity command-label redaction
- [x] persistent tunnel literal credential refusal
- [x] tunnel `{env:NAME}` runtime expansion
- [x] diagnostic redaction
- [x] sensitive read/search opt-in
- [x] sensitive undo snapshot disabled

### ChatGPT compatibility self-test

- [x] accepted Codex / App Server validation
- [x] read authority validation
- [x] short model-free command
- [x] temporary write / read-back / cleanup when writable
- [x] no Codex model turn
- [ ] real ChatGPT connection acceptance on current target surfaces

## Release / CI hardening completed

- [x] push-triggered noisy V5 workflow disabled
- [x] workflow is `workflow_dispatch` only during stabilization
- [x] nonexistent CI paths `src/error-contract.mjs` / `src/undo-store.mjs` fixed
- [x] old repo-search unit test aligned with paginated implementation
- [x] doctor / public contract fixed to avoid stale hardcoded tool counts
- [x] `test/source-integrity-v5.mjs` checks relative import targets and npm script paths
- [x] `test/release-contract-v5.mjs` guards surface / docs / metadata / manual-CI policy
- [x] README rewritten for V5
- [x] SECURITY rewritten for V5
- [x] stale Chinese V4 README replaced with explicit V5-sync notice
- [x] EXPORT_SYNC rewritten around V5 source-of-truth contracts
- [x] package metadata points at `LeoMbm/Codexless`
- [x] durable plan included in package file list

## Current automated suite

`npm run test:v5` starts with source-integrity validation, then covers:

- foundation / trust
- runtime state
- persistent continuity
- SQLite migration / command chunks
- long-command manager
- workspace open
- typed errors
- diagnostics / redaction
- edit undo / redo
- pagination
- continuity idempotency
- secret boundaries
- persistent tunnel config
- static release contract

## CI policy during stabilization

The V5 GitHub Actions workflow remains manual-only.

Do not restore push / PR triggers until:

1. `npm run test:v5` passes on trusted execution;
2. syntax checks pass;
3. lock root metadata is regenerated with npm;
4. the full repository test run is reviewed;
5. one controlled macOS + Windows Actions matrix is green;
6. notification policy is chosen deliberately.

## Remaining release blockers

### Automated validation

- [ ] trusted-machine `npm ci`
- [ ] trusted-machine `npm run test:v5`
- [ ] trusted-machine `npm test`
- [ ] `npm pack --dry-run` + packed-file review
- [ ] regenerate / review lock metadata
- [ ] one manual GitHub Actions matrix run on macOS + Windows
- [ ] inspect every failing job before restoring any automatic trigger

### Real-machine Mac acceptance

- [ ] fresh install
- [ ] tunnel configure
- [ ] `connect .`
- [ ] `status`
- [ ] `workspace_open`
- [ ] read/search
- [ ] short command
- [ ] long streaming command / poll / stdin / terminate
- [ ] precise edit + undo + redo + conflict refusal
- [ ] sensitive-path boundaries
- [ ] continuity restart + idempotent checkpoint
- [ ] diagnostic export inspection
- [ ] staged upgrade
- [ ] uninstall preserving state

### Real-machine Windows acceptance

- [ ] fresh install into `app/`
- [ ] state preservation outside `app/`
- [ ] tunnel configure
- [ ] `connect .`
- [ ] workspace/read/edit/short-command path
- [ ] buffered long-command fallback
- [ ] explicit stdin streaming unsupported error
- [ ] diagnostic export
- [ ] upgrade / uninstall preservation

### Final release hygiene

- [ ] final branch diff review
- [ ] third-party notices / package contents review
- [ ] verify private vulnerability-reporting route
- [ ] create PR only when validation evidence is attached

## Definition of done

V5 is ready to merge only when:

1. P0 implementation is complete.
2. P1 implementation is complete or an item is explicitly deferred to P2.
3. no public tool can silently start a Codex model turn.
4. normal upgrade cannot delete Codexless state.
5. durable command / tunnel / diagnostic paths do not knowingly persist literal credentials.
6. `npm run test:v5` and `npm test` are green on trusted execution.
7. one controlled Actions matrix is green on supported OSes.
8. real-machine acceptance covers connect, command, edit, restart, upgrade and uninstall.
9. README / SECURITY / public contract match the implementation.
10. `main` remains untouched until that evidence exists.
