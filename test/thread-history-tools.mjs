import assert from "node:assert/strict";
import { createContinuityState } from "../src/continuity-state.mjs";
import { buildContinuityCheckpoint, registerThreadHistoryTools } from "../src/thread-history-tools.mjs";
import { sanitizeHistoryPayload } from "../src/public-context-executor.mjs";

const state = createContinuityState({ now: (() => { let n = 1_000; return () => ++n; })() });
const bound = state.bind({ threadId: "thr_123", cwd: "/project", threadPreview: "Fix matcher" });
assert.match(bound.bindingRef, /^binding_/);
assert.equal(bound.pendingJournalEntries, 0);
assert.equal(state.assertCwd(bound.bindingRef, "src").targetCwd, "/project/src");
assert.throws(() => state.assertCwd(bound.bindingRef, "/other-project"), /scoped to/i);

state.record(bound.bindingRef, { kind: "command", label: "npm test", cwd: "/project", status: "ok", exitCode: 0 });
state.record(bound.bindingRef, { kind: "edit", path: "/project/src/index.js", cwd: "/project", status: "applied", changed: true });
const pending = state.prepareCheckpoint(bound.bindingRef);
assert.equal(pending.journal.length, 2);
assert.equal(pending.threadId, "thr_123");

const checkpoint = buildContinuityCheckpoint({
  summary: "Implemented bound model-free continuity.",
  decisions: ["Raw reasoning stays private."],
  remainingWork: ["Run the full suite on a supported machine."],
  journal: pending.journal,
});
assert.match(checkpoint, /^\[External continuity checkpoint from ChatGPT via Codexless\]/);
assert.match(checkpoint, /not a previous Codex-generated conclusion/i);
assert.match(checkpoint, /npm test/);
assert.match(checkpoint, /src\/index\.js/);
assert.match(checkpoint, /Raw reasoning stays private/);

const acknowledged = state.acknowledgeCheckpoint(bound.bindingRef, pending.throughSeq);
assert.equal(acknowledged.pendingJournalEntries, 0);
assert.equal(acknowledged.checkpointCount, 1);
assert.equal(state.unbind(bound.bindingRef).status, "unbound");
assert.throws(() => state.status(bound.bindingRef), /unknown or expired/i);

const sanitized = sanitizeHistoryPayload({
  thread: { id: "thr_123", cwd: "/project", path: "/secret/codex/rollout.jsonl" },
  data: [
    { id: "reason_1", type: "reasoning", summary: ["Public summary"], content: ["private chain of thought"], rawContent: "private raw reasoning", encryptedContent: "ciphertext" },
    { id: "file_1", type: "fileChange", path: "src/index.js", changes: [{ path: "src/index.js", kind: "update" }] },
  ],
});

assert.equal(Object.hasOwn(sanitized.thread, "path"), false, "rollout storage path must be redacted");
assert.deepEqual(sanitized.data[0], { id: "reason_1", type: "reasoning", summary: ["Public summary"] });
assert.equal(sanitized.data[1].path, "src/index.js", "ordinary project file paths must remain visible");
assert.equal(sanitized.data[1].changes[0].path, "src/index.js");

const registered = new Map();
registerThreadHistoryTools({
  registerTool(name, definition, handler) { registered.set(name, { definition, handler }); },
}, {
  context: {
    async threadMetadata({ threadId }) {
      return { thread: { id: threadId, cwd: "/project", ephemeral: threadId === "ephemeral-thread", preview: "test" } };
    },
  },
  authorityExecutor: {
    async resolveAuthority({ cwd }) {
      return { effectiveCwd: cwd, trustedAncestor: cwd, permissionProfile: ":read-only", permissionCeiling: ":workspace", authoritySource: "test" };
    },
  },
  continuityState: createContinuityState({ now: (() => { let n = 2_000; return () => ++n; })() }),
});

const bindHandler = registered.get("codex.continuity_bind").handler;
const ephemeralBind = await bindHandler({ threadId: "ephemeral-thread" });
assert.equal(ephemeralBind.isError, true);
assert.equal(ephemeralBind.structuredContent?.errorCode, "CONTINUITY_THREAD_EPHEMERAL");
assert.match(ephemeralBind.structuredContent?.error ?? "", /persisted Codex thread/i);

const persistedBind = await bindHandler({ threadId: "persisted-thread" });
assert.equal(persistedBind.isError, false);
assert.equal(persistedBind.structuredContent?.status, "bound");
assert.equal(persistedBind.structuredContent?.threadId, "persisted-thread");

console.log("thread history continuity tests passed");
