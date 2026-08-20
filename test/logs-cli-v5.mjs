import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { resolveRootboundPaths } from "../src/state-paths.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");
const root = await mkdtemp(path.join(os.tmpdir(), "rootbound-logs-cli-"));
const paths = resolveRootboundPaths({ env: { ROOTBOUND_HOME: root } });
await mkdir(path.dirname(paths.logPath), { recursive: true });
await writeFile(paths.logPath, "historical-line\n", "utf8");

let result = run([]);
assert.equal(result.status, 0, result.stderr);
assert.match(result.stdout, /historical-line/);

result = run(["--new-only"]);
assert.equal(result.status, 2);
assert.match(result.stderr, /--new-only requires --follow/);

const source = await import("node:fs/promises").then(({ readFile }) => readFile(path.join(repoRoot, "scripts", "logs-cli.mjs"), "utf8"));
assert.match(source, /previous log tail/);
assert.match(source, /following new entries from now/);

console.log("logs-cli-v5: ok");

function run(args) {
  return spawnSync(process.execPath, [path.join(repoRoot, "scripts", "logs-cli.mjs"), ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, ROOTBOUND_HOME: root },
  });
}
