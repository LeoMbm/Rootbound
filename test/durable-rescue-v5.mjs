import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDurableRescueManager } from "../src/durable-rescue.mjs";
import { resolveRootboundPaths } from "../src/state-paths.mjs";
import { openStateStore } from "../src/state-store.mjs";

const root = await mkdtemp(path.join(os.tmpdir(), "rootbound-durable-rescue-"));
const paths = resolveRootboundPaths({ env: { ROOTBOUND_HOME: root } });
const store = await openStateStore({ paths });

try {
  const project = {
    projectRef: "project_durable",
    root: path.join(root, "repo"),
    gitRoot: path.join(root, "repo"),
    name: "repo",
    trusted: true,
    createdAt: 1,
    updatedAt: 1,
    lastConnectedAt: 1,
  };
  store.upsertProject(project);
  const binding = {
    bindingRef: "binding_11111111-1111-4111-8111-111111111111",
    projectRef: project.projectRef,
    threadId: "thread_a",
    threadPreview: null,
    createdAt: 1,
    touchedAt: 1,
    checkpointCount: 0,
    lastCheckpointAt: null,
    lastAckSeq: 0,
  };
  store.upsertBinding(binding);

  const fingerprintA = fingerprint("hash-a");
  store.upsertRescueSession({
    rescueRef: "rescue_11111111-1111-4111-8111-111111111111",
    sessionKey: "mcp:old-chat",
    projectRef: project.projectRef,
    threadId: "thread_a",
    bindingRef: binding.bindingRef,
    status: "active",
    match: { confidence: "exact" },
    baselineGit: { head: "abc", branch: "main", origin: "git@example/repo" },
    baselineFingerprint: fingerprintA,
    expectedFingerprint: fingerprintA,
    quota: null,
    rollbackCoverage: "complete",
    rollbackReasons: [],
    startedAt: 10,
    touchedAt: 10,
    handedOffAt: null,
  });

  let currentFingerprint = fingerprintA;
  let freshStarts = 0;
  const base = {
    captureFingerprint: async () => currentFingerprint,
    start: async () => { freshStarts += 1; throw new Error("fresh start should not run during reattach"); },
    publicSession: (session) => ({ rescueRef: session.rescueRef, status: session.status }),
  };
  const durable = createDurableRescueManager({ base, store, now: () => 100 });

  const reattached = await durable.start({
    sessionKey: "mcp:new-chat",
    project,
    thread: { id: "thread_a" },
    bindingRef: binding.bindingRef,
    match: { confidence: "exact" },
    quota: null,
  });
  assert.equal(reattached.rescueRef, "rescue_11111111-1111-4111-8111-111111111111");
  assert.equal(reattached.reattached, true);
  assert.equal(reattached.sessionKey, "mcp:new-chat");
  assert.equal(freshStarts, 0);
  assert.equal(store.getRescueSession(reattached.rescueRef).sessionKey, "mcp:new-chat");

  currentFingerprint = fingerprint("hash-drift");
  await assert.rejects(
    () => durable.start({ sessionKey: "mcp:third-chat", project, thread: { id: "thread_a" }, bindingRef: binding.bindingRef }),
    (error) => error?.code === "DURABLE_RESCUE_DRIFT_DETECTED"
  );

  currentFingerprint = fingerprintA;
  await assert.rejects(
    () => durable.start({ sessionKey: "mcp:third-chat", project, thread: { id: "thread_b" }, bindingRef: binding.bindingRef }),
    (error) => error?.code === "DURABLE_RESCUE_THREAD_CONFLICT"
  );

  console.log("durable-rescue-v5: ok");
} finally {
  store.close();
}

function fingerprint(hash) {
  return {
    root: path.join(root, "repo"),
    head: "abc",
    branch: "main",
    origin: "git@example/repo",
    status: "",
    files: [],
    degraded: false,
    totalChangedPaths: 0,
    fingerprintHash: hash,
    dirty: false,
    changes: [],
  };
}
