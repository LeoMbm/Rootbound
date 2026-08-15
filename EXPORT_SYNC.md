# Public export / sync contract

Codexless is the **narrow public release tree**. The wider Toolwire development tree may contain private, experimental, or not-yet-accepted capabilities.

Synchronization is intentionally **one way**:

> wider upstream implementation → explicit public allowlist → Codexless → public acceptance

Do not make the public tree mirror the whole upstream tree. Do not copy a directory recursively and then try to delete private files afterward.

## Source-of-truth rule

The wider upstream implementation can continue evolving independently. A change reaches Codexless only after the relevant public capability has been accepted for compatibility, product behavior, and security.

The public contract is defined by:

- `src/surface-contracts.mjs`;
- the public source-file allowlist below;
- `test/public-contract.mjs`;
- the packed-artifact and privacy scans in this document.

The public tree must never become a second hand-maintained implementation with unrelated behavior. If a public capability changes upstream, either export the accepted change deliberately or keep Codexless on the previously accepted version.

## Current public source allowlist

The first Technical Preview contains only these runtime source files:

- `src/agent-card-ui.mjs`
- `src/agent-resource.mjs`
- `src/agent-tools.mjs`
- `src/browser-reader-executor.mjs`
- `src/browser-reader-tools.mjs`
- `src/codex-agent-executor.mjs`
- `src/codex-app-server-client.mjs`
- `src/codex-authority-executor.mjs`
- `src/codex-bin.mjs`
- `src/codex-permission-executor.mjs`
- `src/codex-preview-account-preflight.mjs`
- `src/codex-quota-snapshot.mjs`
- `src/construction-tools.mjs`
- `src/json-file.mjs`
- `src/mcp-http.mjs`
- `src/mcp-stdio.mjs`
- `src/metered-consent.mjs`
- `src/public-context-executor.mjs`
- `src/public-context-tools.mjs`
- `src/public-runtime.mjs`
- `src/public-server-factory.mjs`
- `src/surface-contracts.mjs`
- `src/toolbox-method-registry.mjs`

Adding another runtime source file is a public-surface decision, not a routine copy operation.

Release engineering files are also intentionally bounded: `scripts/doctor.mjs`, `scripts/resolve-codex.mjs`, `scripts/launch.mjs`, `scripts/install.ps1`, `scripts/uninstall.ps1`, `scripts/install.sh`, `scripts/uninstall.sh`, and the accepted `bin/codexless-*.cmd` / `bin/codexless-*.sh` launchers. The platform installers copy an explicit release-entry list instead of recursively mirroring the upstream development tree.

## Explicit exclusions

The export must not bring in implementation or registration for:

- raw host filesystem Workbench tools;
- generic host process / PTY controls or process receipts;
- Computer Use;
- generic MCP catalog or generic MCP call tools;
- direct Browser click/fill actions;
- private household integrations;
- local tunnel identities, tokens, endpoints, or machine-specific service configuration;
- local test fixtures that contain user/project data.

Known forbidden public tool names are also asserted in `test/public-contract.mjs`.

## Repeatable export checklist

For each upstream-to-public sync:

1. Identify the upstream commit/version being considered.
2. Identify the exact accepted public capability/change. Do not export unrelated upstream churn.
3. Copy only files in the current public allowlist, plus intentionally accepted new public files.
4. Review imports from every changed public file. Any new dependency or new internal module is a separate review item.
5. Confirm `src/surface-contracts.mjs` still contains the intended exact public tool list.
6. Install/freeze dependencies in the public tree itself and keep the release lockfile. Do not rely on a parent/global `NODE_PATH`; verify required packages resolve from this repository's own `node_modules`.
7. Run syntax checks on all public `.mjs` files.
8. Run `test/public-contract.mjs` through the public tree itself with `NODE_PATH` cleared. The contract intentionally poisons legacy `CODEX_TOOLBOX_*` variables so a regression cannot silently borrow household Toolwire configuration.
9. Start and probe both stdio and HTTP entry points from the public tree.
10. Verify HTTP binds only to loopback and health metadata does not expose the configured project path.
11. Run `npm pack --dry-run` and inspect the exact packed file list. While the README advertises the current broad package bounds, verify the package remains under 100 KB compressed / under 0.5 MB unpacked; if either bound is exceeded, update the README in the same release rather than leaving a stale size claim.
12. Scan the public tree and packed file list for secrets, user-specific absolute paths, tunnel IDs/URLs, account identifiers, and private project names.
13. Review `package.json`, lockfile, dependency versions, third-party notices, README, and SECURITY documentation for drift.
14. Run the release Golden path before declaring the exported version releasable.

If any step fails, the public export remains blocked even when the wider upstream implementation is healthy.

## Useful local verification commands

These commands are examples for the repository root. They do not replace review.

```powershell
Get-ChildItem src -Filter *.mjs -Recurse | ForEach-Object { node --check $_.FullName }
npm test
npm pack --dry-run
```

For machine-specific path/privacy scanning, inspect the actual release tree and packed list for strings such as the local user profile, mapped drives, tunnel IDs, bearer/token patterns, and internal-only project names. Do not commit the user's real paths as scan patterns into the public repository.

## Version mapping

Every published Codexless version should be traceable to the wider upstream revision(s) from which its accepted public slice was exported. The mapping can live in release notes or a release manifest; it does not require internal directory names to become public API.

The goal is simple: **one implementation lineage, two different exposure boundaries.**
