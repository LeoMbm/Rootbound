import assert from "node:assert/strict";
import { buildContinuityHandoff } from "../src/thread-history-tools.mjs";
import { sanitizeHistoryPayload } from "../src/public-context-executor.mjs";

const handoff = buildContinuityHandoff({
  summary: "Implemented model-free history continuity.",
  changedFiles: ["src/thread-history-tools.mjs"],
  tests: ["npm test"],
  decisions: ["Raw reasoning stays private."],
  remainingWork: ["Review upstream compatibility."],
});
assert.match(handoff, /^\[External continuity update from ChatGPT via Codexless\]/);
assert.match(handoff, /not a previous Codex-generated conclusion/i);
assert.match(handoff, /Changed files:\n- src\/thread-history-tools\.mjs/);
assert.match(handoff, /Raw reasoning stays private/);

const sanitized = sanitizeHistoryPayload({
  thread: {
    id: "thr_123",
    cwd: "/project",
    path: "/secret/codex/rollout.jsonl",
  },
  data: [
    {
      id: "reason_1",
      type: "reasoning",
      summary: ["Public summary"],
      content: ["private chain of thought"],
      rawContent: "private raw reasoning",
      encryptedContent: "ciphertext",
    },
    {
      id: "file_1",
      type: "fileChange",
      path: "src/index.js",
      changes: [{ path: "src/index.js", kind: "update" }],
    },
  ],
});

assert.equal(Object.hasOwn(sanitized.thread, "path"), false, "rollout storage path must be redacted");
assert.deepEqual(sanitized.data[0], {
  id: "reason_1",
  type: "reasoning",
  summary: ["Public summary"],
});
assert.equal(sanitized.data[1].path, "src/index.js", "ordinary project file paths must remain visible");
assert.equal(sanitized.data[1].changes[0].path, "src/index.js");

console.log("thread history continuity tests passed");
