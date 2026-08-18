import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { clearTunnelConfig, resolveTunnelLaunch, saveTunnelConfig, tunnelConfigStatus } from "../src/tunnel-config.mjs";
import { resolveCodexlessPaths } from "../src/state-paths.mjs";

const root = await mkdtemp(path.join(os.tmpdir(), "codexless-tunnel-config-"));
const paths = resolveCodexlessPaths({ env: { CODEXLESS_HOME: path.join(root, "state") } });
const template = ["tunnel-client", "--token", "{env:TUNNEL_TOKEN}", "--node", "{node}", "--project", "{projectRoot}"];

const saved = await saveTunnelConfig({ argv: template, paths });
assert.equal(saved.configured, true);
assert.deepEqual(saved.envPlaceholders, ["TUNNEL_TOKEN"]);
assert.equal(JSON.stringify(saved).includes("real-secret"), false);

const status = tunnelConfigStatus({ paths, env: {} });
assert.equal(status.configured, true);
assert.equal(status.source, "persistent");
assert.deepEqual(status.argv, template);

const launch = resolveTunnelLaunch({
  env: { TUNNEL_TOKEN: "real-secret" },
  packageRoot: "/codexless/app",
  projectRoot: "/project",
  paths,
});
assert.equal(launch.source, "persistent");
assert.equal(launch.command, "tunnel-client");
assert.deepEqual(launch.args.slice(0, 2), ["--token", "real-secret"]);
assert.equal(launch.argv.includes("real-secret"), true);

assert.throws(
  () => resolveTunnelLaunch({ env: {}, packageRoot: "/codexless/app", projectRoot: "/project", paths }),
  (error) => error?.code === "TUNNEL_ENV_MISSING"
);
await assert.rejects(
  () => saveTunnelConfig({ argv: ["tunnel-client", "--token", "literal-secret"], paths }),
  (error) => error?.code === "TUNNEL_SECRET_PERSISTENCE_BLOCKED" && JSON.stringify(error?.details ?? {}).includes("literal-secret") === false
);
await assert.rejects(
  () => saveTunnelConfig({ argv: ["tunnel-client", "https://example.test/?token=literal-secret"], paths }),
  (error) => error?.code === "TUNNEL_SECRET_PERSISTENCE_BLOCKED"
);

const envOverride = resolveTunnelLaunch({
  env: { CODEXLESS_TUNNEL_ARGV_JSON: JSON.stringify(["temporary-client", "--stdio"]) },
  packageRoot: "/codexless/app",
  projectRoot: "/project",
  paths,
});
assert.equal(envOverride.source, "environment");
assert.equal(envOverride.command, "temporary-client");

const cleared = await clearTunnelConfig({ paths });
assert.equal(cleared.configured, false);
assert.equal(cleared.cleared, true);
assert.equal(tunnelConfigStatus({ paths, env: {} }).configured, false);

console.log("tunnel-config-v5: ok");
