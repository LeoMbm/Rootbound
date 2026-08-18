# Public export / sync contract — V5

Codexless is the narrow public release tree. Wider upstream development may contain private, experimental, legacy or not-yet-accepted capabilities.

Synchronization is one way:

> wider implementation → explicit acceptance → Codexless V5 public contract → validation → release

Do not recursively mirror a wider development tree and then try to delete private capabilities afterward.

## Sources of truth

V5 intentionally avoids a giant hand-maintained runtime-file allowlist.

The public release boundary is defined by:

1. `src/surface-contracts.mjs` — exact public MCP tool names;
2. `config/toolbox-method-registry.json` — accepted model-free remote App Server methods;
3. `package.json#files` — files eligible for npm packaging;
4. `test/public-contract.mjs` — public MCP behavior / forbidden surface;
5. `test/release-contract-v5.mjs` — static release invariants;
6. `docs/plans/codexless-v5.md` — V5 acceptance checklist;
7. packed-artifact inspection before release.

Adding a new public tool, accepted remote method, packaged directory or release script is a release-boundary decision and must be reviewed as such.

## Public V5 rules

A sync must preserve all of these properties:

- `codexless-public-preview-v5` remains the intended public surface version;
- no `codex.agent_*`, model catalog or turn-start surface becomes public accidentally;
- nested Codex CLI launches remain blocked from the model-free command lane;
- remote callers cannot select arbitrary stronger local permission profiles;
- project trust remains exact-root and explicit;
- durable state remains outside the app install tree;
- persistent tunnel configuration does not contain literal credentials;
- sensitive files are not silently included in default project search/read flows;
- diagnostic export remains redacted;
- undo / redo remains SHA-guarded and does not snapshot sensitive paths;
- continuity retry semantics remain fail-closed around ambiguous external writes.

## Explicit exclusions

Do not export public registration for:

- unrestricted raw host filesystem APIs;
- unrestricted process / PTY control outside the accepted command surface;
- Computer Use;
- generic MCP catalog/call tooling;
- direct Browser click/fill/navigation tools;
- private household or personal integrations;
- local tunnel identities, literal tokens, endpoint secrets or machine-specific service configuration;
- private user/project fixtures;
- Codex model routing or Agent delegation unless a future public contract explicitly re-accepts it.

Legacy modules may remain in the repository for compatibility or internal tests without becoming public tools. Public exposure is determined by the public server / surface contract, not merely by file existence.

## Sync checklist

For each upstream-to-public change:

1. identify the upstream commit/version being considered;
2. identify the exact capability change being accepted;
3. review every new / changed import;
4. review `src/surface-contracts.mjs`;
5. review `config/toolbox-method-registry.json` when App Server methods change;
6. review `package.json#files` when new packaged paths are introduced;
7. run syntax checks on all changed public runtime files;
8. run `npm run test:v5`;
9. run `npm test` on trusted execution;
10. start and probe stdio and HTTP entry points;
11. verify HTTP remains loopback-only;
12. run `npm pack --dry-run`;
13. inspect the packed file list;
14. scan the release tree / artifact for secrets and machine-specific private paths;
15. review README, SECURITY and the V5 plan for drift;
16. run the real-machine V5 golden path on supported platforms;
17. attach validation evidence before merge / release.

If any required step fails, the public export remains blocked even if the wider upstream implementation works.

## CI policy during V5 stabilization

The V5 Actions workflow is intentionally manual-only (`workflow_dispatch`).

Do not restore per-push CI until a controlled manual matrix is green. The previous push-triggered matrix generated repeated failure notifications while contracts were still changing.

The release contract test must keep asserting that the workflow remains manual during this stabilization phase.

## Lockfile rule

Do not hand-edit npm dependency integrity data.

When `package.json` root metadata changes without dependency changes, regenerate the lockfile metadata with npm on a trusted execution machine. When dependencies change, regenerate and review the complete lock update normally.

## Golden path

Before V5 is considered releasable, verify at minimum:

```text
install
→ tunnel configure
→ connect project
→ workspace_open
→ read/search
→ short command
→ long command + poll
→ edit + undo + redo
→ continuity checkpoint
→ runtime restart
→ diagnostic export
→ staged upgrade
→ uninstall preserving state
```

Windows acceptance must additionally verify explicit fallback / unsupported behavior for interactive command streaming.

## Version mapping

Every published Codexless release should be traceable to the upstream revision(s) from which its accepted public slice was derived. This mapping can live in release notes or a release manifest.

The goal remains:

> one implementation lineage, explicit public exposure boundaries, reproducible release evidence.
