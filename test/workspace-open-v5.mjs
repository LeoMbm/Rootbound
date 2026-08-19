import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openStateStore } from "../src/state-store.mjs";
import { resolveRootboundPaths } from "../src/state-paths.mjs";
import { openWorkspace } from "../src/workspace-tools.mjs";

const temp = await mkdtemp(path.join(os.tmpdir(), "rootbound-workspace-open-"));
const project = path.join(temp, "project");
await mkdir(project);
const canonicalTemp = await realpath(temp);
const canonicalProject = await realpath(project);
const paths = resolveRootboundPaths({ env: { ROOTBOUND_HOME: path.join(temp, "home") } });
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

  const ancestorOnly = await openWorkspace({
    cwd: project,
    store,
    authorityExecutor: {
      defaultCwd: project,
      async resolveAuthority() {
        return { permissionProfile: ":read-only", permissionCeiling: ":workspace", authoritySource: "test", trustedAncestor: canonicalTemp };
      },
    },
    publicContext: { async projectContext() { throw new Error("context must not be read for ancestor-only trust"); } },
  });
  assert.equal(ancestorOnly.status, "needs_trust");
  assert.equal(ancestorOnly.errorCode, "EXACT_ROOT_TRUST_REQUIRED");
  assert.equal(ancestorOnly.project.trusted, false);
  assert.equal(ancestorOnly.authority.exactRoot, false);
  assert.equal(ancestorOnly.authority.trustedAncestor, canonicalTemp);

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
  assert.equal(ready.project.root, canonicalProject);
  assert.equal(ready.authority.permissionProfile, ":read-only");
  assert.equal(ready.authority.exactRoot, true);
  assert.equal(ready.context.cwd, canonicalProject);
  assert.equal(ready.modelTurnStarted, false);

  const rows = store.listProjects();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].projectRef, ready.project.projectRef);
} finally {
  store.close();
}
console.log("workspace-open-v5: ok");
