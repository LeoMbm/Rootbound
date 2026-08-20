# Rootbound continuity runtime

Rootbound treats the local work session as durable even when a Codex or ChatGPT conversation is temporary.

This document covers three V5 continuity features:

- Durable Rescue / Reattach
- Verified Handoff Manifest
- Rescue Autopilot

None of these features starts a Codex model turn.

## Durable Rescue / Reattach

A rescue session is persisted in Rootbound SQLite with its project, original Codex thread, continuity binding, baseline worktree fingerprint, expected worktree fingerprint, quota snapshot, and rollback coverage.

`codex.continuity_resume` first checks whether the authorized project already has an active rescue.

If an active rescue exists, Rootbound reattaches it only when:

1. the current worktree fingerprint exactly matches the rescue's last verified expected fingerprint;
2. the selected Codex thread is the same thread owned by the rescue;
3. exact-root project authority is still valid.

The same `rescueRef` is reused across ChatGPT conversations.

If the worktree changed outside Rootbound, reattachment fails closed with:

```text
DURABLE_RESCUE_DRIFT_DETECTED
```

If another Codex thread is requested while a project rescue is active:

```text
DURABLE_RESCUE_THREAD_CONFLICT
```

Rootbound serializes rescue creation inside the single runtime so simultaneous `continuity_resume` requests cannot create two fresh rescue sessions for the same project.

Remote transports do not assume that a transport session equals one ChatGPT conversation. ChatGPT must silently propagate the opaque `rescueRef` returned by `continuity_resume` when implicit scoping is unavailable.

## Verified Handoff Manifest

`codex.continuity_handoff` creates a manifest with schema:

```text
rootbound.continuity.v1
```

The manifest deliberately separates observed evidence from ChatGPT-reported semantic context.

### Verified section

Rootbound-observed evidence includes:

- rescue baseline fingerprint;
- final verified worktree fingerprint;
- commits between baseline HEAD and final HEAD;
- recorded rescue mutations with before/after hashes;
- bounded allowlisted continuity journal entries;
- SHA-256 of the human-readable checkpoint body.

Rollback snapshot file contents are never copied into the manifest.

### Reported section

The following are useful but are not claimed as independently verified facts:

- summary;
- decisions;
- remaining work.

They are stored under:

```json
{
  "source": "chatgpt_handoff_input",
  "verified": false
}
```

### Integrity

The complete manifest is canonicalized and hashed with SHA-256.

The full manifest is stored locally in the existing `checkpoints` table. The Codex thread receives a compact footer containing the schema, manifest hash, baseline HEAD, result HEAD, and result fingerprint.

No SQLite schema migration is required.

## Rescue Autopilot

Autopilot does not start a rescue automatically and does not open ChatGPT.

It pre-arms a candidate so that `@Rootbound continue` can avoid unnecessary discovery when quota is near exhaustion.

Rootbound polls the authoritative Codex App Server quota snapshot. The default policy is:

```text
poll interval: 60 seconds
arm threshold: 85%
```

Configuration:

```sh
ROOTBOUND_RESCUE_AUTOPILOT=0       # disable
ROOTBOUND_RESCUE_ARM_PERCENT=85    # 50..100
ROOTBOUND_RESCUE_POLL_MS=60000     # 10000..3600000
```

At or above the threshold Rootbound may persist a pre-arm event containing:

- candidate Codex thread ID;
- project worktree fingerprint hash;
- thread matching evidence;
- compact quota state;
- reset window.

A pre-arm event is never authoritative.

At `continuity_resume`, Rootbound requires the current fingerprint to still match and re-reads/re-scores the candidate thread. If validation fails, normal thread discovery is used instead.

Candidates expire and are periodically refreshed while quota remains high so an old compatible thread cannot remain pinned indefinitely.

### Unknown quota policy

If quota becomes unavailable or unknown, Rootbound does **not** arm and does **not** disarm.

A previously valid pre-arm remains unchanged until it naturally expires or an authoritative quota snapshot shows that usage is below the threshold.

Repeated identical polling errors are rate-limited in the event journal so a broken Codex authentication state cannot grow SQLite indefinitely.

## Safety invariants

The continuity runtime keeps these invariants:

```text
one Rootbound runtime
one active rescue per project
no Codex model turn started by continuity infrastructure
no automatic worktree mutation from Autopilot
no stale fingerprint accepted for reattach or pre-arm consumption
no ChatGPT summary represented as Rootbound-verified evidence
no rollback snapshot contents stored in manifests
```

## Release validation

Before release run:

```sh
npm run validate:release
```

The V5 suite includes dedicated coverage for:

- durable cross-chat reattachment;
- drift refusal;
- thread-conflict refusal;
- concurrent resume serialization;
- manifest determinism and secret-content exclusion;
- Autopilot arm/reuse/expiry/refresh;
- unknown-quota state preservation;
- authoritative disarm after quota reset.

A final real-machine smoke test should then validate:

1. Codex work near quota arms Rootbound;
2. a ChatGPT `@Rootbound continue` resumes the correct thread;
3. a second ChatGPT conversation reuses the same rescue;
4. the handoff injects a manifest hash into the original Codex thread;
5. Codex can continue from that thread after quota resets.
