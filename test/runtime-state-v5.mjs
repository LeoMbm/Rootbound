import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readRuntimeState, runtimeStatus, stopRuntime, tailLog, writeRuntimeState } from "../src/runtime-state.mjs";

const root = await mkdtemp(path.join(os.tmpdir(), "codexless-runtime-state-"));
const runtimeDir = path.join(root, "runtime");
await mkdir(runtimeDir);
const paths = { runtimeStatePath: path.join(runtimeDir, "runtime.json") };
assert.equal(await readRuntimeState(paths), null);
await writeRuntimeState(paths, { pid: 99_999_999, startedAt: 1 });
assert.equal((await runtimeStatus(paths)).status, "stale");
assert.equal((await stopRuntime(paths)).reason, "stale_state_cleared");
const logPath = path.join(root, "codexless.log");
await writeFile(logPath, "abcdef");
assert.equal(await tailLog(logPath, { maxBytes: 3 }), "def");
console.log("runtime-state-v5: ok");
