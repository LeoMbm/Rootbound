import assert from "node:assert/strict";
import { registerRepoTools } from "../src/repo-tools.mjs";

const registered = new Map();
const calls = [];
const server = {
  registerTool(name, definition, handler) {
    registered.set(name, { definition, handler });
  },
};
const authorityExecutor = {
  async resolveAuthority({ cwd, access }) {
    calls.push({ kind: "authority", cwd, access });
    return {
      effectiveCwd: cwd ?? "/project",
      permissionProfile: access === "readOnly" ? ":read-only" : ":workspace",
      permissionCeiling: ":workspace",
      authoritySource: "test",
      trustedAncestor: "/project",
    };
  },
  async exec(input) {
    calls.push({ kind: "exec", ...structuredClone(input) });
    if (input.command[0] === process.execPath && input.command[1] === "-e") {
      return {
        exitCode: 0,
        stdout: JSON.stringify({ ok: true, code: 0, stderr: "", page: ["src/a.js:1:1:needle"], hasMore: false, scanned: 1 }),
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
        effectiveCwd: input.cwd ?? "/project",
        permissionProfile: ":read-only",
        permissionCeiling: ":workspace",
        authoritySource: "test",
        trustedAncestor: "/project",
      };
    }
    return {
      exitCode: 0,
      stdout: "ok\n",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      effectiveCwd: input.cwd ?? "/project",
      permissionProfile: input.access === "readOnly" ? ":read-only" : ":workspace",
      permissionCeiling: ":workspace",
      authoritySource: "test",
      trustedAncestor: "/project",
    };
  },
};
const continuityState = {
  assertCwd(bindingRef, cwd) {
    assert.equal(bindingRef, "binding_00000000-0000-0000-0000-000000000000");
    return { targetCwd: cwd ?? "/project" };
  },
  record() {},
};

registerRepoTools(server, { authorityExecutor, continuityState });
assert.deepEqual([...registered.keys()].sort(), [
  "codex.apply_patch",
  "codex.git_diff",
  "codex.git_status",
  "codex.repo_search",
]);

const search = await registered.get("codex.repo_search").handler({ query: "needle", cwd: "/project", maxResults: 20 });
assert.equal(search.isError, false);
assert.equal(search.structuredContent.modelTurnStarted, false);
assert.deepEqual(search.structuredContent.results, ["src/a.js:1:1:needle"]);
assert.equal(search.structuredContent.hasMore, false);
const searchExec = calls.filter((call) => call.kind === "exec").at(-1);
assert.equal(searchExec.access, "readOnly");
assert.equal(searchExec.command[0], process.execPath);
assert.equal(searchExec.command[1], "-e");

const status = await registered.get("codex.git_status").handler({ cwd: "/project" });
assert.equal(status.isError, false);
const statusExec = calls.filter((call) => call.kind === "exec").at(-1);
assert.deepEqual(statusExec.command, ["git", "status", "--short", "--branch"]);
assert.equal(statusExec.access, "readOnly");

const diff = await registered.get("codex.git_diff").handler({ cwd: "/project", staged: true, pathspec: ["src/a.js"] });
assert.equal(diff.isError, false);
const diffExec = calls.filter((call) => call.kind === "exec").at(-1);
assert.deepEqual(diffExec.command, ["git", "diff", "--cached", "--", "src/a.js"]);
assert.equal(diffExec.access, "readOnly");

const patchText = "*** Begin Patch\n*** Update File: src/a.js\n@@\n-old\n+new\n*** End Patch";
const patch = await registered.get("codex.apply_patch").handler({ patch: patchText, cwd: "/project" });
assert.equal(patch.isError, false);
assert.equal(patch.structuredContent.modelTurnStarted, false);
const patchExec = calls.filter((call) => call.kind === "exec").at(-1);
assert.deepEqual(patchExec.command, ["apply_patch", patchText]);
assert.equal(patchExec.access, "inherit");

const badPatch = await registered.get("codex.apply_patch").handler({ patch: "not a patch", cwd: "/project" });
assert.equal(badPatch.isError, true);
assert.equal(badPatch.structuredContent.errorCode, "INVALID_INPUT");
assert.match(badPatch.structuredContent.error, /Begin Patch/);

console.log("model-free repo tools PASS");
