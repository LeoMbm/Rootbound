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
  async exec(input) {
    calls.push(structuredClone(input));
    return {
      exitCode: 0,
      stdout: input.command[0] === "git" ? "ok\n" : "match\n",
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
assert.equal(calls.at(-1).access, "readOnly");
assert.equal(calls.at(-1).command[0], "rg");

const status = await registered.get("codex.git_status").handler({ cwd: "/project" });
assert.equal(status.isError, false);
assert.deepEqual(calls.at(-1).command, ["git", "status", "--short", "--branch"]);
assert.equal(calls.at(-1).access, "readOnly");

const diff = await registered.get("codex.git_diff").handler({ cwd: "/project", staged: true, pathspec: ["src/a.js"] });
assert.equal(diff.isError, false);
assert.deepEqual(calls.at(-1).command, ["git", "diff", "--cached", "--", "src/a.js"]);
assert.equal(calls.at(-1).access, "readOnly");

const patchText = "*** Begin Patch\n*** Update File: src/a.js\n@@\n-old\n+new\n*** End Patch";
const patch = await registered.get("codex.apply_patch").handler({ patch: patchText, cwd: "/project" });
assert.equal(patch.isError, false);
assert.equal(patch.structuredContent.modelTurnStarted, false);
assert.deepEqual(calls.at(-1).command, ["apply_patch", patchText]);
assert.equal(calls.at(-1).access, "inherit");

const badPatch = await registered.get("codex.apply_patch").handler({ patch: "not a patch", cwd: "/project" });
assert.equal(badPatch.isError, true);
assert.match(badPatch.structuredContent.error, /Begin Patch/);

console.log("model-free repo tools PASS");
