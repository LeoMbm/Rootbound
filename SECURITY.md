# Security

Rootbound is a local execution bridge. It can read project files, edit files, and run commands under authority resolved from the user's local Codex environment. Treat it with the same care as other local development tooling that can affect real repositories.

This document describes the **Rootbound V5 public surface** on the V5 feature branch.

## Core security rules

V5 is built around these rules:

1. **Codex remains the local authority / sandbox source.**
2. **Rootbound may narrow authority, but a remote caller must not silently widen it.**
3. **Permission / trust denial fails visibly.**
4. **The public ChatGPT lane must not silently start a Codex model turn.**
5. **Credentials must not enter ordinary durable state such as SQLite, command argv, logs, diagnostics, or non-secret tunnel metadata.** A credential that the guided tunnel setup must retain is isolated in a dedicated local private-secret file with restricted permissions.
6. **Ambiguous retries must fail closed when replay could duplicate an external mutation.**

Rootbound is not a magic sandbox around deliberately broad local permissions. If the user grants broad workspace authority locally, authorized Rootbound operations can be correspondingly powerful.

---

## Public surface boundary

The canonical public surface is defined only in `src/surface-contracts.mjs` and tested by `test/public-contract.mjs`.

Current V5 surface:

- `rootbound-public-preview-v5`
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

For normal onboarding, `rootbound connect .` is a guided setup. It:

1. resolves the canonical project / Git root;
2. resolves or creates the local tunnel configuration and validates it before touching Codex trust;
3. requires interactive approval or explicit `--yes` before adding a previously untrusted root;
4. skips the prompt only when that exact canonical root is already trusted;
5. backs up Codex config;
6. adds only the exact project root;
7. runs doctor / authority validation;
8. restores the previous config if post-trust validation fails.

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

For eligible precise edits, Rootbound stores exact before/after UTF-8 snapshots locally and records before/after SHA-256 values.

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

V5 separates ordinary durable state from credentials needed by the local tunnel runtime.

### Durable commands

Detectable credential-like argv values are rejected before command rows are inserted into SQLite.

### Continuity journals

Command labels stored for continuity are redacted; raw argv is not copied into the checkpoint journal.

### Guided tunnel setup

Normal users run:

```text
rootbound connect .
```

The wizard may need a Tunnel runtime API key. It first reuses `CONTROL_PLANE_API_KEY` / `OPENAI_API_KEY` when already present. Otherwise interactive input is hidden while the key is entered.

When Rootbound needs to retain that key for future supervised starts, it is written to a dedicated local secret file under the Rootbound state directory. The generated tunnel-client profile contains only a `file:` reference to that secret file.

The runtime key is intentionally excluded from:

- `tunnel.json`;
- the tunnel process argv;
- SQLite;
- Rootbound supervisor logs;
- diagnostics;
- generated README/config examples.

File protections:

- macOS / POSIX: the secret file is written mode `0600`;
- Windows: Rootbound removes inherited ACLs and grants full access to the current Windows account with `icacls`; setup fails closed if that ACL hardening cannot be applied.

`tunnel-client doctor` is run against the generated profile before Codex trust is changed. If guided tunnel setup validation fails, Rootbound removes the generated tunnel metadata/profile/secret artifacts.

`rootbound tunnel clear` also removes the guided tunnel profile and dedicated secret file. An environment override such as `ROOTBOUND_TUNNEL_ARGV_JSON` remains outside Rootbound's control and is reported as still active.

This Technical Preview uses filesystem permissions / ACLs for the guided local tunnel secret rather than claiming OS Keychain or Credential Manager vault integration.

### Advanced manual tunnel configuration

`rootbound tunnel configure ...` remains an operator/debug path.

Persistent manual tunnel config stores an argv **template**, not literal secret values. Detectable literal credentials are rejected; secret arguments should use placeholders such as:

```text
{env:TUNNEL_TOKEN}
```

The environment variable is resolved only when the tunnel launches.

Tunnel URL query parameters containing token / key / auth / secret values are refused for persistent manual config.

### Sensitive paths

Common sensitive files include `.env*`, credential / secret JSON files, private-key names and PEM / key material.

- search excludes them by default;
- `read_many` refuses them by default;
- undo snapshots are disabled for them even when an explicit edit is authorized.

These patterns reduce accidental leakage; they are not proof that every secret file in every repository will be correctly named.

---

## Diagnostics / logging

`rootbound diagnostic` is designed for support without dumping project contents.

Diagnostic output intentionally excludes:

- command stdout;
- command stderr;
- command argv;
- stored thread previews;
- full thread identifiers;
- guided tunnel secret contents.

It redacts:

- home-directory paths;
- Bearer tokens;
- token / key / auth / secret / password query parameters;
- common standalone credential assignments;
- common key prefixes.

Tunnel status can describe its non-secret launch template / source, but must not print the guided runtime key.

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

Normal ChatGPT access uses the authenticated OpenAI tunnel path and launches Rootbound over stdio. The HTTP launcher remains an advanced/local compatibility surface, not the normal V5 onboarding path.

Rootbound manages the local stdio command/profile and secret boundary, but it does not control the security of external tunnel infrastructure or a separately supplied manual tunnel command.

---

## Installer / upgrade / uninstall

V5 separates the app tree from the state tree.

macOS default:

```text
~/Library/Application Support/Rootbound/app
~/Library/Application Support/Rootbound/state
```

Windows default:

```text
%LOCALAPPDATA%\Rootbound\app
%LOCALAPPDATA%\Rootbound\state
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
- legacy Windows root-layout migration installs the new app under `app/` rather than moving / deleting the state root;
- Mac lifecycle/stdio launchers are marked executable by the installer.

The installer itself does not create project trust or tunnel credentials. Those changes happen only through explicit `rootbound connect` onboarding.

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
- inspect the packed artifact;
- run guided `rootbound connect .` acceptance on a real Mac;
- run one controlled macOS + Windows matrix / real-machine acceptance before supported release;
- scan the artifact and repository for secrets / machine paths;
- run real-machine command / edit / restart / upgrade / uninstall acceptance.

The V5 workflow is intentionally manual-only while stabilization is in progress; noisy failing CI must not be re-enabled on every push before it is green.

---

## Known limitations

The Technical Preview is not a claim of production hardening.

Known limitations include:

- Intel macOS is not part of the supported preview;
- Windows long-command interactivity is limited by the accepted App Server implementation and uses explicit fallback behavior;
- the guided tunnel runtime key is protected by filesystem permissions / ACLs rather than OS-native vault integration;
- sensitive-file detection is heuristic and filename-based;
- argv inspection cannot prevent deliberately obfuscated secondary process execution in arbitrary custom code;
- Browser Reader is read-first rather than a general browser agent;
- final V5 release still requires controlled CI and real-machine acceptance evidence.

The durable acceptance checklist is maintained in `docs/plans/rootbound-v5.md`.

---

## Reporting a vulnerability

Do not publish credentials, private project data or a working exploit in a public issue.

Before public launch, the repository should have a verified private vulnerability-reporting route. If a private reporting mechanism is unavailable, do not post exploit details publicly; contact the maintainer through a private channel and treat the missing private-report route as a release blocker.
