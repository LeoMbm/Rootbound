import process from "node:process";
import { getActiveConnection, loadConnectionRegistry } from "../src/connection-registry.mjs";
import { resolveConnectionPaths } from "../src/connection-paths.mjs";
import { resolveRootboundPaths } from "../src/state-paths.mjs";
import { runtimeStatus } from "../src/runtime-state.mjs";
import { rollbackManagedTunnelSetup } from "../src/tunnel-bootstrap.mjs";
import { saveTunnelConfig, tunnelConfigStatus } from "../src/tunnel-config.mjs";

const args = process.argv.slice(2);
const command = args.shift() ?? "show";

try {
  if (command === "configure") await configure(args);
  else if (command === "show" || command === "status") show(args);
  else if (command === "clear") await clear(args);
  else if (command === "help" || command === "-h" || command === "--help") printHelp();
  else throw usage(`Unknown tunnel command: ${command}`);
} catch (error) {
  const payload = { ok: false, error: error instanceof Error ? error.message : String(error) };
  if (typeof error?.code === "string") payload.errorCode = error.code;
  if (typeof error?.category === "string") payload.category = error.category;
  if (Array.isArray(error?.nextActions)) payload.nextActions = error.nextActions;
  if (args.includes("--json")) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else {
    process.stderr.write(`Rootbound tunnel: ${payload.error}\n`);
    for (const action of payload.nextActions ?? []) process.stderr.write(`  -> ${action}\n`);
  }
  process.exitCode = error?.usage ? 2 : 1;
}

async function configure(argv) {
  const parsed = parseConfigure(argv);
  const result = await saveTunnelConfig({ argv: parsed.argv });
  emit({ ok: true, action: "configured", source: "persistent", ...result }, parsed.json);
}
function show(argv) {
  const json = onlyJson(argv);
  const result = tunnelConfigStatus();
  emit({ ok: true, action: "status", ...result }, json);
}
async function clear(argv) {
  const json = onlyJson(argv);
  const paths = resolveRootboundPaths();
  const registry = await loadConnectionRegistry({ paths });
  const active = getActiveConnection(registry);
  const targetPaths = active ? resolveConnectionPaths({ paths, connection: active }) : paths;
  const runtime = await runtimeStatus(paths);
  if (runtime.running && active && (runtime.state?.connectionId === active.id || (!runtime.state?.connectionId && active.storageKind === "legacy-global"))) {
    const error = new Error(`Refusing to clear tunnel configuration for active connection "${active.name}" while Rootbound is running. Switch connections or run rootbound stop first.`);
    error.code = "CONNECTION_IN_USE";
    throw error;
  }
  const before = tunnelConfigStatus({ paths: targetPaths });
  await rollbackManagedTunnelSetup({ paths: targetPaths });
  const after = tunnelConfigStatus({ paths: targetPaths });
  emit({
    ok: true,
    action: "clear",
    configured: after.configured,
    cleared: before.source === "persistent",
    path: before.path ?? after.path,
    connectionId: before.connectionId ?? active?.id ?? null,
    managedArtifactsCleared: true,
    environmentOverrideActive: after.source === "environment",
  }, json);
}

function parseConfigure(argv) {
  let json = false;
  let rawJson = null;
  let separator = -1;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") json = true;
    else if (arg === "--argv-json") {
      if (!argv[index + 1]) throw usage("--argv-json requires a JSON argv array");
      rawJson = argv[++index];
    } else if (arg === "--") { separator = index; break; }
    else throw usage(`Unknown tunnel configure option: ${arg}`);
  }
  if (rawJson !== null && separator >= 0) throw usage("Use either --argv-json or -- <argv...>, not both");
  let commandArgv;
  if (rawJson !== null) {
    try { commandArgv = JSON.parse(rawJson); }
    catch { throw usage("--argv-json must be valid JSON"); }
  } else if (separator >= 0) commandArgv = argv.slice(separator + 1);
  else throw usage("tunnel configure requires --argv-json <json> or -- <argv...>");
  return { argv: commandArgv, json };
}
function onlyJson(argv) {
  for (const arg of argv) if (arg !== "--json") throw usage(`Unknown option: ${arg}`);
  return argv.includes("--json");
}
function emit(value, json) {
  if (json) process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  else if (value.action === "configured") {
    process.stdout.write(`Rootbound tunnel configured.\nSource: persistent\nConfig: ${value.path}\n`);
    if (value.envPlaceholders?.length) process.stdout.write(`Required environment: ${value.envPlaceholders.join(", ")}\n`);
  } else if (value.action === "status") {
    process.stdout.write(`Tunnel: ${value.configured ? "configured" : "not configured"}\n`);
    if (value.source) process.stdout.write(`Source: ${value.source}\n`);
    if (value.tunnelId) process.stdout.write(`Tunnel ID: ${value.tunnelId}\n`);
    if (value.path) process.stdout.write(`Config: ${value.path}\n`);
    if (value.argv) process.stdout.write(`Argv: ${value.argv.join(" ")}\n`);
    if (value.envPlaceholders?.length) process.stdout.write(`Required environment: ${value.envPlaceholders.join(", ")}\n`);
  } else {
    process.stdout.write(`Tunnel config cleared: ${value.cleared ? "yes" : "already absent"}\n`);
    if (value.managedArtifactsCleared) process.stdout.write("Guided tunnel setup state cleared.\n");
    if (value.environmentOverrideActive) process.stdout.write("Note: ROOTBOUND_TUNNEL_ARGV_JSON is still active in the environment.\n");
  }
}
function printHelp() {
  process.stdout.write(`Rootbound tunnel configuration (advanced)\n\nNormal users should run:\n  rootbound connect .\n\nAdvanced/manual usage:\n  rootbound tunnel configure --argv-json '["tunnel-client", "run", "--profile", "my-profile"]'\n  rootbound tunnel configure -- tunnel-client run --profile my-profile\n  rootbound tunnel show [--json]\n  rootbound tunnel clear [--json]\n\nTunnel commands operate on the active Rootbound connection. Clearing the tunnel used by a running runtime is refused. Persistent manual config refuses literal credentials. The guided connect wizard keeps its runtime key outside argv/tunnel.json.\n`);
}
function usage(message) { const error = new Error(message); error.usage = true; return error; }
