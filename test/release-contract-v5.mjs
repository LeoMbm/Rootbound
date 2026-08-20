import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { PUBLIC_SURFACE_VERSION, PUBLIC_TOOL_NAMES } from "../src/surface-contracts.mjs";

const root = path.resolve(import.meta.dirname, "..");
const workflowPath = path.join(root, ".github", "workflows", "v5-foundation.yml");
const workflow = await readFile(workflowPath, "utf8");
const readme = await readFile(path.join(root, "README.md"), "utf8");
const readmeZh = await readFile(path.join(root, "README.zh-CN.md"), "utf8");
const security = await readFile(path.join(root, "SECURITY.md"), "utf8");
const installSh = await readFile(path.join(root, "scripts", "install.sh"), "utf8");
const installPs1 = await readFile(path.join(root, "scripts", "install.ps1"), "utf8");
const uninstallSh = await readFile(path.join(root, "scripts", "uninstall.sh"), "utf8");
const uninstallPs1 = await readFile(path.join(root, "scripts", "uninstall.ps1"), "utf8");
const rootboundEntry = await readFile(path.join(root, "bin", "rootbound-entry.mjs"), "utf8");
const upgradeScript = await readFile(path.join(root, "scripts", "upgrade.mjs"), "utf8");
const tunnelBootstrap = await readFile(path.join(root, "src", "tunnel-bootstrap.mjs"), "utf8");
const tunnelCli = await readFile(path.join(root, "scripts", "tunnel-config-cli.mjs"), "utf8");
const connectionCli = await readFile(path.join(root, "scripts", "connection-cli.mjs"), "utf8");
const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const methodRegistry = JSON.parse(await readFile(path.join(root, "config", "toolbox-method-registry.json"), "utf8"));

assert.equal(PUBLIC_SURFACE_VERSION, "rootbound-public-preview-v5");
assert.equal(new Set(PUBLIC_TOOL_NAMES).size, PUBLIC_TOOL_NAMES.length, "public tool names must be unique");
assert.ok(PUBLIC_TOOL_NAMES.includes("codex.workspace_open"));
assert.ok(PUBLIC_TOOL_NAMES.includes("codex.command_poll"));
assert.ok(PUBLIC_TOOL_NAMES.includes("codex.edit_undo"));
assert.ok(PUBLIC_TOOL_NAMES.includes("codex.edit_redo"));
assert.equal(PUBLIC_TOOL_NAMES.some((name) => name.startsWith("codex.agent_")), false);

assert.equal(methodRegistry.defaultAction, "deny");
for (const [method, entry] of Object.entries(methodRegistry.remoteAllowlist ?? {})) {
  assert.equal(entry.classification, "model-free", `${method} must remain model-free`);
  for (const tool of entry.bridgeTools ?? []) assert.ok(PUBLIC_TOOL_NAMES.includes(tool), `${method} registry references non-public bridge tool ${tool}`);
}

assert.match(workflow, /workflow_dispatch\s*:/);
assert.doesNotMatch(workflow, /^\s*push\s*:/m, "V5 CI must remain manual-only during stabilization");
assert.doesNotMatch(workflow, /^\s*pull_request\s*:/m, "V5 CI must remain manual-only during stabilization");
assert.match(workflow, /node scripts\/validate-v5-syntax\.mjs/);
assert.match(workflow, /node scripts\/check-lock-root\.mjs/);
await access(path.join(root, "scripts", "validate-v5-syntax.mjs"));
await access(path.join(root, "scripts", "validate-v5.mjs"));
await access(path.join(root, "scripts", "check-lock-root.mjs"));
await access(path.join(root, "src", "tunnel-bootstrap.mjs"));
await access(path.join(root, "src", "connection-registry.mjs"));
await access(path.join(root, "src", "connection-paths.mjs"));
await access(path.join(root, "src", "runtime-mutation-lock.mjs"));
await access(path.join(root, "scripts", "connection-cli.mjs"));

assert.equal(packageJson.engines?.node, ">=22.13.0");
assert.equal(packageJson.bin?.rootbound, "bin/rootbound-entry.mjs");
assert.equal(packageJson.repository?.url, "git+https://github.com/LeoMbm/Rootbound.git");
assert.match(packageJson.description ?? "", /Apple Silicon macOS Technical Preview/);
assert.doesNotMatch(packageJson.description ?? "", /^Windows and Apple Silicon macOS Technical Preview/);
assert.equal(packageJson.homepage, "https://github.com/LeoMbm/Rootbound#readme");
assert.equal(packageJson.bugs?.url, "https://github.com/LeoMbm/Rootbound/issues");
assert.equal(packageJson.scripts?.["check:syntax"], "node scripts/validate-v5-syntax.mjs");
assert.equal(packageJson.scripts?.["validate:v5"], "node scripts/validate-v5.mjs");
assert.match(packageJson.scripts?.["validate:release"] ?? "", /check:lock:strict/);
assert.match(packageJson.scripts?.["test:v5"] ?? "", /tunnel-bootstrap-v5\.mjs/, "test:v5 must cover guided tunnel bootstrap");
assert.match(packageJson.scripts?.["test:v5"] ?? "", /runtime-mutation-lock-v5\.mjs/, "test:v5 must serialize runtime mutations");
assert.match(packageJson.scripts?.["test:v5"] ?? "", /runtime-readiness-v5\.mjs/, "test:v5 must require scoped tunnel readiness");
assert.match(packageJson.scripts?.["test:v5"] ?? "", /connection-registry-v5\.mjs/, "test:v5 must cover connection registry durability");
assert.match(packageJson.scripts?.["test:v5"] ?? "", /connection-tunnel-isolation-v5\.mjs/, "test:v5 must cover connection tunnel isolation");
assert.match(packageJson.scripts?.["test:v5"] ?? "", /connection-switch-v5\.mjs/, "test:v5 must cover connection switch rollback");
assert.match(packageJson.scripts?.["test:v5"] ?? "", /rescue-continuity-v5\.mjs/, "test:v5 must cover quota-rescue continuity");
assert.match(packageJson.scripts?.["test:v5"] ?? "", /release-contract-v5\.mjs/, "test:v5 must include the release contract guard");
assert.ok(packageJson.files?.includes("docs/plans/rootbound-v5.md"), "V5 plan must be packaged because README links to it");

assert.match(installSh, /for entry in[^\n]*\bdocs\b/);
assert.match(installSh, /bin\/rootbound-stdio\.sh/);
assert.match(installSh, /Refusing to replace a Git checkout/);
assert.match(installSh, /\.local\/bin/);
assert.match(installSh, /CLI_LINK=.*rootbound/);
assert.match(installSh, /Rootbound CLI >>>/);
assert.match(installPs1, /"docs"/);
assert.match(installPs1, /Join-Path \(Join-Path \$env:LOCALAPPDATA "Rootbound"\) "app"/);
assert.match(installPs1, /Refusing to replace a Git checkout/);
assert.match(upgradeScript, /Refusing in-place self-upgrade/);
assert.match(uninstallSh, /stop_runtime_before_uninstall/);
assert.match(uninstallSh, /stop --force --json/);
assert.match(uninstallPs1, /stop --force --json/);
assert.match(rootboundEntry, /rootbound project remove/);
assert.match(rootboundEntry, /rootbound trust remove/);
assert.match(rootboundEntry, /rootbound connection list/);
assert.match(rootboundEntry, /connection-cli\.mjs/);
assert.match(rootboundEntry, /withRuntimeMutationLock/);
assert.match(connectionCli, /CONNECTION_SWITCH_FAILED_RESTORED/);
assert.match(connectionCli, /validateManagedTunnel/);

const selfUpgrade = spawnSync(process.execPath, [path.join(root, "scripts", "upgrade.mjs"), "--from", root, "--json"], {
  cwd: root,
  encoding: "utf8",
});
assert.equal(selfUpgrade.status, 1, "upgrade --from the running checkout must fail closed");
const selfUpgradeResult = JSON.parse(selfUpgrade.stdout);
assert.equal(selfUpgradeResult.ok, false);
assert.match(selfUpgradeResult.error, /Refusing in-place self-upgrade/);

assert.match(readme, /rootbound-public-preview-v5/);
assert.match(readme, /32 public tools/);
assert.match(readme, /Apple Silicon macOS Technical Preview/);
assert.match(readme, /Windows support is .*not part of this public preview yet/i);
assert.doesNotMatch(readme, /\*\*Windows \+ Apple Silicon macOS Technical Preview\*\*/);
assert.match(readme, /codex\.continuity_resume/);
assert.match(readme, /codex\.continuity_handoff/);
assert.match(readme, /codex\.continuity_rollback/);
assert.match(readme, /guided one-command/i);
assert.match(readme, /Normal setup: one command/i);
assert.match(readme, /rootbound connect \./);
assert.match(readme, /Permissions: approved runtime-only rootbound/);
assert.match(readme, /\.git\/index\.lock/);
assert.match(readme, /runtime-only named Codex profile/i);
assert.match(readme, /never written into `~\/\.codex\/config\.toml`/i);
assert.match(readme, /Advanced \/ manual tunnel configuration/);
assert.doesNotMatch(readme, /codex\.agent_(?:start|send|commit)/);
assert.doesNotMatch(readme, /exactly \*\*21/);

assert.match(tunnelBootstrap, /writeManagedTunnelSetup/);
assert.match(tunnelBootstrap, /api_key:/);
assert.match(tunnelBootstrap, /file:\$\{paths\.tunnelSecretPath\}/);
assert.match(tunnelBootstrap, /"doctor", "--profile-file"/);
assert.match(tunnelBootstrap, /url_file:/);
assert.match(tunnelCli, /Normal users should run:/);
assert.match(tunnelCli, /rootbound connect \./);

assert.match(security, /Rootbound V5 public surface/);
assert.match(security, /32 public tools/);
assert.match(security, /Rescue rollback/);
assert.match(security, /Rootbound Codex permission profile/);
assert.match(security, /ROOTBOUND_PROFILE=rootbound/);
assert.match(security, /process-local `default_permissions=":workspace"`/);
assert.match(security, /remote HTTP does not assume/i);
assert.doesNotMatch(security, /codex\.agent_(?:start|send|commit)/);
assert.doesNotMatch(security, /exactly 21 tools/);

assert.match(readmeZh, /V5/);
assert.match(readmeZh, /README\.md/);
assert.doesNotMatch(readmeZh, /codex\.agent_(?:start|send|commit)/);

console.log("release-contract-v5: ok");
