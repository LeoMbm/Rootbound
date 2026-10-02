import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { readManyAuthorized } from "../src/construction-tools.mjs";

const execFileAsync = promisify(execFile);
const root = await mkdtemp(path.join(os.tmpdir(), "rootbound-read-many-batch-"));
await writeFile(path.join(root, "a.txt"), "alpha", "utf8");
await writeFile(path.join(root, "b.txt"), "bravo", "utf8");
await writeFile(path.join(root, "c.txt"), "charlie", "utf8");

let commandExecs = 0;
const executor = {
  async withAuthority({ cwd, access }, operation) {
    assert.equal(access, "readOnly");
    return operation({
      nativeLease: true,
      effectiveCwd: cwd,
      trustedAncestor: cwd,
      permissionProfile: ":read-only",
      permissionCeiling: "rootbound",
      async exec({ command, access: commandAccess, timeoutMs }) {
        assert.equal(commandAccess, "readOnly");
        commandExecs += 1;
        try {
          const { stdout, stderr } = await execFileAsync(command[0], command.slice(1), {
            cwd,
            encoding: "utf8",
            maxBuffer: 1024 * 1024,
            timeout: timeoutMs,
          });
          return { exitCode: 0, stdout, stderr, stdoutTruncated: false, stderrTruncated: false };
        } catch (error) {
          return {
            exitCode: Number.isInteger(error?.code) ? error.code : 1,
            stdout: String(error?.stdout ?? ""),
            stderr: String(error?.stderr ?? error?.message ?? ""),
            stdoutTruncated: false,
            stderrTruncated: false,
          };
        }
      },
    });
  },
};

const result = await readManyAuthorized({
  authorityExecutor: executor,
  cwd: root,
  paths: ["a.txt", "b.txt", "c.txt"],
  maxCharsPerFile: 10_000,
  maxTotalChars: 30_000,
});
assert.equal(commandExecs, 1, "small multi-file reads should share one sandbox command");
assert.deepEqual(result.files.map((file) => file.text), ["alpha", "bravo", "charlie"]);
assert.equal(result.hasMore, false);

const fallbackExecutor = {
  async withAuthority({ cwd }, operation) {
    return operation({
      nativeLease: true,
      effectiveCwd: cwd,
      trustedAncestor: cwd,
      permissionProfile: ":read-only",
      permissionCeiling: "rootbound",
      async exec({ command }) {
        if (command.some((arg) => typeof arg === "string" && arg.includes("paths.map"))) {
          return { exitCode: 1, stdout: "", stderr: "synthetic batch failure", stdoutTruncated: false };
        }
        const target = command[3];
        return { exitCode: 0, stdout: await readFile(target, "utf8"), stderr: "", stdoutTruncated: false };
      },
    });
  },
};
const fallback = await readManyAuthorized({
  authorityExecutor: fallbackExecutor,
  cwd: root,
  paths: ["a.txt", "b.txt"],
  maxCharsPerFile: 10_000,
  maxTotalChars: 20_000,
});
assert.deepEqual(fallback.files.map((file) => file.text), ["alpha", "bravo"]);

console.log("read-many-batch-v5: ok");
