import assert from "node:assert/strict";
import { resolveGitExecutableUncached } from "../src/git-executable.mjs";

{
  const resolved = await resolveGitExecutableUncached({
    platform: "linux",
    env: {},
  });
  assert.equal(resolved, "git");
}

{
  const executable = new Set(["/opt/homebrew/bin/git", "/selected/usr/bin/git"]);
  const resolved = await resolveGitExecutableUncached({
    platform: "darwin",
    env: { PATH: "/usr/bin:/opt/homebrew/bin" },
    accessFn: async (value) => {
      if (!executable.has(value)) throw new Error("missing");
    },
    realpathFn: async (value) => value,
    execFileFn: async () => ({ stdout: "/selected\n" }),
  });
  assert.equal(resolved, "/opt/homebrew/bin/git", "a non-system PATH Git should win before Apple toolchains");
}

{
  const executable = new Set(["/selected/usr/bin/git"]);
  const resolved = await resolveGitExecutableUncached({
    platform: "darwin",
    env: { PATH: "/usr/bin" },
    accessFn: async (value) => {
      if (!executable.has(value)) throw new Error("missing");
    },
    realpathFn: async (value) => value,
    execFileFn: async () => ({ stdout: "/selected\n" }),
  });
  assert.equal(resolved, "/selected/usr/bin/git");
}

{
  await assert.rejects(
    resolveGitExecutableUncached({
      platform: "darwin",
      env: { ROOTBOUND_GIT_BIN: "/missing/git", PATH: "" },
      accessFn: async () => { throw new Error("missing"); },
      realpathFn: async (value) => value,
      execFileFn: async () => ({ stdout: "" }),
    }),
    /ROOTBOUND_GIT_BIN is not executable/
  );
}

console.log("git-executable-v5: ok");
