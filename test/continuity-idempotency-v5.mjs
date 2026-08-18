import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createContinuityIdempotency } from "../src/continuity-idempotency.mjs";
import { resolveCodexlessPaths } from "../src/state-paths.mjs";
import { openStateStore } from "../src/state-store.mjs";

const root = await mkdtemp(path.join(os.tmpdir(), "codexless-idempotency-"));
const paths = resolveCodexlessPaths({ env: { CODEXLESS_HOME: path.join(root, "state") } });
const store = await openStateStore({ paths });
let clock = 100;
const idem = createContinuityIdempotency({ store, now: () => ++clock });

try {
  const request = { bindingRef: "binding_x", summary: "state", decisions: [], remainingWork: [] };
  const first = idem.begin({ operation: "checkpoint", key: "checkpoint:test-1", request, bindingRef: "binding_x" });
  assert.equal(first.mode, "started");
  assert.ok(first.requestHash);

  assert.throws(
    () => idem.begin({ operation: "checkpoint", key: "checkpoint:test-1", request, bindingRef: "binding_x" }),
    (error) => error?.code === "IDEMPOTENCY_IN_DOUBT"
  );

  assert.equal(idem.cancelPending({ operation: "checkpoint", key: "checkpoint:test-1", requestHash: first.requestHash }), true);
  const restarted = idem.begin({ operation: "checkpoint", key: "checkpoint:test-1", request, bindingRef: "binding_x" });
  assert.equal(restarted.mode, "started");
  const saved = { status: "checkpointed", injectedChars: 42, binding: { bindingRef: "binding_x" } };
  idem.complete({ operation: "checkpoint", key: "checkpoint:test-1", requestHash: restarted.requestHash, bindingRef: "binding_x", result: saved });

  const replay = idem.begin({ operation: "checkpoint", key: "checkpoint:test-1", request, bindingRef: "binding_x" });
  assert.equal(replay.mode, "replay");
  assert.deepEqual(replay.result, saved);

  assert.throws(
    () => idem.begin({ operation: "checkpoint", key: "checkpoint:test-1", request: { ...request, summary: "different" }, bindingRef: "binding_x" }),
    (error) => error?.code === "IDEMPOTENCY_KEY_REUSED"
  );

  assert.throws(
    () => idem.begin({ operation: "bind", key: "bad key", request: { threadId: "t" } }),
    (error) => error?.code === "IDEMPOTENCY_KEY_INVALID"
  );
} finally {
  store.close();
}

console.log("continuity-idempotency-v5: ok");
