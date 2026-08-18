import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createCommandManager } from "../src/command-manager.mjs";
import { resolveCodexlessPaths } from "../src/state-paths.mjs";
import { openStateStore } from "../src/state-store.mjs";

const root = await mkdtemp(path.join(os.tmpdir(), "codexless-command-manager-"));
const projectRoot = path.join(root, "project");
await mkdir(projectRoot);
const paths = resolveCodexlessPaths({ env: { CODEXLESS_HOME: path.join(root, "home") } });
const store = await openStateStore({ paths });
let clock = 1_000;
let resolveResult;
const resultPromise = new Promise((resolve) => { resolveResult = resolve; });
let writeCall = null;
let terminateCalls = 0;
let closeCalls = 0;

const sessionFactory = async ({ processId, onOutput }) => {
  onOutput({ stream: "stdout", data: Buffer.from("hello ") });
  onOutput({ stream: "stderr", data: Buffer.from("warn\n") });
  return {
    processId,
    result: resultPromise,
    async write(payload) { writeCall = payload; return { processId, writtenBytes: payload.data?.length ?? 0, closeStdin: payload.closeStdin }; },
    async terminate() { terminateCalls += 1; return { processId, terminated: true }; },
    async close() { closeCalls += 1; },
  };
};

const manager = createCommandManager({
  store,
  continuityState: null,
  authorityExecutor: { resolveAuthority() { throw new Error("sessionFactory stub should own authority resolution"); } },
  codexBin: "/usr/bin/codex",
  packageRoot: root,
  env: { CODEXLESS_HOME: paths.root },
  platform: "darwin",
  now: () => ++clock,
  sessionFactory,
});

try {
  const started = await manager.start({ command: ["echo", "hello"], cwd: projectRoot, access: "readOnly", timeoutMs: 10_000 });
  assert.match(started.commandId, /^command_[0-9a-f-]{36}$/i);
  assert.equal(started.status, "running");
  assert.equal(started.mode, "streaming");
  assert.equal(started.interactive, true);

  const first = manager.poll(started.commandId, { cursor: 0, limit: 10 });
  assert.equal(first.status, "running");
  assert.deepEqual(first.chunks.map((chunk) => [chunk.stream, chunk.text]), [["stdout", "hello "], ["stderr", "warn\n"]]);
  assert.ok(first.nextCursor > 0);

  await manager.write(started.commandId, { data: "world\n", closeStdin: true });
  assert.equal(writeCall.data.toString("utf8"), "world\n");
  assert.equal(writeCall.closeStdin, true);

  const termination = await manager.terminate(started.commandId);
  assert.equal(termination.terminated, true);
  assert.equal(terminateCalls, 1);

  resolveResult({ exitCode: 0 });
  await new Promise((resolve) => setImmediate(resolve));
  const finished = manager.poll(started.commandId, { cursor: first.nextCursor, limit: 10 });
  assert.equal(finished.status, "completed");
  assert.equal(finished.exitCode, 0);
  assert.equal(finished.chunks.length, 0);
  assert.equal(closeCalls, 1);

  assert.throws(
    () => manager.start({ command: ["/usr/bin/codex", "--version"], cwd: projectRoot, access: "readOnly", timeoutMs: 10_000 }),
    (error) => error?.code === "CODEX_MODEL_LANE_DISABLED"
  );
} finally {
  await manager.close();
  store.close();
}
console.log("command-manager-v5: ok");
