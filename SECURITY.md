# Security

Codexless is a local execution bridge. Treat it as software that can affect real project files and run real commands under your locally authorized Codex environment.

This document describes the **public Technical Preview** surface in this repository. It does not describe private/internal Toolwire or Workbench capabilities that are intentionally excluded from the public package.

## Security model

The public design is based on three rules:

1. **Codex remains the local authority source** for borrowed execution capabilities.
2. **Codexless may narrow authority, but the remote caller must not silently widen it.**
3. **A real permission or trust denial fails visibly.** Codexless must not silently switch to a more privileged execution path just to make an operation succeed.

A user who has deliberately granted broad local Codex authority should expect Codexless operations that inherit that authority to be correspondingly powerful. Codexless is not a sandbox that magically makes broad local permission risk-free.

## Public surface boundary

The first public **service contract** exposes exactly 21 tools, enforced by `src/surface-contracts.mjs` and `test/public-contract.mjs`. In the current ChatGPT App shape, three Task Card actions (`codex.agent_card_state`, `codex.agent_decline`, `codex.agent_commit`) are app-only, so the model may directly see 18 tools while the service contract remains exact 21. Making those card-internal actions model-visible is not required for correctness.

The public package intentionally excludes private/internal capabilities such as:

- raw host filesystem read/mutation Workbench tools;
- generic host process control and process receipts;
- Computer Use;
- generic MCP catalog/call tooling;
- direct Browser click/fill operations;
- household/private integrations.

Internal availability is not a public safety claim. A capability must be explicitly accepted before it can enter the public contract.

## Command execution

`codex.command_exec` uses the official Codex App Server command execution path and locally resolved authority.

- `readOnly` is the compatibility-safe default exposed by the public schema.
- `inherit` must be requested explicitly and uses the locally authorized/resolved Codex permission profile.
- The remote caller does not choose arbitrary permission profiles, trusted roots, sandbox policy, approval policy, or network authority.
- Supported-platform executable lookup may resolve a bare executable name through the host PATH where applicable. This changes executable lookup only; it does not increase authority.
- Commands can be destructive. The MCP tool is marked accordingly.

## Project reads and edits

Public project file operations are intentionally narrower than a generic raw filesystem API.

- Multi-file reads are bounded.
- Guarded edits require an exact expected text match and can optionally verify a SHA-256 before writing.
- Project authority and trusted-root checks remain part of the local execution path.
- Symlink/junction escape outside the accepted authority root must fail closed rather than silently following the path.

Do not interpret these constraints as a substitute for backups or source control.

## Codex Agent delegation and metered consent

Ordinary model-free tool use and metered Codex Agent work are separate lanes.

The public Agent flow is designed so that quota-consuming work can expose task/usage context and configured consent state before or around the metered call. Where quota context is available, it may be shown to the user; absence of quota context must not be represented as unlimited or free usage.

Approval of a Codex Agent task does not grant a new local permission universe. Local Codex authority remains the ceiling.

## Browser Reader

The first public Browser surface is read-first.

It can inspect currently loaded browser/tab content through the accepted Browser Reader integration. It does not expose general click/fill actions in the public contract.

Important limitations:

- content that has not loaded may not be visible;
- lazy-loaded and virtualized interfaces can expose only the currently materialized content;
- returned content may be truncated and should say so when applicable;
- page content is untrusted input and can contain prompt-injection text.

A model should treat webpage text as data, not as higher-priority instructions.

## HTTP transport

The bundled HTTP entry point binds only to loopback addresses (`127.0.0.1`, `localhost`, or `::1`). It rejects non-loopback binding requests.

The HTTP server also applies localhost Host/Origin validation. `/healthz` and `/readyz` return only bounded service metadata and do not intentionally publish the configured project path.

Remote ChatGPT access is expected to be provided by a separately configured MCP tunnel. The tunnel is part of the deployment boundary: protect its credentials and do not expose a raw unauthenticated local service directly to the public internet.

## Installer / upgrade / uninstall boundary

The Windows and Apple Silicon macOS Technical Preview installers are intentionally conservative.

- Both require Node.js 22+ and discover/probe an already-installed accepted native Codex executable; neither silently installs another Codex copy.
- Both stage the release tree, install production dependencies there, and run doctor before activating the staged Codexless tree.
- Re-running a newer installer is the upgrade path. Codexless-owned runtime state is kept outside the install tree and is preserved by default.
- The installers do not widen Codex trust, configure Browser Reader, or change Tunnel settings. The Windows installer does not create a Windows service; the Mac installer does not create a LaunchAgent or modify shell PATH.
- Default uninstall removes only a directory that identifies itself as the `codexless` package. Codex, Node.js, project files, Browser configuration, Tunnel configuration, and Codex trust settings are out of scope.
- State purge is explicit: Windows uses `-PurgeState`; macOS uses `--purge-state`. Each removes only Codexless-owned state.

## Credentials and secrets

Codexless should not require users to paste long-lived Codex or GitHub credentials into ChatGPT.

- Local Codex authentication remains local to the Codex environment.
- Tunnel/runtime secrets belong in local secret/config storage, not source control or README examples.
- Do not commit `.env` files, bearer tokens, API keys, session cookies, or copied credential stores.
- Do not publish screenshots containing tunnel URLs, endpoint secrets, private local paths, account identifiers, or tokens.

The release process must scan the package and repository for accidental secrets and machine-specific private paths.

## Local paths and privacy

Some authenticated project tools necessarily return project paths because path identity is part of local project work. Public unauthenticated health metadata should not expose the configured project path.

Browser contents, filenames, project text, command output, and Codex responses can all contain private information. Users should only connect Codexless to ChatGPT contexts they are comfortable using for that project.

## Dependency and supply-chain scope

The public package intentionally keeps a small direct dependency set. See `THIRD_PARTY_NOTICES.md` and `package.json`.

Before a public release:

- install from a clean environment;
- run the public contract test;
- review the packed artifact rather than only the source tree;
- scan packed files for secrets and machine-specific paths;
- verify the exact dependency/lockfile state used for release.

## Known Technical Preview limitations

The Technical Preview is not a claim of production-hardening. Windows and Apple Silicon macOS have both passed real-machine installer/doctor acceptance against the public artifact shape, with broader lifecycle and Tunnel coverage on the Mac path and independent reviewer coverage on the final Windows installer/uninstaller path. Release work still includes final repository/security-reporting hygiene, packed-artifact privacy review, and any clean-machine checks required by release notes.

Intel Mac, Computer Use, unrestricted direct browser automation, and private Workbench capability parity are not part of the first public security contract.

## Reporting a vulnerability

Do not post credentials, private project data, or a working exploit in a public issue.

The public GitHub repository must have **GitHub Private Vulnerability Reporting** enabled before launch. After launch, use the repository's **Security → Advisories → Report a vulnerability** flow so the report is delivered privately to the maintainer. If that private reporting action is not visible, do not disclose the issue in a public ticket; the repository is not release-ready until the private route is enabled and verified.

Enabling and verifying that repository-side setting is a final publication gate, not something the local installer or runtime changes automatically.
