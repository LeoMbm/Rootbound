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
const fakeSpawn = () => ({ pid: 99_999_999, once() {}, unref() {} });
const manager = createCommandManager({
  store,
  continuityState: null,
  codexBin: "/usr/bin/codex",
  packageRoot: root,
  env: { CODEXLESS_HOME: paths.root },
  now: () => ++clock,
  spawnFn: fakeSpawn,
});

try {
  const started = manager.start({ command: ["echo", "hello"], cwd: projectRoot, access: "readOnly", timeoutMs: 10_000 });
  assert.match(started.commandId, /^command_[0-9a-f-]{36}$/i);
  assert.equal(started.status, "starting");
  assert.equal(started.workerPid, 99_999_999);

  const reconciled = manager.status(started.commandId);
  assert.equal(reconciled.status, "interrupted");
  assert.match(reconciled.error ?? "", /worker is no longer running/i);

  const output = manager.output(started.commandId);
  assert.equal(output.status, "interrupted");
  assert.equal(output.stdout, "");
  assert.equal(output.stderr, "");

  assert.throws(
    () => manager.start({ command: ["/usr/bin/codex", "--version"], cwd: projectRoot, access: "readOnly", timeoutMs: 10_000 }),
    (error) => error?.code === "CODEX_MODEL_LANE_DISABLED"
  );
} finally {
  store.close();
}
console.log("command-manager-v5: ok");
