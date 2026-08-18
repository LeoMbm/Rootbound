import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openStateStore } from "../src/state-store.mjs";
import { resolveCodexlessPaths } from "../src/state-paths.mjs";
import { openWorkspace } from "../src/workspace-tools.mjs";

const temp = await mkdtemp(path.join(os.tmpdir(), "codexless-workspace-open-"));
const project = path.join(temp, "project");
await mkdir(project);
const paths = resolveCodexlessPaths({ env: { CODEXLESS_HOME: path.join(temp, "home") } });
const store = await openStateStore({ paths });

try {
  const needsTrustError = new Error("trust required");
  needsTrustError.code = "PERMISSION_APPROVAL_REQUIRED";
  needsTrustError.nextActions = ["Trust exact root"];
  const blocked = await openWorkspace({
    cwd: project,
    store,
    authorityExecutor: { defaultCwd: project, async resolveAuthority() { throw needsTrustError; } },
    publicContext: { async projectContext() { throw new Error("context must not be read before trust"); } },
  });
  assert.equal(blocked.status, "needs_trust");
  assert.equal(blocked.errorCode, "PERMISSION_APPROVAL_REQUIRED");
  assert.equal(blocked.project.trusted, false);
  assert.deepEqual(blocked.nextActions, ["Trust exact root"]);

  const ready = await openWorkspace({
    cwd: project,
    store,
    authorityExecutor: {
      defaultCwd: project,
      async resolveAuthority() {
        return { permissionProfile: ":read-only", permissionCeiling: ":workspace", authoritySource: "test", trustedAncestor: project };
      },
    },
    publicContext: { async projectContext({ cwd }) { return { cwd, instructions: ["AGENTS.md"] }; } },
  });
  assert.equal(ready.status, "ready");
  assert.equal(ready.project.trusted, true);
  assert.equal(ready.authority.permissionProfile, ":read-only");
  assert.equal(ready.context.cwd, project);
  assert.equal(ready.modelTurnStarted, false);

  const rows = store.listProjects();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].projectRef, ready.project.projectRef);
} finally {
  store.close();
}
console.log("workspace-open-v5: ok");
