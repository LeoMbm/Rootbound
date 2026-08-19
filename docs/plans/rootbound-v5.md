# Rootbound V5 — Durable Daily Driver Plan

Status: core V5 plus the Codex interruption/quota-rescue implementation are on `feat/quota-rescue-continuity`. macOS guided setup/lifecycle acceptance is green. The 32-tool quota-rescue surface passes the model-free automated release gate; real ChatGPT acceptance of the newly installed surface plus supported-Windows validation remain before merge/release.

This document is the durable source of truth for V5. Features existing in source is not enough: V5 is ready only when the validation / real-machine checklist below is green.

## Product rule

- ChatGPT does the reasoning.
- Rootbound exposes accepted model-free local primitives.
- Codex remains the local sandbox / trust authority.
- No hidden model fallback.
- No remote caller may widen the local permission ceiling.
- Daily-driver state survives MCP / runtime restarts.
- **Normal onboarding is one command: `rootbound connect .`. Tunnel plumbing is an implementation detail, not user workflow.**

## P0 — implementation

### Control plane

- [x] `rootbound connect .`
- [x] guided one-command first-run wizard
- [x] returning exact-trusted project skips repeat trust prompt
- [x] `rootbound start`
- [x] `rootbound status`
- [x] `rootbound stop`
- [x] `rootbound logs`
- [x] `rootbound doctor`
- [x] `rootbound self-test`
- [x] `rootbound upgrade --from <release-dir>`
- [x] `rootbound diagnostic`
- [x] advanced/manual `rootbound tunnel configure/show/clear`

### Guided tunnel onboarding

- [x] detect `tunnel-client`
- [x] reuse `CONTROL_PLANE_TUNNEL_ID` when supplied
- [x] discover tunnel IDs from local tunnel-client profiles
- [x] prompt for tunnel ID only when discovery is insufficient
- [x] reuse runtime key from `CONTROL_PLANE_API_KEY` / `OPENAI_API_KEY`
- [x] hidden interactive runtime-key entry when no key is already available
- [x] generate Rootbound-managed tunnel-client profile
- [x] launch Rootbound directly over stdio; no manual HTTP + tunnel split
- [x] keep runtime key out of `tunnel.json`, process argv, SQLite and Rootbound logs
- [x] macOS/POSIX secret file mode `0600`
- [x] Windows current-account ACL hardening with fail-closed setup
- [x] run `tunnel-client doctor` before Codex trust mutation
- [x] rollback generated tunnel profile/secret/config on tunnel validation failure
- [x] `rootbound tunnel clear` removes guided tunnel profile + secret
- [x] manual argv/profile flow retained only as an advanced/debug escape hatch

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
- [x] no repeat prompt for an already exact-trusted canonical root
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
- [x] tunnel runtime credential isolated outside SQLite in dedicated private local secret state

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

- [x] public surface = `rootbound-public-preview-v5`
- [x] canonical tool list in `src/surface-contracts.mjs`
- [x] current public tool count = 32
- [x] dynamic doctor validation (no fixed tool-count dependency)
- [x] `surfaceVersion` on migrated typed responses
- [x] stale snapshot reconnect guidance

### Install / upgrade

- [x] Node >= 22.13.0 runtime / installer gate
- [x] staged activation
- [x] Mac `app/` vs state separation
- [x] Windows `app/` vs state separation
- [x] Mac installer marks lifecycle/stdio wrappers executable
- [x] uninstall preserves state by default
- [x] explicit state purge
- [x] upgrade preserves state / handles legacy root layout
- [x] npm shrinkwrap root metadata regenerated and strict lock check passed on trusted Mac before guided-connect changes

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

- [x] `rootbound diagnostic`
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
- [x] advanced persistent tunnel literal credential refusal
- [x] guided tunnel key isolated in dedicated private local secret file
- [x] guided tunnel profile references key with `file:` instead of embedding it
- [x] diagnostic redaction / exclusion
- [x] sensitive read/search opt-in
- [x] sensitive undo snapshot disabled

### ChatGPT compatibility self-test

- [x] accepted Codex / App Server validation
- [x] read authority validation
- [x] short model-free command
- [x] temporary write / read-back / cleanup when writable
- [x] no Codex model turn
- [ ] real ChatGPT connection acceptance on current target surfaces

## Killer-flow backlog — Codex interruption / quota rescue

This is the next product layer after the V5 safety/release gates. The goal is deliberately narrow:

> A Codex interruption or quota limit should become a non-event: the user says `@Rootbound continue`, ChatGPT resumes the correct work safely, and Rootbound can hand verified state back to the original Codex thread later.

Do not turn Rootbound into a general IDE, cloud project-memory product, multi-agent framework, or task manager. Keep the product centered on the Codex ↔ ChatGPT continuity loop.

### KF-P0 — zero-context resume

- [x] `codex.continuity_resume({ cwd?, threadId? })` facade as the preferred resume entrypoint
- [x] deterministic bounded handoff projection; do not dump raw history or unbounded command output
- [x] support `recency_at` thread ordering
- [x] continuation-integrity matching using canonical project/root plus repository identity, branch, compatible Git SHA and recency
- [x] handle Codex threads created from subdirectories: exact-cwd lookup first, then safely consider thread cwds contained by the canonical Git root
- [x] return explicit match confidence/reason (`exact`, `compatible`, `ambiguous`, `not_found`)
- [x] join historical Codex state with the current authoritative worktree state
- [x] create or reuse the continuity binding automatically
- [x] hide binding plumbing from the user; local stable MCP sessions may scope implicitly, while remote HTTP uses a per-rescue opaque `rescueRef` so transport sessions are not assumed to equal ChatGPT conversations
- [x] MCP instructions: resume/continue/quota-interruption intent calls `continuity_resume` first; ask for a thread id only on genuine ambiguity
- [ ] golden product test: a brand-new ChatGPT chat receiving only `@Rootbound continue` finds the correct Codex session, explains current state, and continues work without any Codex model turn

### KF-P1 — verified rescue lifecycle

- [x] `codex.continuity_handoff` facade for ChatGPT → original Codex thread handback
- [x] quota awareness via supported App Server rate-limit snapshots/updates; advisory context only, never a prerequisite for resume
- [x] show quota reset/limit state when available without treating missing/changed buckets as a failure of continuity
- [x] drift detection while a rescue session is active: branch/HEAD and Rootbound-tracked file SHA changes trigger reinspection instead of blind continuation
- [x] rescue rollback that restores only Rootbound-owned changes made after the rescue baseline, never pre-existing dirty worktree changes and never via `git reset`
- [x] rollback refuses files that diverged externally after Rootbound's last known SHA
- [x] safe return flow reports verified journal activity, current worktree state, commits when observable, remaining work and checkpoint destination

### KF-P2 — cold memory / quota presentation

- [x] on-demand search inside the original persisted Codex thread as cold memory; use occurrence search when accepted and bounded item-list fallback otherwise
- [x] richer quota-state presentation / rate-limit update observation without making continuity depend on quota availability

### Killer-flow non-goals

- no automatic Codex model turn
- no multi-agent orchestration
- no cloud Rootbound dependency
- no dashboard-first workflow
- no general task/project management layer
- no LLM summarization inside Rootbound for resume selection; Rootbound projects bounded facts, ChatGPT reasons over them
- no Rescue Card UI; ambiguity is represented as structured tool output and ChatGPT asks only when necessary

## Release / CI hardening completed

- [x] push-triggered noisy V5 workflow disabled
- [x] workflow is `workflow_dispatch` only during stabilization
- [x] nonexistent CI paths `src/error-contract.mjs` / `src/undo-store.mjs` fixed
- [x] old repo-search unit test aligned with paginated implementation
- [x] doctor / public contract fixed to avoid stale hardcoded tool counts
- [x] `test/source-integrity-v5.mjs` checks relative import targets and npm script paths
- [x] `test/release-contract-v5.mjs` guards surface / docs / metadata / manual-CI policy
- [x] release contract guards one-command onboarding as the normal README flow
- [x] `test/tunnel-bootstrap-v5.mjs` covers managed tunnel discovery/config/secret isolation/cleanup without network
- [x] README rewritten around one-command onboarding
- [x] SECURITY rewritten around guided tunnel secret boundary
- [x] stale Chinese V4 README replaced with explicit V5-sync notice
- [x] EXPORT_SYNC rewritten around V5 source-of-truth contracts
- [x] package metadata points at `LeoMbm/Rootbound`
- [x] durable plan included in package file list

## Validation evidence already obtained

Before the guided-connect implementation was added, a trusted Apple Silicon Mac completed successfully:

- `npm ci`
- strict shrinkwrap check
- `npm run validate:v5`
- `npm test`
- `npm pack --dry-run`
- `npm run validate:release`

Real local acceptance also demonstrated:

- exact-root trust creation with backup
- `doctor` status `ok`
- `self-test` PASS for App Server, read, model-free command and workspace write/read/delete cleanup
- project persisted as trusted
- supervised runtime reached `running`
- tunnel child PID was present
- no Codex model turn was started by self-test

Those results prove the core V5 lane, but **they do not certify the new guided-connect code added afterward**. Re-run the release suite and then exercise a clean guided setup before merge.

## Current automated suite

`npm run test:v5` starts with source-integrity validation, then covers:

- foundation / trust
- runtime state
- persistent continuity
- quota-rescue session state / integrity matching / drift / guarded rollback / handoff / cold-memory search
- SQLite migration / command chunks
- long-command manager
- workspace open
- typed errors
- diagnostics / redaction
- edit undo / redo
- pagination
- continuity idempotency
- secret boundaries
- guided tunnel bootstrap
- persistent/manual tunnel config
- static release contract

## CI policy during stabilization

The V5 GitHub Actions workflow remains manual-only.

Do not restore push / PR triggers until:

1. the post-wizard `npm run validate:v5` passes on trusted execution;
2. syntax checks pass;
3. the full repository test run is reviewed;
4. one controlled macOS + Windows validation run is green;
5. notification policy is chosen deliberately.

## Remaining release blockers

### Post-wizard automated validation

- [ ] trusted-machine `npm run validate:v5` after guided-connect changes
- [ ] trusted-machine `npm test` after guided-connect changes
- [ ] `npm pack --dry-run` + packed-file review after guided-connect changes
- [ ] `npm run validate:release` after guided-connect changes
- [ ] one controlled Mac + Windows validation run before supported release

### Real-machine Mac acceptance

Already proven before the guided wizard:

- [x] exact-root trust
- [x] doctor
- [x] self-test read/command/write cleanup
- [x] project registry
- [x] supervised runtime running

Must now be repeated/extended with the new normal flow:

- [ ] stop current runtime
- [ ] clear Rootbound tunnel config/state
- [ ] run plain `rootbound connect .` and verify tunnel discovery/reuse
- [ ] verify runtime key never echoes and managed secret file is `0600`
- [ ] verify `tunnel-client doctor` is automatic
- [ ] verify already trusted project does not prompt again
- [ ] `status`
- [ ] real ChatGPT `workspace_open`
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
- [ ] plain `rootbound connect .` guided tunnel flow
- [ ] current-account ACL applied to guided tunnel key
- [ ] exact-root trust without repeat prompt
- [ ] workspace/read/edit/short-command path
- [ ] buffered long-command fallback
- [ ] explicit stdin streaming unsupported error
- [ ] diagnostic export
- [ ] upgrade / uninstall preservation

### Final release hygiene

- [ ] final branch diff review
- [ ] third-party notices / package contents review
- [ ] verify private vulnerability-reporting route
- [ ] update draft PR with final validation evidence

## Definition of done

V5 is ready to merge only when:

1. P0 implementation is complete, including one-command normal onboarding.
2. P1 implementation is complete or an item is explicitly deferred to P2.
3. no public tool can silently start a Codex model turn.
4. normal upgrade cannot delete Rootbound state.
5. credentials do not enter SQLite, command/tunnel argv, normal metadata, logs or diagnostics; the guided tunnel runtime key is isolated in dedicated private local secret state.
6. post-wizard `npm run test:v5`, `npm test` and release validation are green on trusted execution.
7. supported-OS validation is completed before release.
8. real-machine acceptance covers guided connect, command, edit, restart, upgrade and uninstall.
9. README / SECURITY / public contract match the implementation.
10. `main` remains untouched until that evidence exists.
