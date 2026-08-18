import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { open } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { ensureCodexlessStateDirs, resolveCodexlessPaths } from "../src/state-paths.mjs";
import { clearRuntimeState, writeRuntimeState } from "../src/runtime-state.mjs";
import { resolveTunnelLaunch } from "../src/tunnel-config.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const paths = await ensureCodexlessStateDirs(resolveCodexlessPaths());
const projectRoot = process.env.CODEXLESS_PROJECT_ROOT || null;
const projectRef = process.env.CODEXLESS_PROJECT_REF || null;
const runtimeId = `runtime_${randomUUID()}`;
const restartLimit = parseBoundedInt(process.env.CODEXLESS_TUNNEL_RESTART_LIMIT ?? "3", 0, 20, "CODEXLESS_TUNNEL_RESTART_LIMIT");
const launch = resolveTunnelLaunch({ packageRoot, projectRoot });
const logHandle = await open(paths.logPath, "a", 0o600);
let child = null;
let stopping = false;
let restarts = 0;

log(`supervisor start pid=${process.pid} project=${projectRef ?? "none"} tunnelSource=${launch.source ?? "unknown"}`);
await startChild();

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

async function startChild() {
  const startedAt = Date.now();
  child = spawn(launch.command, launch.args, {
    cwd: projectRoot ?? packageRoot,
    env: { ...process.env, CODEXLESS_STDIO_NODE: process.execPath, CODEXLESS_STDIO_SCRIPT: path.join(packageRoot, "scripts", "launch.mjs") },
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
  await writeRuntimeState(paths, {
    schemaVersion: 1,
    status: "running",
    runtimeId,
    supervisorPid: process.pid,
    pid: process.pid,
    tunnelPid: child.pid,
    startedAt,
    projectRef,
    projectRoot,
    transport: "secure-mcp-tunnel",
    tunnelSource: launch.source ?? null,
  });
  log(`tunnel running pid=${child.pid}`);
  child.once("exit", (code, signal) => void onChildExit(code, signal));
}

async function onChildExit(code, signal) {
  log(`tunnel exit code=${code} signal=${signal}`);
  child = null;
  if (stopping) return;
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
  log(`supervisor shutdown ${signal}`);
  const current = child;
  if (current && current.exitCode === null && current.signalCode === null) {
    try { current.kill("SIGTERM"); } catch {}
    await Promise.race([new Promise((resolve) => current.once("exit", resolve)), new Promise((resolve) => setTimeout(resolve, 2000))]);
    if (current.exitCode === null && current.signalCode === null) { try { current.kill("SIGKILL"); } catch {} }
  }
  await clearRuntimeState(paths).catch(() => {});
  await logHandle.close().catch(() => {});
  process.exit(0);
}

function log(message) { logHandle.write(`${new Date().toISOString()} [${runtimeId}] ${message}\n`); }
function parseBoundedInt(value, min, max, label) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || String(parsed) !== String(value) || parsed < min || parsed > max) throw new Error(`${label} must be an integer between ${min} and ${max}`);
  return parsed;
}
