import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openStateStore } from "../src/state-store.mjs";
import { resolveCodexlessPaths } from "../src/state-paths.mjs";
import { projectRefForRoot, registerProject } from "../src/project-registry.mjs";
import { ensureExactProjectTrust, hasExactTrustedProject, rollbackTrustConfig } from "../src/trust-config.mjs";

const temp = await mkdtemp(path.join(os.tmpdir(), "codexless-v5-"));
const paths = resolveCodexlessPaths({ env: { CODEXLESS_HOME: path.join(temp, "home") }, home: temp, platform: process.platform });
const projectDir = path.join(temp, "project");
await mkdir(projectDir);
const store = await openStateStore({ paths });
try {
  const registered = await registerProject(store, projectDir);
  assert.equal(registered.projectRef, projectRefForRoot(projectDir));
  assert.equal(store.listProjects().length, 1);
  assert.equal(registered.root, projectDir);

  const codexDir = path.join(temp, ".codex");
  await mkdir(codexDir);
  const configPath = path.join(codexDir, "config.toml");
  await writeFile(configPath, 'model = "x"\n');
  const trust = await ensureExactProjectTrust(projectDir, { configPath, backupsDir: paths.backupsDir, now: 0 });
  assert.equal(trust.changed, true);
  const after = await readFile(configPath, "utf8");
  assert.equal(hasExactTrustedProject(after, projectDir), true);
  const second = await ensureExactProjectTrust(projectDir, { configPath, backupsDir: paths.backupsDir, now: 1 });
  assert.equal(second.changed, false);
  await rollbackTrustConfig(trust);
  assert.equal(await readFile(configPath, "utf8"), 'model = "x"\n');
} finally {
  store.close();
}
console.log("foundation-v5: ok");
