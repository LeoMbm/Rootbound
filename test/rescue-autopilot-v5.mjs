import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRescueAutopilot } from "../src/rescue-autopilot.mjs";
import { resolveRootboundPaths } from "../src/state-paths.mjs";
import { openStateStore } from "../src/state-store.mjs";

const home = await mkdtemp(path.join(os.tmpdir(), "rootbound-autopilot-"));
const repo = path.join(home, "repo");
await mkdir(repo, { recursive: true });
const paths = resolveRootboundPaths({ env: { ROOTBOUND_HOME: home } });
const store = await openStateStore({ paths });

try {
  const project = {
    projectRef: "project_autopilot",
    root: repo,
    gitRoot: repo,
    name: "repo",
    trusted: true,
    createdAt: 1,
    updatedAt: 1,
    lastConnectedAt: 1,
  };
  store.upsertProject(project);

  const fingerprint = {
    root: repo,
    head: "abc",
    branch: "main",
    origin: "git@example/repo",
    status: "",
    files: [],
    degraded: false,
    totalChangedPaths: 0,
    fingerprintHash: "fingerprint-abc",
    dirty: false,
    changes: [],
  };
  const thread = {
    id: "thread_autopilot",
    cwd: repo,
    preview: "work",
    recencyAt: 100,
    gitInfo: { sha: "abc", branch: "main", originUrl: "git@example/repo" },
  };

  let usedPercent = 90;
  const publicContext = {
    async quotaSnapshot() {
      return {
        status: "ok",
        observedAt: "2026-08-21T00:00:00.000Z",
        codex: {
          availability: usedPercent >= 100 ? "exhausted" : "available",
          exhausted: usedPercent >= 100,
          resetsAt: 999,
          limits: [{ key: "codex", windows: [{ kind: "primary", usedPercent, resetsAt: 999 }] }],
        },
      };
    },
    async threadList() { return { data: [thread], nextCursor: null }; },
    async threadMetadata({ threadId }) {
      assert.equal(threadId, thread.id);
      return { thread };
    },
  };
  const rescueManager = {
    activeForProject() { return null; },
    async captureFingerprint() { return fingerprint; },
  };
  const authorityExecutor = {
    async exec() { throw new Error("git ancestry lookup should not be needed for exact SHA"); },
  };

  let clock = 1000;
  const autopilot = createRescueAutopilot({
    publicContext,
    store,
    rescueManager,
    authorityExecutor,
    defaultCwd: repo,
    thresholdPercent: 85,
    intervalMs: 60_000,
    now: () => ++clock,
  });

  const armed = await autopilot.evaluate("test");
  assert.equal(armed.status, "armed");
  assert.equal(armed.threadId, thread.id);
  const candidate = autopilot.candidateFor({ projectRef: project.projectRef, fingerprintHash: fingerprint.fingerprintHash });
  assert.equal(candidate.threadId, thread.id);
  assert.equal(autopilot.candidateFor({ projectRef: project.projectRef, fingerprintHash: "different" }), null, "fingerprint drift must invalidate pre-arm cache");

  const reused = await autopilot.evaluate("test-repeat");
  assert.equal(reused.status, "armed");
  assert.equal(reused.reused, true, "same fresh fingerprint/reset window should reuse the arm event");

  clock += autopilot.candidateMaxAgeMs + 10;
  assert.equal(autopilot.candidateFor({ projectRef: project.projectRef, fingerprintHash: fingerprint.fingerprintHash }), null, "an old arm must expire instead of pinning a potentially stale thread");
  const refreshed = await autopilot.evaluate("refresh-stale");
  assert.equal(refreshed.status, "armed");
  assert.equal(refreshed.reused, false, "expired arm must re-run thread selection");
  assert.equal(autopilot.candidateFor({ projectRef: project.projectRef, fingerprintHash: fingerprint.fingerprintHash }).threadId, thread.id);

  usedPercent = 20;
  const below = await autopilot.evaluate("quota-reset");
  assert.equal(below.status, "below_threshold");
  assert.equal(autopilot.candidateFor({ projectRef: project.projectRef, fingerprintHash: fingerprint.fingerprintHash }), null, "a later disarm event must invalidate an older arm across process restarts");

  usedPercent = 100;
  const rearmed = await autopilot.evaluate("exhausted");
  assert.equal(rearmed.status, "armed");
  assert.equal(autopilot.candidateFor({ projectRef: project.projectRef, fingerprintHash: fingerprint.fingerprintHash }).threadId, thread.id);

  await autopilot.close();
  console.log("rescue-autopilot-v5: ok");
} finally {
  store.close();
}
