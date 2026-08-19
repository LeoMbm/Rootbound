import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createPersistentContinuityState } from "../src/persistent-continuity-state.mjs";
import { projectQuotaSnapshot } from "../src/public-context-executor.mjs";
import { createRescueSessionManager } from "../src/rescue-continuity.mjs";
import { pathsFromApplyPatch } from "../src/repo-tools.mjs";
import { registerProject, projectRefForRoot } from "../src/project-registry.mjs";
import { registerRescueTools, selectContinuationThread } from "../src/rescue-tools.mjs";
import { resolveRootboundPaths } from "../src/state-paths.mjs";
import { openStateStore } from "../src/state-store.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");
const tempRoot = await mkdtemp(path.join(repoRoot, "node_modules", ".rootbound-rescue-test-"));
const projectRoot = path.join(tempRoot, "project");
const stateRoot = path.join(tempRoot, "state");
await mkdir(projectRoot, { recursive: true });
await writeFile(path.join(projectRoot, "target.txt"), "alpha\n", "utf8");
await writeFile(path.join(projectRoot, "existing.txt"), "clean\n", "utf8");
git(["init", "-q"], projectRoot);
git(["config", "user.email", "rootbound@example.test"], projectRoot);
git(["config", "user.name", "Rootbound Test"], projectRoot);
git(["add", "target.txt", "existing.txt"], projectRoot);
git(["commit", "-qm", "initial"], projectRoot);
const branch = git(["branch", "--show-current"], projectRoot).trim();
const head = git(["rev-parse", "HEAD"], projectRoot).trim();
await writeFile(path.join(projectRoot, "existing.txt"), "preexisting dirty\n", "utf8");

const authorityExecutor = {
  defaultCwd: projectRoot,
  async resolveAuthority({ cwd = projectRoot, access = "readOnly" } = {}) {
    return { effectiveCwd: path.resolve(cwd), trustedAncestor: projectRoot, permissionProfile: access === "inherit" ? ":workspace" : ":read-only", permissionCeiling: ":workspace", authoritySource: "test" };
  },
  async exec({ command, cwd = projectRoot, access = "readOnly" }) {
    const result = spawnSync(command[0], command.slice(1), { cwd, encoding: "utf8", windowsHide: true, shell: false, maxBuffer: 16 * 1024 * 1024 });
    return {
      exitCode: result.status ?? (result.error ? 1 : 0),
      stdout: String(result.stdout ?? ""),
      stderr: String(result.stderr ?? result.error?.message ?? ""),
      stdoutTruncated: false,
      stderrTruncated: false,
      effectiveCwd: path.resolve(cwd),
      permissionProfile: access === "inherit" ? ":workspace" : ":read-only",
      permissionCeiling: ":workspace",
      authoritySource: "test",
      trustedAncestor: projectRoot,
    };
  },
};

const store = await openStateStore({ paths: resolveRootboundPaths({ env: { ROOTBOUND_HOME: stateRoot } }) });
const projectRef = projectRefForRoot(projectRoot);
store.upsertProject({ projectRef, root: projectRoot, gitRoot: projectRoot, name: "project", trusted: true, createdAt: 1, updatedAt: 1, lastConnectedAt: 1 });
const continuity = createPersistentContinuityState({ store });
const manager = createRescueSessionManager({ store, authorityExecutor, continuityState: continuity });

try {
  const binding = continuity.bindOrReuse({ threadId: "thread_exact", cwd: projectRoot, threadPreview: "Fix target" });
  const rescue = await manager.start({
    sessionKey: "mcp:test",
    project: store.getProject(projectRef),
    thread: { id: "thread_exact", preview: "Fix target" },
    bindingRef: binding.bindingRef,
    match: { confidence: "exact" },
    quota: null,
  });
  assert.equal(rescue.rollbackCoverage, "complete");
  assert.equal(rescue.baselineFingerprint.dirty, true, "pre-existing dirty work must be part of the rescue baseline");

  const snapshots = await manager.captureSnapshots(rescue, [path.join(projectRoot, "target.txt")]);
  assert.equal(snapshots.rollbackSafe, true);
  await writeFile(path.join(projectRoot, "target.txt"), "beta\n", "utf8");
  const afterMutation = await manager.recordSnapshotsAfter(rescue, { operation: "test_edit", before: snapshots });
  assert.equal(afterMutation.rollbackCoverage, "complete");
  assert.equal(store.listRescueMutations(rescue.rescueRef).length, 1);

  const rollback = await manager.rollback(afterMutation);
  assert.equal(rollback.status, "rolled_back");
  assert.equal(await readFile(path.join(projectRoot, "target.txt"), "utf8"), "alpha\n");
  assert.equal(await readFile(path.join(projectRoot, "existing.txt"), "utf8"), "preexisting dirty\n", "rollback must preserve dirty work that predates the rescue");

  const binding2 = continuity.bindOrReuse({ threadId: "thread_exact", cwd: projectRoot, threadPreview: "Fix target" });
  const rescue2 = await manager.start({ sessionKey: "mcp:test", project: store.getProject(projectRef), thread: { id: "thread_exact", preview: "Fix target" }, bindingRef: binding2.bindingRef, match: { confidence: "exact" } });
  await writeFile(path.join(projectRoot, "target.txt"), "external drift\n", "utf8");
  await assert.rejects(() => manager.assertNoDrift(rescue2), (error) => error?.code === "CONTINUITY_DRIFT_DETECTED");
  await writeFile(path.join(projectRoot, "target.txt"), "alpha\n", "utf8");

  const currentFingerprint = await manager.captureFingerprint(projectRoot);
  const exactThread = { id: "thread_exact", preview: "Exact", cwd: projectRoot, recencyAt: 200, gitInfo: { sha: head, branch, originUrl: null } };
  const subdir = path.join(projectRoot, "src");
  await mkdir(subdir, { recursive: true });
  const compatibleThread = { id: "thread_subdir", preview: "Subdir", cwd: subdir, recencyAt: 100, gitInfo: { sha: head, branch, originUrl: null } };
  const context = {
    async threadList({ omitCwd }) { return { data: omitCwd ? [compatibleThread, exactThread] : [exactThread] }; },
    async threadMetadata({ threadId }) { return { thread: threadId === exactThread.id ? exactThread : compatibleThread }; },
    async threadRead({ threadId }) { return { thread: threadId === exactThread.id ? exactThread : compatibleThread, turns: { data: [{ id: "turn_1", items: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Please fix target" }] }] }], nextCursor: null } }; },
    async quotaSnapshot() { return { status: "ok", observedAt: "2026-08-19T00:00:00.000Z", codex: { availability: "available", exhausted: false, resetsAt: null, limits: [] } }; },
    async threadSearchOccurrences({ threadId, query }) { return { items: [{ turnId: "turn_1", itemId: "item_1", snippet: `match:${query}`, turnCursor: "cursor_1" }], nextCursor: null }; },
    async injectContinuity({ threadId, text }) { injected.push({ threadId, text }); return { status: "injected", threadId, modelTurnStarted: false }; },
  };
  const selected = await selectContinuationThread({ context, authorityExecutor, project: store.getProject(projectRef), fingerprint: currentFingerprint });
  assert.equal(selected.status, "ready");
  assert.equal(selected.thread.id, "thread_exact");
  assert.equal(selected.match.confidence, "exact");

  const quota = projectQuotaSnapshot({
    status: "ok",
    observedAt: "2026-08-19T00:00:00.000Z",
    rateLimits: {
      status: "ok",
      method: "account/rateLimits/read",
      value: { limits: [{ key: "codex", rateLimitReachedType: "primary", windows: [{ kind: "primary", usedPercent: 100, resetsAt: 123456, windowDurationMins: 300 }] }] },
    },
  });
  assert.equal(quota.codex.availability, "exhausted");
  assert.equal(quota.codex.resetsAt, 123456);

  const multiBucketQuota = projectQuotaSnapshot({
    status: "ok",
    observedAt: "2026-08-19T00:00:00.000Z",
    rateLimits: {
      status: "ok",
      method: "account/rateLimits/read",
      value: { limits: [
        { key: "codex", limitId: "codex", rateLimitReachedType: null, spendControlReached: false, windows: [{ kind: "primary", usedPercent: 42, resetsAt: 222222, windowDurationMins: 300 }] },
        { key: "codex_other", limitId: "codex_other", rateLimitReachedType: "rateLimitReached", spendControlReached: false, windows: [{ kind: "primary", usedPercent: 100, resetsAt: 111111, windowDurationMins: 30 }] },
      ] },
    },
  });
  assert.equal(multiBucketQuota.codex.availability, "available", "exact codex bucket must outrank unrelated codex-like buckets");
  assert.equal(multiBucketQuota.codex.limits.length, 1);
  assert.equal(multiBucketQuota.codex.limits[0].key, "codex");

  assert.deepEqual(pathsFromApplyPatch(`*** Begin Patch\n*** Update File: src/a.mjs\n*** Move to: src/b.mjs\n*** Add File: test/c.mjs\n*** Delete File: old.txt\n*** End Patch`), ["src/a.mjs", "src/b.mjs", "test/c.mjs", "old.txt"]);

  const injected = [];
  const tools = new Map();
  const server = { registerTool(name, config, handler) { tools.set(name, { config, handler }); } };
  registerRescueTools(server, {
    context,
    authorityExecutor,
    continuityState: continuity,
    stateStore: store,
    rescueManager: manager,
    getSessionKey: () => "mcp:handler-test",
  });
  assert.deepEqual([...tools.keys()].sort(), ["codex.continuity_handoff", "codex.continuity_resume", "codex.continuity_rollback", "codex.continuity_search", "codex.quota_status"].sort());

  const resumed = await tools.get("codex.continuity_resume").handler({ cwd: projectRoot }, { sessionId: "handler-test" });
  assert.equal(resumed.isError, false);
  assert.equal(resumed.structuredContent.status, "ready");
  assert.equal(resumed.structuredContent.match.confidence, "exact");
  assert.equal(resumed.structuredContent.modelTurnStarted, false);
  assert.equal(resumed.structuredContent.rescue.bindingRef, undefined, "product resume must hide continuity binding plumbing");
  assert.equal(resumed.structuredContent.bindingRefFallback, undefined, "stable MCP session must not expose a binding fallback");
  const handlerRescue = manager.activeForRequest({ sessionKey: "mcp:handler-test", cwd: projectRoot });
  assert.ok(handlerRescue);

  const searched = await tools.get("codex.continuity_search").handler({ query: "target", cwd: projectRoot, limit: 5 }, { sessionId: "handler-test" });
  assert.equal(searched.isError, false);
  assert.equal(searched.structuredContent.source, "thread/searchOccurrences");
  assert.equal(searched.structuredContent.modelTurnStarted, false);

  const occurrenceSearch = context.threadSearchOccurrences;
  context.threadSearchOccurrences = async () => { throw new Error("thread/searchOccurrences unsupported"); };
  context.threadItems = async () => { throw new Error("thread/items/list unsupported"); };
  const searchedViaTurns = await tools.get("codex.continuity_search").handler({ query: "Please fix", cwd: projectRoot, limit: 5 }, { sessionId: "handler-test" });
  assert.equal(searchedViaTurns.isError, false);
  assert.equal(searchedViaTurns.structuredContent.source, "thread/turns/list-fallback");
  assert.equal(searchedViaTurns.structuredContent.matches.length, 1);
  assert.equal(searchedViaTurns.structuredContent.modelTurnStarted, false);
  context.threadSearchOccurrences = occurrenceSearch;
  delete context.threadItems;

  continuity.record(handlerRescue.bindingRef, { kind: "edit", path: "target.txt", status: "applied" });
  const handoff = await tools.get("codex.continuity_handoff").handler({
    summary: "Fixed target safely.",
    decisions: ["Keep the existing design."],
    remainingWork: ["Run staging validation."],
    idempotencyKey: "handoff-handler-test-0001",
  }, { sessionId: "handler-test" });
  assert.equal(handoff.isError, false);
  assert.equal(handoff.structuredContent.status, "handoff_ready");
  assert.equal(handoff.structuredContent.modelTurnStarted, false);
  assert.equal(injected.length, 1);
  assert.equal(injected[0].threadId, "thread_exact");
  assert.match(injected[0].text, /Fixed target safely/);
  assert.equal(store.getRescueSession(handlerRescue.rescueRef).status, "handed_off");

  const remoteTools = new Map();
  const remoteServer = { registerTool(name, config, handler) { remoteTools.set(name, { config, handler }); } };
  registerRescueTools(remoteServer, {
    context,
    authorityExecutor,
    continuityState: continuity,
    stateStore: store,
    rescueManager: manager,
    getSessionKey: () => null,
  });
  const remoteResume = await remoteTools.get("codex.continuity_resume").handler({ cwd: projectRoot }, {});
  assert.equal(remoteResume.isError, false);
  assert.equal(remoteResume.structuredContent.status, "ready");
  assert.equal(remoteResume.structuredContent.rescue.implicitSessionAvailable, false);
  assert.match(remoteResume.structuredContent.rescue.rescueRef, /^rescue_/);
  assert.equal(remoteResume.structuredContent.rescue.bindingRef, undefined);
  assert.equal(remoteResume.structuredContent.bindingRefFallback, undefined);
  const remoteSearch = await remoteTools.get("codex.continuity_search").handler({
    query: "target",
    rescueRef: remoteResume.structuredContent.rescue.rescueRef,
    limit: 5,
  }, {});
  assert.equal(remoteSearch.isError, false);
  assert.equal(remoteSearch.structuredContent.source, "thread/searchOccurrences");

  const replacedRef = remoteResume.structuredContent.rescue.rescueRef;
  const newerRemoteResume = await remoteTools.get("codex.continuity_resume").handler({ cwd: projectRoot }, {});
  assert.equal(newerRemoteResume.isError, false);
  assert.notEqual(newerRemoteResume.structuredContent.rescue.rescueRef, replacedRef);
  assert.equal(store.getRescueSession(replacedRef).status, "replaced", "a newer rescue on the same binding must invalidate the older rescue");
  const staleResolved = (() => {
    try { manager.resolveBinding({ rescueRef: replacedRef, cwd: projectRoot }); return null; }
    catch (error) { return error; }
  })();
  assert.equal(staleResolved?.code, "RESCUE_SESSION_NOT_FOUND", "stale rescue refs must fail closed instead of dropping scope");

  const cascadeRescueRef = newerRemoteResume.structuredContent.rescue.rescueRef;
  const cascadeRescue = store.getRescueSession(cascadeRescueRef);
  assert.ok(cascadeRescue?.bindingRef);
  assert.equal(store.deleteBinding(cascadeRescue.bindingRef), true);
  assert.equal(store.getRescueSession(cascadeRescueRef), null, "removing a continuity binding must cascade-delete dependent rescue state");
} finally {
  store.close();
  await rm(tempRoot, { recursive: true, force: true });
}

console.log("rescue-continuity-v5: ok");

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
}
