import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { addConnection } from "../src/connection-registry.mjs";
import { readLocalMcpGrants } from "../src/local-mcp-access.mjs";
import { resolveRootboundPaths } from "../src/state-paths.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const home = await mkdtemp(path.join(os.tmpdir(), "rootbound-mcp-cli-"));
const env = { ...process.env, ROOTBOUND_HOME: home };
const paths = resolveRootboundPaths({ env });

try {
  const connection = await addConnection({ paths, name: "test-local-mcp", makeActive: true });
  for (const argv of [
    ["allow", "umami"],
    ["deny", "umami"],
    ["allow", "umami", "get_stats"],
    ["deny", "umami", "get_stats"],
  ]) {
    const run = spawnSync(process.execPath, [path.join(root, "bin/rootbound.mjs"), "mcp", ...argv], {
      cwd: root, env, encoding: "utf8", timeout: 10_000,
    });
    assert.equal(run.status, 2, `CLI should demand local confirmation for ${argv.join(" ")}: ${run.stderr}`);
    assert.match(run.stderr, /interactive local terminal/);
    assert.doesNotMatch(run.stderr, /Usage:/);
  }
  assert.deepEqual(await readLocalMcpGrants({ paths, connectionId: connection.connection.id }), {});
} finally {
  await rm(home, { recursive: true, force: true });
}

console.log("local-mcp-cli: ok");
