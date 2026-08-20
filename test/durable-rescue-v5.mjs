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
  const project = makeProject("project_durable", "repo");
  store.upsertProject(project);
  const binding = makeBinding("binding_11111111-1111-4111-8111-111111111111", project.projectRef, "thread_a");
  store.upsertBinding(binding);

  const fingerprintA = fingerprint(project.root, "hash-a");
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

  const remoteReattached = await durable.start({
    sessionKey: null,
    project,
    thread: { id: "thread_a" },
    bindingRef: binding.bindingRef,
    match: { confidence: "exact" },
    quota: null,
  });
  assert.equal(remoteReattached.rescueRef, reattached.rescueRef);
  assert.equal(remoteReattached.sessionKey, null, "remote reattach must revoke a previous implicit ChatGPT session scope");
  assert.equal(store.getRescueSession(reattached.rescueRef).sessionKey, null);

  currentFingerprint = fingerprint(project.root, "hash-drift");
  await assert.rejects(
    () => durable.start({ sessionKey: "mcp:third-chat", project, thread: { id: "thread_a" }, bindingRef: binding.bindingRef }),
    (error) => error?.code === "DURABLE_RESCUE_DRIFT_DETECTED"
  );

  currentFingerprint = fingerprintA;
  await assert.rejects(
    () => durable.start({ sessionKey: "mcp:third-chat", project, thread: { id: "thread_b" }, bindingRef: binding.bindingRef }),
    (error) => error?.code === "DURABLE_RESCUE_THREAD_CONFLICT"
  );

  const project2 = makeProject("project_concurrent", "repo-concurrent");
  store.upsertProject(project2);
  const binding2 = makeBinding("binding_22222222-2222-4222-8222-222222222222", project2.projectRef, "thread_concurrent");
  store.upsertBinding(binding2);
  const fingerprint2 = fingerprint(project2.root, "hash-concurrent");
  let concurrentFreshStarts = 0;
  const base2 = {
    captureFingerprint: async () => fingerprint2,
    async start(input) {
      concurrentFreshStarts += 1;
      await new Promise((resolve) => setTimeout(resolve, 25));
      return store.upsertRescueSession({
        rescueRef: "rescue_22222222-2222-4222-8222-222222222222",
        sessionKey: input.sessionKey,
        projectRef: input.project.projectRef,
        threadId: input.thread.id,
        bindingRef: input.bindingRef,
        status: "active",
        match: input.match ?? {},
        baselineGit: { head: "abc", branch: "main", origin: "git@example/repo" },
        baselineFingerprint: fingerprint2,
        expectedFingerprint: fingerprint2,
        quota: null,
        rollbackCoverage: "complete",
        rollbackReasons: [],
        startedAt: 200,
        touchedAt: 200,
        handedOffAt: null,
      });
    },
    publicSession: (session) => ({ rescueRef: session.rescueRef, status: session.status }),
  };
  let concurrentNow = 200;
  const durable2 = createDurableRescueManager({ base: base2, store, now: () => ++concurrentNow });
  const input = { project: project2, thread: { id: "thread_concurrent" }, bindingRef: binding2.bindingRef, match: { confidence: "exact" } };
  const [first, second] = await Promise.all([
    durable2.start({ ...input, sessionKey: "mcp:chat-a" }),
    durable2.start({ ...input, sessionKey: "mcp:chat-b" }),
  ]);
  assert.equal(concurrentFreshStarts, 1, "concurrent resumes must create at most one fresh rescue");
  assert.equal(first.rescueRef, second.rescueRef);
  assert.equal(second.reattached, true, "second concurrent resume must reattach after the first creates the durable rescue");
  assert.equal(store.getRescueSession(first.rescueRef).sessionKey, "mcp:chat-b");

  console.log("durable-rescue-v5: ok");
} finally {
  store.close();
}

function makeProject(projectRef, directory) {
  const projectRoot = path.join(root, directory);
  return { projectRef, root: projectRoot, gitRoot: projectRoot, name: directory, trusted: true, createdAt: 1, updatedAt: 1, lastConnectedAt: 1 };
}

function makeBinding(bindingRef, projectRef, threadId) {
  return { bindingRef, projectRef, threadId, threadPreview: null, createdAt: 1, touchedAt: 1, checkpointCount: 0, lastCheckpointAt: null, lastAckSeq: 0 };
}

function fingerprint(projectRoot, hash) {
  return {
    root: projectRoot,
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
