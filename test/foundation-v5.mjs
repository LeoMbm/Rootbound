import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openStateStore } from "../src/state-store.mjs";
import { resolveRootboundPaths } from "../src/state-paths.mjs";
import { projectRefForRoot, registerProject } from "../src/project-registry.mjs";
import {
  hasRootboundPermissionConsent,
  recordRootboundPermissionConsent,
  ROOTBOUND_PERMISSION_CONFIG_OVERRIDES,
  ROOTBOUND_PERMISSION_PROFILE,
  withRootboundPermissionOverrides,
} from "../src/rootbound-permission-profile.mjs";
import {
  ensureExactProjectTrust,
  hasExactTrustedProject,
  removeExactProjectTrust,
  rollbackTrustConfig,
} from "../src/trust-config.mjs";

const temp = await mkdtemp(path.join(os.tmpdir(), "rootbound-v5-"));
const paths = resolveRootboundPaths({ env: { ROOTBOUND_HOME: path.join(temp, "home") }, home: temp, platform: process.platform });
const projectDir = path.join(temp, "project");
await mkdir(projectDir);
const canonicalProjectDir = await realpath(projectDir);
const store = await openStateStore({ paths });
try {
  const registered = await registerProject(store, projectDir);
  assert.equal(registered.projectRef, projectRefForRoot(projectDir));
  assert.equal(projectRefForRoot(projectDir), projectRefForRoot(canonicalProjectDir));
  assert.equal(store.listProjects().length, 1);
  assert.equal(registered.root, canonicalProjectDir);

  const codexDir = path.join(temp, ".codex");
  await mkdir(codexDir);
  const configPath = path.join(codexDir, "config.toml");
  await writeFile(configPath, 'model = "x"\n');
  assert.equal(await hasRootboundPermissionConsent({ paths }), false);
  await recordRootboundPermissionConsent({ paths, now: -1 });
  assert.equal(await hasRootboundPermissionConsent({ paths }), true);
  assert.equal(ROOTBOUND_PERMISSION_PROFILE, "rootbound");
  assert.ok(ROOTBOUND_PERMISSION_CONFIG_OVERRIDES.some((value) => value === 'default_permissions=":workspace"'));
  assert.ok(ROOTBOUND_PERMISSION_CONFIG_OVERRIDES.some((value) => value.includes('filesystem={":workspace_roots"={".git"="write"}}')));
  assert.ok(ROOTBOUND_PERMISSION_CONFIG_OVERRIDES.some((value) => value === "permissions.rootbound.network.enabled=true"));
  assert.ok(ROOTBOUND_PERMISSION_CONFIG_OVERRIDES.some((value) => value === "permissions.rootbound.network.allow_local_binding=false"));
  assert.deepEqual(withRootboundPermissionOverrides([], { profileOverride: ROOTBOUND_PERMISSION_PROFILE }), ROOTBOUND_PERMISSION_CONFIG_OVERRIDES);
  assert.deepEqual(withRootboundPermissionOverrides(["features.foo=true"], { profileOverride: null }), ["features.foo=true"]);
  assert.throws(
    () => withRootboundPermissionOverrides(['permissions.rootbound.network.enabled=false'], { profileOverride: ROOTBOUND_PERMISSION_PROFILE }),
    (error) => error?.code === "ROOTBOUND_PERMISSION_OVERRIDE_CONFLICT"
  );
  const trust = await ensureExactProjectTrust(canonicalProjectDir, { configPath, backupsDir: paths.backupsDir, now: 0 });
  assert.equal(trust.changed, true);
  const after = await readFile(configPath, "utf8");
  assert.equal(hasExactTrustedProject(after, canonicalProjectDir), true);
  const second = await ensureExactProjectTrust(canonicalProjectDir, { configPath, backupsDir: paths.backupsDir, now: 1 });
  assert.equal(second.changed, false);
  const removedTrust = await removeExactProjectTrust(canonicalProjectDir, { configPath, backupsDir: paths.backupsDir, now: 2 });
  assert.equal(removedTrust.changed, true);
  assert.equal(hasExactTrustedProject(await readFile(configPath, "utf8"), canonicalProjectDir), false);
  await rollbackTrustConfig(removedTrust);
  assert.equal(hasExactTrustedProject(await readFile(configPath, "utf8"), canonicalProjectDir), true);
  await rollbackTrustConfig(trust);
  assert.equal(await readFile(configPath, "utf8"), 'model = "x"\n');

  assert.equal(store.deleteProject(registered.projectRef), true);
  assert.equal(store.getProject(registered.projectRef), null);
  assert.equal(store.listProjects().length, 0);
  assert.equal(store.deleteProject(registered.projectRef), false);
} finally {
  store.close();
}
console.log("foundation-v5: ok");
