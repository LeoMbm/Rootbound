import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { addConnection, loadConnectionRegistry } from "../src/connection-registry.mjs";
import { resolveConnectionPaths } from "../src/connection-paths.mjs";
import { resolveRootboundPaths } from "../src/state-paths.mjs";
import { writeManagedTunnelSetup } from "../src/tunnel-bootstrap.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");
const root = await mkdtemp(path.join(os.tmpdir(), "rootbound-connection-lifecycle-"));
const home = path.join(root, "state");
const bin = path.join(root, "bin");
await mkdir(bin, { recursive: true });
const fakeTunnel = path.join(bin, "tunnel-client");
await writeFile(fakeTunnel, `#!/usr/bin/env node
import { readFileSync } from "node:fs";
const flag = process.argv.indexOf("--profile-file");
const profile = readFileSync(process.argv[flag + 1], "utf8");
const secretPath = profile.match(/api_key:\\s+"file:([^"]+)"/)?.[1];
const key = secretPath ? readFileSync(secretPath, "utf8") : "";
process.exit(key === "new-bad" ? 1 : 0);
`, "utf8");
await chmod(fakeTunnel, 0o755);

const paths = resolveRootboundPaths({ env: { ROOTBOUND_HOME: home } });
const added = await addConnection({ paths, name: "work", tunnelId: "tunnel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", makeActive: true });
const connectionPaths = resolveConnectionPaths({ paths, connection: added.connection });
await writeManagedTunnelSetup({ tunnelId: added.connection.tunnelId, apiKey: "old-good", packageRoot: repoRoot, paths: connectionPaths, tunnelClientCommand: "tunnel-client" });

let result = run(["repair", "work"], "new-bad");
assert.equal(result.status, 1, "bad replacement key must fail repair");
assert.match(result.stderr, /previous runtime key was restored/i);
assert.equal(await readFile(connectionPaths.tunnelSecretPath, "utf8"), "old-good");

result = run(["repair", "work"], "new-good");
assert.equal(result.status, 0, result.stderr);
assert.equal(await readFile(connectionPaths.tunnelSecretPath, "utf8"), "new-good");

result = run(["remove", "work", "--json"]);
assert.equal(result.status, 0, result.stderr);
const removed = JSON.parse(result.stdout);
assert.equal(removed.action, "connection-removed");
const registry = await loadConnectionRegistry({ paths, initializeLegacy: false });
assert.equal(registry.connections.length, 0);
await assert.rejects(() => readFile(connectionPaths.tunnelSecretPath, "utf8"), (error) => error?.code === "ENOENT");
await assert.rejects(() => readFile(connectionPaths.tunnelManagedProfilePath, "utf8"), (error) => error?.code === "ENOENT");
await assert.rejects(() => readFile(connectionPaths.tunnelConfigPath, "utf8"), (error) => error?.code === "ENOENT");

console.log("connection-lifecycle-v5: ok");

function run(args, key = null) {
  return spawnSync(process.execPath, [path.join(repoRoot, "scripts", "connection-cli.mjs"), ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      ROOTBOUND_HOME: home,
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
      ...(key ? { CONTROL_PLANE_API_KEY: key } : {}),
    },
  });
}
