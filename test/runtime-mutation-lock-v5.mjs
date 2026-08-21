import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveRootboundPaths } from "../src/state-paths.mjs";
import { withRuntimeMutationLock } from "../src/runtime-mutation-lock.mjs";

const root = await mkdtemp(path.join(os.tmpdir(), "rootbound-runtime-lock-"));
const paths = resolveRootboundPaths({ env: { ROOTBOUND_HOME: path.join(root, "state") } });

let release;
const held = withRuntimeMutationLock(paths, async () => {
  await new Promise((resolve) => { release = resolve; });
});
while (!release) await new Promise((resolve) => setTimeout(resolve, 1));

await assert.rejects(
  () => withRuntimeMutationLock(paths, async () => {}),
  (error) => error?.code === "RUNTIME_MUTATION_BUSY"
);
release();
await held;

await writeFile(paths.runtimeMutationLockPath, `${JSON.stringify({ pid: 999999999, createdAt: 1 })}\n`, { mode: 0o600 });
let ran = false;
await withRuntimeMutationLock(paths, async () => { ran = true; });
assert.equal(ran, true, "a stale lock owned by a dead pid must be recoverable");

console.log("runtime-mutation-lock-v5: ok");
