# Security

Codexless is a local execution bridge. It can read project files, edit files, and run commands under authority resolved from the user's local Codex environment. Treat it with the same care as other local development tooling that can affect real repositories.

This document describes the **Codexless V5 public surface** on the V5 feature branch.

## Core security rules

V5 is built around these rules:

1. **Codex remains the local authority / sandbox source.**
2. **Codexless may narrow authority, but a remote caller must not silently widen it.**
3. **Permission / trust denial fails visibly.**
4. **The public ChatGPT lane must not silently start a Codex model turn.**
5. **Durable state must not knowingly persist literal credentials.**
6. **Ambiguous retries must fail closed when replay could duplicate an external mutation.**

Codexless is not a magic sandbox around deliberately broad local permissions. If the user grants broad workspace authority locally, authorized Codexless operations can be correspondingly powerful.

---

## Public surface boundary

The canonical public surface is defined only in `src/surface-contracts.mjs` and tested by `test/public-contract.mjs`.

Current V5 surface:

- `codexless-public-preview-v5`
- 27 public tools
- no public model catalog
- no public Codex Agent / turn-start tool
- no public quota-routing surface

Private/internal capabilities do not automatically become public capabilities.

The public package intentionally excludes generic unrestricted host filesystem / process control, unrestricted Browser operation, Computer Use and arbitrary model delegation.

---

## Model-free command lane

Public command tools are:

- `codex.command_exec`
- `codex.command_start`
- `codex.command_poll`
- `codex.command_write`
- `codex.command_terminate`

These use accepted Codex App Server command primitives under locally resolved authority and are not a public Codex model lane.

Security properties:

- direct Codex CLI launches are rejected;
- recognized wrappers carrying a Codex launch are rejected;
- model / token-usage side effects observed during the accepted streaming lane fail closed;
- the caller cannot choose arbitrary local permission profiles;
- `readOnly` downscoping remains available;
- destructive commands remain destructive and are marked accordingly;
- durable commands reject detectable literal credentials before argv is written to SQLite.

The nested-command classifier is a product guard, not a general adversarial-process sandbox. Arbitrary code execution can deliberately hide secondary process launches; V5 does not claim to solve that impossible problem by argv inspection alone. The supported model-facing contract must not deliberately disguise Codex model execution inside unrelated commands.

### Long-running command output

Long-command output is stored incrementally in bounded SQLite chunks.

- callers poll with cursors rather than repeatedly receiving the full output;
- output storage is capped;
- truncation is surfaced;
- durable command argv is subject to secret detection before persistence.

Interactive App Server command streaming is used where the accepted implementation supports it. Windows fallback behavior is explicit; unavailable stdin streaming must return an unsupported error rather than pretending to work.

---

## Project trust

Project trust is exact-root and explicit.

`codexless connect`:

1. resolves the canonical project / Git root;
2. validates tunnel configuration before touching trust;
3. requires interactive approval or explicit `--yes`;
4. backs up Codex config;
5. adds only the exact project root;
6. runs doctor / authority validation;
7. restores the previous config if validation fails.

`codex.workspace_open` never creates or widens trust as a side effect. An unauthorized workspace returns a typed `needs_trust` state.

---

## Project reads

Public project reads are deliberately narrower than a generic filesystem API.

### `codex.read_many`

- canonicalizes real paths;
- requires paths to remain inside the accepted authority root;
- paginates bounded UTF-8 output;
- binds cursors to request parameters;
- stores the current file SHA in pagination state;
- refuses continuation if the source file changed between pages.

Sensitive paths such as `.env`, credentials and private keys are refused by default and require explicit `allowSensitive: true`.

### `codex.repo_search`

Search is paginated and request-bound. Sensitive file patterns are excluded by default and require explicit opt-in.

Returned project data can still contain secrets even when the path is not conventionally sensitive. ChatGPT and the user remain responsible for the destination context in which project data is used.

---

## Project edits

### `codex.precise_edit`

Guarded precise edits:

- canonicalize the target;
- verify that it stays inside the effective workspace;
- verify exact expected-text occurrence count;
- optionally verify an expected SHA-256;
- revalidate the SHA immediately before writing inside the authorized command lane;
- verify the final hash after writing.

### Undo / redo

`codex.edit_undo` and `codex.edit_redo` do **not** use `git reset`.

For eligible precise edits, Codexless stores exact before/after UTF-8 snapshots locally and records before/after SHA-256 values.

Undo is allowed only if the current file still equals the recorded after-hash. Redo is allowed only if the current file still equals the recorded before-hash. Any external modification causes `UNDO_CONFLICT` and the operation fails closed.

Sensitive files never enter the undo snapshot store. The sensitive-path decision is also checked on the canonical `realpath`, so a benign-looking symlink cannot snapshot a `.env` / key file indirectly.

Backups and source control remain recommended; undo/redo is a guarded convenience, not a replacement for them.

---

## Continuity / stored Codex history

History tools are read-only unless explicitly performing a continuity checkpoint.

Raw reasoning content is not exposed by the public history projection.

Continuity bindings and checkpoint metadata are persisted locally in SQLite.

### Idempotent retries

`continuity_bind` and `continuity_checkpoint` support optional idempotency keys.

Checkpoint flow uses fail-closed state:

1. record `pending` locally;
2. perform external thread injection;
3. acknowledge the local checkpoint;
4. store `completed` replay data.

If a connection fails in the ambiguous interval after `pending`, a retry with the same key returns `IDEMPOTENCY_IN_DOUBT` instead of blindly injecting the checkpoint again.

Reusing the same idempotency key with a different request payload is rejected.

---

## Secret boundaries

V5 tries to minimize accidental durable secret storage.

### Durable commands

Detectable credential-like argv values are rejected before command rows are inserted into SQLite.

### Continuity journals

Command labels stored for continuity are redacted; raw argv is not copied into the checkpoint journal.

### Tunnel configuration

Persistent tunnel config stores an argv **template**, not literal secret values.

Literal credentials are rejected. Secret arguments should use placeholders such as:

```text
{env:TUNNEL_TOKEN}
```

The environment variable is resolved only when the tunnel launches.

Tunnel URL query parameters containing token / key / auth / secret values are refused for persistent config.

### Sensitive paths

Common sensitive files include `.env*`, credential / secret JSON files, private-key names and PEM / key material.

- search excludes them by default;
- `read_many` refuses them by default;
- undo snapshots are disabled for them even when an explicit edit is authorized.

These patterns reduce accidental leakage; they are not proof that every secret file in every repository will be correctly named.

---

## Diagnostics / logging

`codexless diagnostic` is designed for support without dumping project contents.

Diagnostic output intentionally excludes:

- command stdout;
- command stderr;
- command argv;
- stored thread previews;
- full thread identifiers.

It redacts:

- home-directory paths;
- Bearer tokens;
- token / key / auth / secret / password query parameters;
- common standalone credential assignments;
- common key prefixes.

Tunnel status may include template placeholders / required environment variable **names**, but not their values.

Supervisor logs carry a `runtimeId`, which is also stored in runtime state for correlation.

No redactor is perfect. Review diagnostic bundles before sharing them outside your trusted support context.

---

## Browser Reader

The public Browser surface is read-first:

- `codex.browser_status`
- `codex.browser_tabs`
- `codex.browser_read`

It does not expose general click / fill / navigation actions in the public V5 contract.

Webpage content is untrusted input and can contain prompt injection. A model must treat page text as data, not higher-priority instructions.

---

## HTTP / tunnel boundary

The local HTTP entry point is intended for loopback only. Raw unauthenticated local service exposure to the public internet is not a supported deployment.

Remote ChatGPT access is expected to use a separately authenticated MCP tunnel / remote endpoint path.

Tunnel credentials belong in local environment / secret storage, not source control, README examples, screenshots or diagnostic bundles.

Codexless supports persistent non-secret tunnel argv templates; it does not claim that every third-party tunnel client's own credential handling is controlled by Codexless.

---

## Installer / upgrade / uninstall

V5 separates the app tree from the state tree.

macOS default:

```text
~/Library/Application Support/Codexless/app
~/Library/Application Support/Codexless/state
```

Windows default:

```text
%LOCALAPPDATA%\Codexless\app
%LOCALAPPDATA%\Codexless\state
```

Security / durability properties:

- Node >= 22.13.0 is required;
- installers use staging before activation;
- doctor runs before the staged app becomes active;
- existing app installs are backed up during staged replacement;
- state lives outside the app tree;
- normal uninstall preserves state;
- state purge is explicit;
- upgrade stops the runtime first;
- legacy Windows root-layout migration installs the new app under `app/` rather than moving / deleting the state root.

The installer does not silently create project trust or persist tunnel credentials.

---

## Typed error contract

Migrated V5 tools use machine-readable errors with fields such as:

- `errorCode`
- `category`
- `retryable`
- `nextActions`
- `operation`
- `surfaceVersion`

Clients should use these fields instead of parsing human error strings.

---

## Dependency / release boundary

Before a V5 release or merge:

- install dependencies from a clean trusted environment;
- regenerate npm lock root metadata using npm, not hand edits;
- run `npm run test:v5`;
- run the full test suite;
- run one controlled macOS + Windows GitHub Actions matrix;
- inspect the packed artifact;
- scan the artifact and repository for secrets / machine paths;
- run real-machine connect / command / edit / restart / upgrade / uninstall acceptance.

The V5 workflow is intentionally manual-only while stabilization is in progress; noisy failing CI must not be re-enabled on every push before it is green.

---

## Known limitations

The Technical Preview is not a claim of production hardening.

Known limitations include:

- Intel macOS is not part of the supported preview;
- Windows long-command interactivity is limited by the accepted App Server implementation and uses explicit fallback behavior;
- sensitive-file detection is heuristic and filename-based;
- argv inspection cannot prevent deliberately obfuscated secondary process execution in arbitrary custom code;
- Browser Reader is read-first rather than a general browser agent;
- final V5 release still requires controlled CI and real-machine acceptance evidence.

The durable acceptance checklist is maintained in `docs/plans/codexless-v5.md`.

---

## Reporting a vulnerability

Do not publish credentials, private project data or a working exploit in a public issue.

Before public launch, the repository should have a verified private vulnerability-reporting route. If a private reporting mechanism is unavailable, do not post exploit details publicly; contact the maintainer through a private channel and treat the missing private-report route as a release blocker.
