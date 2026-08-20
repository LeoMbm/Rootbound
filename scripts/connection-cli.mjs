import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { addConnection, createConnectionId, getActiveConnection, getConnection, loadConnectionRegistry, setActiveConnection } from "../src/connection-registry.mjs";
import { resolveConnectionPaths } from "../src/connection-paths.mjs";
import { runtimeStatus, stopRuntime, tailLog } from "../src/runtime-state.mjs";
import { resolveRootboundPaths } from "../src/state-paths.mjs";
import { tunnelConfigStatus } from "../src/tunnel-config.mjs";
import { discoverTunnelCandidates, probeTunnelClient, rollbackManagedTunnelSetup, TUNNEL_SETUP_URLS, validateManagedTunnel, validateRuntimeKey, validateTunnelId, writeManagedTunnelSetup } from "../src/tunnel-bootstrap.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
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
  for (const row of rows) {
    const label = row.tunnel.tunnelId ?? (row.tunnel.configured ? "configured" : "not configured");
    process.stdout.write(`${row.active ? "*" : " "} ${row.name}  ${label}\n`);
  }
}

async function current() {
  requireNoArgs();
  const registry = await loadConnectionRegistry({ paths });
  const connection = getActiveConnection(registry);
  if (!connection) throw errorCode("CONNECTION_NOT_CONFIGURED", "No active connection. Run `rootbound connect .` or `rootbound connection add <name>`.");
  const tunnel = safeTunnelStatus(connection);
  const runtime = await runtimeStatus(paths);
  emit({ ok: true, action: "connection-current", connection, tunnel, runtime });
  if (!json) {
    process.stdout.write(`Connection: ${connection.name}\n`);
    if (tunnel.tunnelId) process.stdout.write(`Tunnel: ${tunnel.tunnelId}\n`);
    process.stdout.write(`Runtime: ${runtime.status}${runtime.state?.connectionId === connection.id ? " (this connection)" : ""}\n`);
  }
}

async function add() {
  const name = argv.shift();
  if (!name || argv.length) throw usage("Usage: rootbound connection add <name> [--json]");
  const existingRegistry = await loadConnectionRegistry({ paths });
  if (getConnection(existingRegistry, name)) throw errorCode("CONNECTION_NAME_CONFLICT", `Connection already exists: ${name}`);
  if (json || !process.stdin.isTTY || !process.stdout.isTTY) throw usage("connection add requires an interactive terminal; non-interactive profile creation is not supported yet");

  process.stdout.write(`\nRootbound connection setup\nConnection: ${name}\n`);
  await probeTunnelClient({ cwd: packageRoot });
  process.stdout.write("✓ tunnel-client detected\n");
  const candidates = await discoverTunnelCandidates();
  const tunnelId = await chooseTunnel(candidates);
  const apiKey = await resolveRuntimeKey();
  const id = createConnectionId();
  const provisional = { id, name: String(name).trim(), storageKind: "scoped-v1", source: "guided", tunnelId };
  const connectionPaths = resolveConnectionPaths({ paths, connection: provisional });
  let managed = null;
  try {
    managed = await writeManagedTunnelSetup({ tunnelId, apiKey, packageRoot, paths: connectionPaths });
    process.stdout.write("Validating tunnel configuration...\n");
    await validateManagedTunnel({ profilePath: managed.profilePath, cwd: packageRoot });
    const result = await addConnection({ paths, id, name, tunnelId, storageKind: "scoped-v1", source: "guided" });
    process.stdout.write(`✓ Connection "${result.connection.name}" saved (${tunnelId})\n`);
    if (result.registry.activeConnectionId !== result.connection.id) process.stdout.write(`Switch with:\n  rootbound connection switch ${result.connection.name}\n`);
  } catch (error) {
    if (managed) await rollbackManagedTunnelSetup({ paths: connectionPaths }).catch(() => {});
    throw error;
  }
}

async function switchConnection() {
  const selector = argv.shift();
  if (!selector || argv.length) throw usage("Usage: rootbound connection switch <name-or-id> [--json]");
  const registry = await loadConnectionRegistry({ paths });
  const previous = getActiveConnection(registry);
  const target = getConnection(registry, selector);
  if (!target) throw errorCode("CONNECTION_NOT_FOUND", `No connection matches: ${selector}`);
  if (target.id === previous?.id) {
    const runtime = await runtimeStatus(paths);
    return outputSwitch({ target, runtime, alreadyActive: true });
  }
  const targetPaths = resolveConnectionPaths({ paths, connection: target });
  const tunnel = tunnelConfigStatus({ paths: targetPaths });
  if (!tunnel.configured) throw errorCode("TUNNEL_NOT_CONFIGURED", `Connection "${target.name}" has no tunnel configuration.`);
  if (targetPaths.tunnelManagedProfilePath && tunnel.tunnelId) await validateManagedTunnel({ profilePath: targetPaths.tunnelManagedProfilePath, cwd: packageRoot });

  const runtime = await runtimeStatus(paths);
  if (!runtime.running) {
    const changed = await setActiveConnection({ paths, selector: target.id });
    return outputSwitch({ target: changed.connection, runtime: await runtimeStatus(paths), tunnel });
  }
  if (!runtime.state?.projectRef || !runtime.state?.projectRoot) throw errorCode("RUNTIME_STATE_INVALID", "Running Rootbound runtime is missing its project identity; stop it before switching connections.");

  const previousTuple = { connection: previous, projectRef: runtime.state.projectRef, projectRoot: runtime.state.projectRoot };
  await stopForSwitch();
  try {
    const started = await launchSupervisor({ projectRef: previousTuple.projectRef, projectRoot: previousTuple.projectRoot, connectionId: target.id });
    if (started.state?.connectionId !== target.id || started.state?.ready !== true) throw new Error("Target connection runtime did not report ready state.");
    const changed = await setActiveConnection({ paths, selector: target.id });
    return outputSwitch({ target: changed.connection, runtime: started, tunnel, switchedFrom: previous?.name ?? null });
  } catch (error) {
    await stopRuntime(paths, { force: true }).catch(() => {});
    let restored = false;
    let restoreError = null;
    if (previousTuple.connection) {
      try {
        const restoredRuntime = await launchSupervisor({ projectRef: previousTuple.projectRef, projectRoot: previousTuple.projectRoot, connectionId: previousTuple.connection.id });
        restored = restoredRuntime.state?.connectionId === previousTuple.connection.id && (restoredRuntime.state?.ready === true || previousTuple.connection.storageKind === "legacy-global");
      } catch (failure) { restoreError = failure; }
    }
    const wrapped = new Error(restored
      ? `Failed to switch to "${target.name}": ${message(error)}. Previous connection "${previousTuple.connection?.name}" was restored.`
      : `Failed to switch to "${target.name}": ${message(error)}. Previous runtime could not be restored${restoreError ? `: ${message(restoreError)}` : "."}`);
    wrapped.code = restored ? "CONNECTION_SWITCH_FAILED_RESTORED" : "CONNECTION_SWITCH_FAILED_RESTORE_FAILED";
    throw wrapped;
  }
}

async function launchSupervisor({ projectRef, projectRoot, connectionId }) {
  const child = spawn(process.execPath, [path.join(packageRoot, "scripts", "supervisor.mjs")], {
    cwd: packageRoot,
    env: { ...process.env, ROOTBOUND_PROJECT_REF: projectRef, ROOTBOUND_PROJECT_ROOT: projectRoot, ROOTBOUND_CONNECTION_ID: connectionId, ROOTBOUND_PROFILE: "rootbound" },
    detached: true, windowsHide: true, stdio: "ignore",
  });
  let exited = null;
  child.once("exit", (code, signal) => { exited = { code, signal }; });
  child.unref();
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const status = await runtimeStatus(paths);
    if (status.running && status.state?.projectRef === projectRef && status.state?.connectionId === connectionId && (status.state?.ready === true || status.state?.legacyReadinessFallback === true)) return status;
    if (exited) {
      const detail = (await tailLog(paths.logPath, { maxBytes: 8192 })).trim();
      throw new Error(`Rootbound supervisor exited during connection switch (code=${exited.code} signal=${exited.signal})${detail ? `: ${detail}` : ""}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Rootbound supervisor did not become ready within 15 seconds.");
}

async function stopForSwitch() {
  let stopped = await stopRuntime(paths);
  if (stopped.status !== "stopped") stopped = await stopRuntime(paths, { force: true });
  if (stopped.status !== "stopped") throw errorCode("RUNTIME_STOP_FAILED", "Could not stop the active Rootbound runtime; refusing connection switch.");
}

async function chooseTunnel(candidates) {
  if (candidates.length) {
    process.stdout.write("OpenAI tunnels found:\n");
    candidates.forEach((candidate, index) => process.stdout.write(`  ${index + 1}. ${candidate.id} (${candidate.source})\n`));
    const answer = (await askQuestion(`Choose a tunnel [1-${candidates.length}] or paste a tunnel ID: `)).trim();
    const index = Number.parseInt(answer, 10) - 1;
    if (Number.isInteger(index) && index >= 0 && index < candidates.length) return candidates[index].id;
    if (validateTunnelId(answer)) return answer;
    throw usage("Invalid tunnel selection.");
  }
  process.stdout.write(`Create or inspect a tunnel here:\n  ${TUNNEL_SETUP_URLS.tunnels}\n`);
  const id = (await askQuestion("Paste tunnel ID: ")).trim();
  if (!validateTunnelId(id)) throw usage("Invalid tunnel ID; expected tunnel_ followed by 32 lowercase hexadecimal characters.");
  return id;
}

async function resolveRuntimeKey() {
  const preferred = process.env.CONTROL_PLANE_API_KEY;
  if (preferred) {
    if (!validateRuntimeKey(preferred)) throw usage("CONTROL_PLANE_API_KEY has an invalid format.");
    process.stdout.write("✓ Runtime API key detected (CONTROL_PLANE_API_KEY)\n");
    return preferred;
  }
  if (process.env.OPENAI_API_KEY) process.stdout.write("OPENAI_API_KEY is set, but Rootbound does not persist it automatically. Use a restricted tunnel Runtime API key (Tunnels Read + Use).\n");
  process.stdout.write(`Runtime API key required (Tunnels Read + Use).\nCreate or inspect it here:\n  ${TUNNEL_SETUP_URLS.runtimeKeys}\n`);
  const value = await askSecret("Paste runtime API key (input hidden): ");
  if (!validateRuntimeKey(value)) throw usage("Invalid runtime API key format.");
  return value;
}

function safeTunnelStatus(connection) {
  try { return tunnelConfigStatus({ paths: resolveConnectionPaths({ paths, connection }) }); }
  catch (error) { return { configured: false, status: "invalid", error: message(error), errorCode: error?.code ?? "TUNNEL_CONFIG_INVALID" }; }
}
function outputSwitch({ target, runtime, tunnel = safeTunnelStatus(target), switchedFrom = null, alreadyActive = false }) {
  const value = { ok: true, action: alreadyActive ? "connection-already-active" : "connection-switched", connection: target, tunnel, runtime, ...(switchedFrom ? { switchedFrom } : {}) };
  if (json) return emit(value);
  process.stdout.write(`Active connection: ${target.name}\n`);
  if (tunnel?.tunnelId) process.stdout.write(`Tunnel: ${tunnel.tunnelId}\n`);
  process.stdout.write(`Runtime: ${runtime.status}${runtime.state?.ready ? " (ready)" : ""}\n`);
}
function takeFlag(values, flag) { const index = values.indexOf(flag); if (index < 0) return false; values.splice(index, 1); return true; }
function requireNoArgs() { if (argv.length) throw usage(`Unexpected argument: ${argv[0]}`); }
function emit(value) { if (json) process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); }
function message(error) { return error instanceof Error ? error.message : String(error); }
function usage(text) { const error = new Error(text); error.usage = true; return error; }
function errorCode(code, text) { const error = new Error(text); error.code = code; return error; }
function help() { process.stdout.write("Rootbound connections\n\n  rootbound connection list [--json]\n  rootbound connection current [--json]\n  rootbound connection add <name>\n  rootbound connection switch <name-or-id> [--json]\n"); }
async function askQuestion(prompt) { const rl = readline.createInterface({ input: process.stdin, output: process.stdout }); try { return await rl.question(prompt); } finally { rl.close(); } }
async function askSecret(prompt) {
  if (!process.stdin.isTTY || !process.stdout.isTTY || typeof process.stdin.setRawMode !== "function") throw usage("Secret input requires an interactive terminal.");
  process.stdout.write(prompt);
  const input = process.stdin; const wasRaw = Boolean(input.isRaw); input.setRawMode(true); input.resume(); input.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let value = ""; let done = false;
    const cleanup = () => { input.off("data", onData); try { input.setRawMode(wasRaw); } catch {} if (!wasRaw) input.pause(); };
    const finish = (fn, result) => { if (done) return; done = true; cleanup(); process.stdout.write("\n"); fn(result); };
    const onData = (chunk) => { for (const ch of String(chunk)) { if (ch === "\u0003") return finish(reject, usage("setup cancelled")); if (ch === "\r" || ch === "\n") return finish(resolve, value); if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1); else if (ch >= " ") value += ch; } };
    input.on("data", onData);
  });
}
