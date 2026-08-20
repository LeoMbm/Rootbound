import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildStdioCommand,
  discoverTunnelCandidates,
  managedTunnelEnvironment,
  rollbackManagedTunnelSetup,
  validateRuntimeKey,
  validateTunnelId,
  writeManagedTunnelSetup,
} from "../src/tunnel-bootstrap.mjs";
import { resolveRootboundPaths } from "../src/state-paths.mjs";
import { tunnelConfigStatus } from "../src/tunnel-config.mjs";

const root = await mkdtemp(path.join(os.tmpdir(), "rootbound-tunnel-bootstrap-"));
const home = path.join(root, "home");
const profileDir = path.join(home, ".config", "tunnel-client");
await mkdir(profileDir, { recursive: true });

const tunnelA = "tunnel_0123456789abcdef0123456789abcdef";
const tunnelB = "tunnel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
await writeFile(path.join(profileDir, "existing.yaml"), `config_version: 1\ncontrol_plane:\n  tunnel_id: ${tunnelA}\n`, "utf8");

const discovered = await discoverTunnelCandidates({
  env: { CONTROL_PLANE_TUNNEL_ID: tunnelB },
  home,
  profileDirs: [profileDir],
});
assert.deepEqual(discovered.map((entry) => entry.id), [tunnelB, tunnelA]);
assert.equal(discovered[0].source, "environment");
assert.match(discovered[1].source, /^profile:/);

assert.equal(validateTunnelId(tunnelA), true);
assert.equal(validateTunnelId("tunnel_gggggggggggggggggggggggggggggggg"), false);
assert.equal(validateTunnelId("tunnel_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"), false);
assert.equal(validateTunnelId("tunnel_short"), false);
assert.equal(validateRuntimeKey("sk_test-runtime_key-123"), true);
assert.equal(validateRuntimeKey("opaque runtime key with spaces"), true);
assert.equal(validateRuntimeKey("bad\nkey"), false);
assert.equal(validateRuntimeKey(""), false);

const sanitized = managedTunnelEnvironment({ CONTROL_PLANE_TUNNEL_ID: tunnelB, CONTROL_PLANE_API_KEY: "secret", OPENAI_API_KEY: "other", KEEP_ME: "yes" });
assert.equal(sanitized.CONTROL_PLANE_TUNNEL_ID, undefined);
assert.equal(sanitized.CONTROL_PLANE_API_KEY, undefined);
assert.equal(sanitized.OPENAI_API_KEY, undefined);
assert.equal(sanitized.KEEP_ME, "yes");

const paths = resolveRootboundPaths({ env: { ROOTBOUND_HOME: path.join(root, "Rootbound State") }, home });
const secret = "sk_test-runtime_key-123";
const packageRoot = path.join(root, "Rootbound App With Spaces");
const nodePath = path.join(root, "Node Runtime", "node");
const setup = await writeManagedTunnelSetup({
  tunnelId: tunnelA,
  apiKey: secret,
  packageRoot,
  nodePath,
  paths,
  tunnelClientCommand: "tunnel-client",
  platform: process.platform,
});

assert.equal(setup.configured, true);
assert.equal(setup.tunnelId, tunnelA);
assert.equal(setup.healthUrlPath, paths.tunnelHealthUrlPath);
assert.equal(setup.mcpCommand, `'${nodePath}' '${path.join(packageRoot, "scripts", "launch.mjs")}' stdio`);

const secretText = await readFile(paths.tunnelSecretPath, "utf8");
assert.equal(secretText, secret);
if (process.platform !== "win32") {
  const info = await stat(paths.tunnelSecretPath);
  assert.equal(info.mode & 0o077, 0, "runtime key file must not be group/world accessible");
}

const profile = await readFile(paths.tunnelManagedProfilePath, "utf8");
assert.match(profile, new RegExp(tunnelA));
assert.match(profile, /base_url:\s+"https:\/\/api\.openai\.com"/);
assert.match(profile, /api_key:\s+"file:/);
assert.match(profile, /listen_addr:\s+"127\.0\.0\.1:0"/);
assert.match(profile, /url_file:/);
assert.match(profile, /format: json/);
assert.match(profile, /channel: main/);
assert.match(profile, /launch\.mjs/);
assert.equal(profile.includes(secret), false, "managed tunnel profile must not contain the runtime key");

const persistedStatus = tunnelConfigStatus({ paths, env: {} });
assert.equal(persistedStatus.configured, true);
assert.equal(persistedStatus.tunnelId, tunnelA);
assert.deepEqual(persistedStatus.argv, ["tunnel-client", "run", "--profile-file", paths.tunnelManagedProfilePath]);
assert.equal(JSON.stringify(persistedStatus).includes(secret), false);

const commandWithSpaces = buildStdioCommand({ nodePath: "/Applications/Node Runtime/node", packageRoot: "/Users/example/Library/Application Support/Rootbound/app" });
assert.equal(commandWithSpaces, "'/Applications/Node Runtime/node' '/Users/example/Library/Application Support/Rootbound/app/scripts/launch.mjs' stdio");
assert.equal(
  buildStdioCommand({ packageRoot: "/Users/example/Library/Application Support/Rootbound/app" }),
  "node '/Users/example/Library/Application Support/Rootbound/app/scripts/launch.mjs' stdio"
);

await rollbackManagedTunnelSetup({ paths });
assert.equal(tunnelConfigStatus({ paths, env: {} }).configured, false);
await assert.rejects(() => readFile(paths.tunnelSecretPath, "utf8"), (error) => error?.code === "ENOENT");
await assert.rejects(() => readFile(paths.tunnelManagedProfilePath, "utf8"), (error) => error?.code === "ENOENT");

console.log("tunnel-bootstrap-v5: ok");
