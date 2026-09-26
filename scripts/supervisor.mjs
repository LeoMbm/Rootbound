import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { open, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { getActiveConnection, getConnection, loadConnectionRegistry } from "../src/connection-registry.mjs";
import { resolveConnectionPaths } from "../src/connection-paths.mjs";
import { assertRuntimeProjectAllowed } from "../src/runtime-project-lifecycle.mjs";
import { ensureRootboundStateDirs, resolveRootboundPaths } from "../src/state-paths.mjs";
import { clearRuntimeState, writeRuntimeState } from "../src/runtime-state.mjs";
import { resolveTunnelLaunch } from "../src/tunnel-config.mjs";
import { inspectManagedTunnelProfile, managedTunnelEnvironment } from "../src/tunnel-bootstrap.mjs";
import { readTunnelHealthSnapshot, summarizeTunnelHealth } from "../src/tunnel-health.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const paths = await ensureRootboundStateDirs(resolveRootboundPaths());
const projectRoot = process.env.ROOTBOUND_PROJECT_ROOT || null;
const projectRef = process.env.ROOTBOUND_PROJECT_REF || null;
const registry = await loadConnectionRegistry({ paths });
const requestedConnection = process.env.ROOTBOUND_CONNECTION_ID ? getConnection(registry, process.env.ROOTBOUND_CONNECTION_ID) : null;
const persistentConnection = requestedConnection ?? getActiveConnection(registry);
const connection = persistentConnection ?? (process.env.ROOTBOUND_TUNNEL_ARGV_JSON ? {
  id: "connection_environment",
  name: "environment",
  storageKind: "legacy-global",
  source: "environment",
  tunnelId: null,
} : null);
if (!connection) throw new Error("No active Rootbound connection; run `rootbound connect .` first.");
if (!projectRef || !projectRoot) throw new Error("Rootbound supervisor requires an anchor project identity.");
const environmentOnlyConnection = connection.source === "environment" && !persistentConnection;
const connectionPaths = environmentOnlyConnection ? paths : resolveConnectionPaths({ paths, connection });
if (!environmentOnlyConnection) await assertRuntimeProjectAllowed({ paths, registry, connection, projectRef });
const runtimeId = `runtime_${randomUUID()}`;
const restartLimit = parseBoundedInt(process.env.ROOTBOUND_TUNNEL_RESTART_LIMIT ?? "3", 0, 20, "ROOTBOUND_TUNNEL_RESTART_LIMIT");
const healthWatchdogIntervalMs = parseBoundedInt(process.env.ROOTBOUND_HEALTH_WATCHDOG_INTERVAL_MS ?? "5000", 100, 60000, "ROOTBOUND_HEALTH_WATCHDOG_INTERVAL_MS");
const healthFailureThreshold = parseBoundedInt(process.env.ROOTBOUND_HEALTH_FAILURE_THRESHOLD ?? "3", 1, 10, "ROOTBOUND_HEALTH_FAILURE_THRESHOLD");
const launchEnv = requestedConnection ? explicitConnectionEnvironment(process.env) : process.env;
const launch = resolveTunnelLaunch({ env: launchEnv, packageRoot, projectRoot, paths: connectionPaths });
const childBaseEnv = connection.storageKind === "scoped-v1" ? managedTunnelEnvironment(launchEnv) : launchEnv;
const managedProfile = connection.storageKind === "scoped-v1"
  ? await inspectManagedTunnelProfile({ profilePath: connectionPaths.tunnelManagedProfilePath })
  : { managed: false, transport: null, serverUrl: null };
const logHandle = await open(paths.logPath, "a", 0o600);
let child = null;
let mcpChild = null;
let stopping = false;
let restarts = 0;
let runtimeState = null;
let healthTimer = null;
let healthFailures = 0;
let watchdogBusy = false;

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
log(`supervisor start pid=${process.pid} anchorProject=${projectRef} connection=${connection.id} tunnel=${connection.tunnelId ?? "unknown"} tunnelSource=${launch.source ?? "unknown"}`);
await startChild();

async function startChild() {
  const startedAt = Date.now();
  await ensureManagedHttpMcp();
  if (connectionPaths.tunnelHealthUrlPath) await unlink(connectionPaths.tunnelHealthUrlPath).catch((error) => { if (error?.code !== "ENOENT") throw error; });
  child = spawn(launch.command, launch.args, {
    cwd: projectRoot,
    env: {
      ...childBaseEnv,
      ROOTBOUND_STDIO_NODE: process.execPath,
      ROOTBOUND_STDIO_SCRIPT: path.join(packageRoot, "scripts", "launch.mjs"),
      ROOTBOUND_CONNECTION_ID: connection.id,
    },
    stdio: ["ignore", logHandle.fd, logHandle.fd],
    windowsHide: true,
    shell: false,
  });
  child.once("error", (error) => log(`tunnel spawn error: ${error.message}`));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, 250);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code, signal) => { clearTimeout(timer); reject(new Error(`tunnel exited during startup: code=${code} signal=${signal}`)); });
  });

  const requiresReadiness = connection.storageKind === "scoped-v1";
  if (!requiresReadiness) await publishRuntime({ status: "starting", ready: false, startupReady: false, startedAt });
  const readiness = await waitForTunnelReadiness({ healthUrlPath: connectionPaths.tunnelHealthUrlPath, timeoutMs: requiresReadiness ? 4_000 : 10_000 });
  if (!readiness.ok && requiresReadiness) {
    try { child.kill("SIGTERM"); } catch {}
    throw new Error(`Tunnel did not become ready: ${readiness.error}`);
  }
  const readyAt = readiness.ok ? Date.now() : null;
  await publishRuntime({
    status: readiness.ok ? "ready" : "running",
    ready: readiness.ok,
    startupReady: readiness.ok,
    startedAt,
    readyAt,
    startupReadinessCheckedAt: Date.now(),
    legacyReadinessFallback: !readiness.ok,
  });
  log(`tunnel ${readiness.ok ? "ready" : "running (legacy readiness fallback)"} pid=${child.pid}`);
  child.once("exit", (code, signal) => void onChildExit(code, signal));
  startHealthWatchdog();
}

function runtimeValue(patch = {}) {
  return {
    schemaVersion: 3,
    status: "starting",
    ready: false,
    startupReady: false,
    runtimeId,
    supervisorPid: process.pid,
    pid: process.pid,
    tunnelPid: child?.pid ?? null,
    mcpPid: mcpChild?.pid ?? null,
    managedMcpTransport: managedProfile.transport ?? null,
    managedMcpServerUrl: managedProfile.serverUrl ?? null,
    startedAt: Date.now(),
    readyAt: null,
    startupReadinessCheckedAt: null,
    lastHealthCheckedAt: null,
    tunnelHealth: null,
    scopeMode: "multi-project",
    anchorProjectRef: projectRef,
    anchorProjectRoot: projectRoot,
    projectRef,
    projectRoot,
    connectionId: connection.id,
    connectionName: connection.name,
    tunnelId: connection.tunnelId ?? null,
    transport: "secure-mcp-tunnel",
    tunnelSource: launch.source ?? null,
    legacyReadinessFallback: false,
    ...(runtimeState ?? {}),
    ...patch,
    tunnelPid: child?.pid ?? null,
  };
}

async function publishRuntime(patch) {
  runtimeState = runtimeValue(patch);
  await writeRuntimeState(paths, runtimeState);
  return runtimeState;
}

function startHealthWatchdog() {
  if (healthTimer) clearInterval(healthTimer);
  healthFailures = 0;
  healthTimer = setInterval(() => void runHealthWatchdog(), healthWatchdogIntervalMs);
  healthTimer.unref?.();
  void runHealthWatchdog();
}

async function runHealthWatchdog() {
  if (watchdogBusy || stopping || !child || child.exitCode !== null || child.signalCode !== null) return;
  watchdogBusy = true;
  try {
    const snapshot = summarizeTunnelHealth(await readTunnelHealthSnapshot({ healthUrlPath: connectionPaths.tunnelHealthUrlPath }));
    const healthyLocalProcess = snapshot.available && snapshot.live;
    healthFailures = healthyLocalProcess ? 0 : healthFailures + 1;
    await publishRuntime({
      status: snapshot.ready ? "ready" : healthyLocalProcess ? "degraded" : "recovering",
      ready: snapshot.ready === true,
      lastHealthCheckedAt: Date.now(),
      tunnelHealth: snapshot,
    }).catch(() => {});
    if (!healthyLocalProcess && healthFailures >= healthFailureThreshold && child && child.exitCode === null && child.signalCode === null) {
      log(`health watchdog restarting tunnel after ${healthFailures} consecutive local health failures`);
      healthFailures = 0;
      try { child.kill("SIGTERM"); } catch {}
    }
  } finally {
    watchdogBusy = false;
  }
}

async function ensureManagedHttpMcp() {
  if (managedProfile.transport !== "http") return;
  if (mcpChild && mcpChild.exitCode === null && mcpChild.signalCode === null) return;
  const target = new URL(managedProfile.serverUrl);
  const host = target.hostname;
  const port = Number.parseInt(target.port || "80", 10);
  mcpChild = spawn(process.execPath, [path.join(packageRoot, "scripts", "launch.mjs"), "http"], {
    cwd: projectRoot,
    env: {
      ...childBaseEnv,
      ROOTBOUND_HOST: host,
      ROOTBOUND_PORT: String(port),
      ROOTBOUND_CONNECTION_ID: connection.id,
    },
    stdio: ["ignore", logHandle.fd, logHandle.fd],
    windowsHide: true,
    shell: false,
  });
  const currentMcp = mcpChild;
  currentMcp.once("error", (error) => log(`mcp http spawn error: ${error.message}`));
  currentMcp.once("exit", (code, signal) => {
    if (mcpChild === currentMcp) mcpChild = null;
    log(`mcp http exit code=${code} signal=${signal}`);
    if (!stopping && child && child.exitCode === null && child.signalCode === null) {
      try { child.kill("SIGTERM"); } catch {}
    }
  });
  const deadline = Date.now() + 5000;
  let lastError = "MCP HTTP server did not become ready";
  while (Date.now() < deadline) {
    if (currentMcp.exitCode !== null || currentMcp.signalCode !== null) throw new Error(`MCP HTTP server exited during startup: code=${currentMcp.exitCode} signal=${currentMcp.signalCode}`);
    try {
      const response = await fetch(`${target.origin}/readyz`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) {
        log(`mcp http ready pid=${currentMcp.pid} url=${managedProfile.serverUrl}`);
        return;
      }
      lastError = `MCP HTTP /readyz returned HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  try { currentMcp.kill("SIGTERM"); } catch {}
  throw new Error(`MCP HTTP server did not become ready: ${lastError}`);
}

async function waitForTunnelReadiness({ healthUrlPath, timeoutMs }) {
  if (!healthUrlPath) return { ok: false, error: "health URL path unavailable" };
  const deadline = Date.now() + timeoutMs;
  let lastError = "health URL not published";
  while (Date.now() < deadline) {
    if (stopping) return { ok: false, error: "supervisor is stopping" };
    if (!child || child.exitCode !== null || child.signalCode !== null) return { ok: false, error: "tunnel exited before readiness" };
    try {
      const base = (await readFile(healthUrlPath, "utf8")).trim().replace(/\/$/, "");
      if (base) {
        const response = await fetch(`${base}/readyz`, { signal: AbortSignal.timeout(1500) });
        if (response.ok) return { ok: true, url: base };
        lastError = `/readyz returned HTTP ${response.status}`;
      }
    } catch (error) {
      if (error?.code !== "ENOENT") lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return { ok: false, error: lastError };
}

async function onChildExit(code, signal) {
  log(`tunnel exit code=${code} signal=${signal}`);
  child = null;
  if (stopping) return;
  if (healthTimer) { clearInterval(healthTimer); healthTimer = null; }
  await publishRuntime({ status: "recovering", ready: false, lastHealthCheckedAt: Date.now() }).catch(() => {});
  if (restarts >= restartLimit) {
    log(`restart limit reached (${restartLimit}); supervisor stopping`);
    await clearRuntimeState(paths).catch(() => {});
    await logHandle.close().catch(() => {});
    process.exitCode = 1;
    return;
  }
  restarts += 1;
  const delay = Math.min(1000 * (2 ** (restarts - 1)), 8000);
  log(`restart ${restarts}/${restartLimit} in ${delay}ms`);
  await new Promise((resolve) => setTimeout(resolve, delay));
  try { await startChild(); }
  catch (error) {
    log(`restart failed: ${error instanceof Error ? error.message : String(error)}`);
    await onChildExit(null, "restart-failed");
  }
}

async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  if (healthTimer) { clearInterval(healthTimer); healthTimer = null; }
  log(`supervisor shutdown ${signal}`);
  const current = child;
  if (current && current.exitCode === null && current.signalCode === null) {
    try { current.kill("SIGTERM"); } catch {}
    await Promise.race([new Promise((resolve) => current.once("exit", resolve)), new Promise((resolve) => setTimeout(resolve, 2000))]);
    if (current.exitCode === null && current.signalCode === null) { try { current.kill("SIGKILL"); } catch {} }
  }
  const currentMcp = mcpChild;
  if (currentMcp && currentMcp.exitCode === null && currentMcp.signalCode === null) {
    try { currentMcp.kill("SIGTERM"); } catch {}
    await Promise.race([new Promise((resolve) => currentMcp.once("exit", resolve)), new Promise((resolve) => setTimeout(resolve, 2000))]);
    if (currentMcp.exitCode === null && currentMcp.signalCode === null) { try { currentMcp.kill("SIGKILL"); } catch {} }
  }
  if (connectionPaths.tunnelHealthUrlPath) await unlink(connectionPaths.tunnelHealthUrlPath).catch(() => {});
  await clearRuntimeState(paths).catch(() => {});
  await logHandle.close().catch(() => {});
  process.exit(0);
}

function explicitConnectionEnvironment(env) { const clean = { ...env }; delete clean.ROOTBOUND_TUNNEL_ARGV_JSON; return clean; }
function log(message) { logHandle.write(`${new Date().toISOString()} [${runtimeId}] ${message}\n`); }
function parseBoundedInt(value, min, max, label) { const parsed = Number.parseInt(value, 10); if (!Number.isInteger(parsed) || String(parsed) !== String(value) || parsed < min || parsed > max) throw new Error(`${label} must be an integer between ${min} and ${max}`); return parsed; }
