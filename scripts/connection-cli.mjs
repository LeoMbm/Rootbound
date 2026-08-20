import process from "node:process";
import { addConnection, getActiveConnection, getConnection, loadConnectionRegistry, setActiveConnection } from "../src/connection-registry.mjs";
import { resolveConnectionPaths } from "../src/connection-paths.mjs";
import { resolveRootboundPaths } from "../src/state-paths.mjs";
import { tunnelConfigStatus } from "../src/tunnel-config.mjs";

const paths = resolveRootboundPaths();
const argv = process.argv.slice(2);
const command = argv.shift() ?? "list";
const json = takeFlag(argv, "--json");

try {
  if (command === "list") await list();
  else if (command === "current") await current();
  else if (command === "add") await add();
  else if (command === "switch") await switchConnection();
  else if (command === "help" || command === "-h" || command === "--help") help();
  else throw usage(`Unknown connection command: ${command}`);
} catch (error) {
  const value = { ok: false, error: error instanceof Error ? error.message : String(error), ...(error?.code ? { errorCode: error.code } : {}) };
  if (json) process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  else process.stderr.write(`Rootbound connection: ${value.error}\n`);
  process.exitCode = error?.usage ? 2 : 1;
}

async function list() {
  requireNoArgs();
  const registry = await loadConnectionRegistry({ paths });
  const rows = registry.connections.map((connection) => ({ ...connection, active: connection.id === registry.activeConnectionId, tunnel: safeTunnelStatus(connection) }));
  if (json) return emit({ ok: true, action: "connection-list", activeConnectionId: registry.activeConnectionId, connections: rows });
  process.stdout.write(`Connections: ${rows.length}\n`);
  for (const row of rows) process.stdout.write(`${row.active ? "*" : " "} ${row.name}  ${row.tunnel.tunnelId ?? row.tunnel.configured ? row.tunnel.tunnelId ?? "configured" : "not configured"}\n`);
}

async function current() {
  requireNoArgs();
  const registry = await loadConnectionRegistry({ paths });
  const connection = getActiveConnection(registry);
  if (!connection) throw errorCode("CONNECTION_NOT_CONFIGURED", "No active connection. Run `rootbound connect .` or `rootbound connection add <name>`.");
  const tunnel = safeTunnelStatus(connection);
  emit({ ok: true, action: "connection-current", connection, tunnel });
  if (!json) {
    process.stdout.write(`Connection: ${connection.name}\n`);
    if (tunnel.tunnelId) process.stdout.write(`Tunnel: ${tunnel.tunnelId}\n`);
  }
}

async function add() {
  const name = argv.shift();
  if (!name || argv.length) throw usage("Usage: rootbound connection add <name> [--json]");
  const result = await addConnection({ paths, name });
  emit({ ok: true, action: "connection-added", connection: result.connection, activeConnectionId: result.registry.activeConnectionId });
  if (!json) {
    process.stdout.write(`Connection "${result.connection.name}" added.\n`);
    process.stdout.write(`Configure it with:\n  rootbound tunnel configure --connection ${result.connection.name} ...\n`);
    if (result.registry.activeConnectionId !== result.connection.id) process.stdout.write(`Switch with:\n  rootbound connection switch ${result.connection.name}\n`);
  }
}

async function switchConnection() {
  const selector = argv.shift();
  if (!selector || argv.length) throw usage("Usage: rootbound connection switch <name-or-id> [--json]");
  const registry = await loadConnectionRegistry({ paths });
  const target = getConnection(registry, selector);
  if (!target) throw errorCode("CONNECTION_NOT_FOUND", `No connection matches: ${selector}`);
  const tunnel = safeTunnelStatus(target);
  if (!tunnel.configured) throw errorCode("TUNNEL_NOT_CONFIGURED", `Connection "${target.name}" has no tunnel configuration.`);
  const result = await setActiveConnection({ paths, selector: target.id });
  emit({ ok: true, action: "connection-switched", connection: result.connection, tunnel, runtimeRestartRequired: true });
  if (!json) {
    process.stdout.write(`Active connection: ${result.connection.name}\n`);
    if (tunnel.tunnelId) process.stdout.write(`Tunnel: ${tunnel.tunnelId}\n`);
    process.stdout.write("Restart Rootbound to apply this connection to a running runtime.\n");
  }
}

function safeTunnelStatus(connection) {
  try { return tunnelConfigStatus({ paths: resolveConnectionPaths({ paths, connection }) }); }
  catch (error) { return { configured: false, status: "invalid", error: error instanceof Error ? error.message : String(error), errorCode: error?.code ?? "TUNNEL_CONFIG_INVALID" }; }
}
function takeFlag(values, flag) { const index = values.indexOf(flag); if (index < 0) return false; values.splice(index, 1); return true; }
function requireNoArgs() { if (argv.length) throw usage(`Unexpected argument: ${argv[0]}`); }
function emit(value) { if (json) process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); }
function usage(message) { const error = new Error(message); error.usage = true; return error; }
function errorCode(code, message) { const error = new Error(message); error.code = code; return error; }
function help() { process.stdout.write("Rootbound connections\n\n  rootbound connection list [--json]\n  rootbound connection current [--json]\n  rootbound connection add <name> [--json]\n  rootbound connection switch <name-or-id> [--json]\n"); }
