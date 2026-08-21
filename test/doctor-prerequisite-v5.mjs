import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "..");
const doctor = path.join(repoRoot, "scripts", "doctor.mjs");
const temp = await mkdtemp(path.join(os.tmpdir(), "rootbound-doctor-prereq-"));
const project = path.join(temp, "project");
await mkdir(project);

let stdout = "";
try {
  await execFileAsync(process.execPath, [doctor, "--json", "--cwd", project], {
    cwd: repoRoot,
    env: {
      ...process.env,
      ROOTBOUND_HOME: path.join(temp, "state"),
      CODEX_BIN: path.join(temp, "definitely-missing-codex"),
      NODE_NO_WARNINGS: "1",
    },
    timeout: 20_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  assert.fail("doctor must fail when CODEX_BIN cannot resolve to an accepted executable");
} catch (error) {
  assert.equal(error?.code, 1);
  stdout = String(error?.stdout ?? "");
}

const result = JSON.parse(stdout);
assert.equal(result.status, "error");
assert.equal(result.project.ok, false);
assert.match(result.project.error, /Project authority was not checked because a prerequisite failed:/);
assert.match(result.project.error, /codex-executable:/);
assert.doesNotMatch(result.project.error, /^project context was not checked$/i);

console.log("doctor-prerequisite-v5: ok");
