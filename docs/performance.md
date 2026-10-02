# Rootbound performance validation

This document records the performance methodology for the authority-runtime
optimizations introduced on `perf/authority-runtime-v1`.

The goal is to make ordinary Rootbound work faster without weakening any of the
existing trust, project-scope, permission, secret, rescue, or edit-verification
boundaries.

## What changed

- Authority App Server processes are kept warm and are recycled instead of
  being spawned for every authority resolution or command.
- Warm clients are bounded by both age and use count, are recycled after
  failures, and are closed with the Rootbound runtime.
- Tool-internal authority leases reuse one validated authority decision for
  related operations while still allowing write-capable leases to downscope
  individual reads to `:read-only`.
- `repo_search` no longer resolves authority and then resolves it again for
  the search command.
- `read_many` resolves authority once and batches small validated files into
  one sandbox command. Large/atypical batches fail back to the existing
  sequential read path.
- `precise_edit` keeps its before-SHA, occurrence-count, pre-write guard and
  after-SHA verification while reusing one authority lease.
- Long commands support an optional bounded `command_poll.waitMs` so callers
  can wait locally for output/completion instead of repeatedly round-tripping.

## Safety invariants retained

The optimization does **not** cache or bypass:

- connection/project scope resolution;
- canonical cwd/path checks;
- Codex config/trust inspection during authority resolution;
- `permissionProfile/list` validation;
- read-only downscoping;
- nested-Codex command refusal;
- sensitive-path policy;
- precise-edit SHA/occurrence guards;
- rescue drift checks and mutation snapshots.

A read-only authority lease cannot be escalated to `inherit`.

## Reproducible benchmark

The benchmark harness is:

```sh
npm run bench:authority -- --cwd /path/to/Rootbound --iterations 7 --warmups 1 --synthetic
```

Synthetic mode uses the real Rootbound authority executor, repository-search
helper and read-many helper. It substitutes only the Codex App Server transport
with a deterministic local client:

- App Server startup cost: 100 ms
- App Server RPC cost: 2 ms
- actual helper commands still execute locally
- legacy mode hides the new authority-lease API and recycles after every
  authority use, reproducing the former resolve/exec lifecycle
- warm mode uses the production warm-client + authority-lease + read batching
  path

This benchmark is intended to prove lifecycle/RPC reductions and compare the
same code paths reproducibly. Its millisecond values are **not** a claim about
the exact latency on every Mac or Codex build.

### 2026-10-02 synthetic result

Apple Silicon macOS, Node v24.10.0, 7 measured iterations after 1 warmup:

| Scenario | Legacy median | Optimized median | Speedup |
| --- | ---: | ---: | ---: |
| Authority resolution | 105.95 ms | 4.97 ms | 21.32x |
| No-op command | 154.69 ms | 30.39 ms | 5.09x |
| Repository search | 302.84 ms | 57.90 ms | 5.23x |
| Read 3 files | 560.40 ms | 29.67 ms | 18.89x |

Across the complete benchmark suite:

- authority clients created: **65 -> 1**
- authority clients started: **65 -> 1**
- authority RPCs: **130 -> 66**
- sandbox command executions: **40 -> 24**

The command-count reduction comes primarily from `read_many` batching; the
RPC reduction comes from eliminating duplicate authority resolution inside a
single tool operation.

## End-to-end baseline observed before installing the branch

The currently installed `0.1.0-preview.4` runtime was measured through the
actual Rootbound connector, three times per operation:

| Operation | Samples | Median |
| --- | --- | ---: |
| `repo_search` | 2622 / 2610 / 2437 ms | 2610 ms |
| `read_many` (3 files) | 1320 / 1410 / 1248 ms | 1320 ms |
| `git_status` | 2313 / 2666 / 2292 ms | 2313 ms |

These figures include ChatGPT/tunnel/connector transport and the installed
Rootbound runtime. They are a baseline, **not** directly comparable to the
synthetic numbers above. A true end-to-end after measurement must be run after
installing this branch.

## Real Codex benchmark

From a normal host terminal, outside a Rootbound/Codex sandbox:

```sh
npm run bench:authority -- --cwd /path/to/Rootbound --iterations 7 --warmups 1
```

An isolated writable Codex state can be requested with:

```sh
npm run bench:authority -- --cwd /path/to/Rootbound --iterations 7 --warmups 1 --isolated-codex-home
```

Do not use the real mode from inside an already sandboxed Rootbound command.
Nested Codex `command/exec` is rejected by the macOS sandbox. This is an
environment limitation: the same `public-multiproject-scope-v6` integration
test fails with `sandbox-exec: sandbox_apply: Operation not permitted` on an
untouched `origin/main` worktree under the same outer sandbox.

### 2026-10-02 real host result before the search-candidate fix

Codex CLI 0.144.1, Apple Silicon macOS, Node v24.10.0:

| Scenario | Median | p95 |
| --- | ---: | ---: |
| Authority resolution | 6.84 ms | 10.44 ms |
| No-op command | 53.97 ms | 61.62 ms |
| Repository search | 1659.48 ms | 1798.33 ms |
| Read 3 files | 61.63 ms | 82.42 ms |

This validated the warm App Server and read batching on the real Codex runtime,
but exposed a remaining repository-search bottleneck.

Profiling showed:

- `git ls-files -co --exclude-standard -z`: roughly **1.5-1.9 seconds**
  in the Codex sandbox on this Mac;
- `rg --files --null --no-ignore-dot`: roughly **0-10 ms**;
- direct `rg` text search for the benchmark pattern: roughly **0-30 ms**.

The slow Git enumeration also emitted macOS Developer Tools/`xcrun` cache
warnings from inside the sandbox. Rootbound therefore now prefers ripgrep only
for **candidate-file enumeration**. Matching remains Rootbound's JavaScript
regex engine, so cursor semantics and query behavior do not depend on ripgrep's
regex dialect.

Candidate enumeration order is:

1. `rg --files --null --no-ignore-dot`;
2. existing `git ls-files -co --exclude-standard -z` fallback;
3. filesystem walk fallback.

Sensitive searches still use the explicit filesystem-walk path so that hidden
or secret-bearing files are only included when the caller intentionally sets
`includeSensitive=true`.

The benchmark output exposes `diagnostics.repoSearchCandidateEngine` so real
host runs can confirm which enumerator was used.

## Why ripgrep is limited to candidate enumeration

The user-facing search engine was **not** replaced with ripgrep. Only file
enumeration uses it when available. This preserves deterministic global
pagination, JavaScript-regex compatibility, sensitive-path behavior and the
existing Rootbound result format while removing the measured Git startup cost.

## Why global concurrency was not increased

`maxConcurrent: 1` currently gates buffered `codex.command_exec`; it is not
a global lock over every Rootbound tool. Raising it blindly would not address
the measured authority-lifecycle bottleneck and could add mutation races.

Read batching and local long-polling reduce round trips without changing the
write-serialization safety model.

## Release acceptance

Before merging/releasing this branch:

1. Run the deterministic benchmark and retain its JSON output.
2. Run syntax, lock, unit and contract tests.
3. Run the real Codex benchmark from a normal host terminal.
4. Install the branch in a disposable/preview Rootbound installation.
5. Repeat the end-to-end connector measurements above.
6. Run the existing real-Mac multi-project smoke test.
7. Confirm an authority client recovers after forced App Server termination.
