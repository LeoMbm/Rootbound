import { open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";

export async function readRuntimeState(paths) {
  try {
    return JSON.parse(await readFile(paths.runtimeStatePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    if (error instanceof SyntaxError) throw new Error(`Invalid Rootbound runtime state: ${paths.runtimeStatePath}`);
    throw error;
  }
}

export async function writeRuntimeState(paths, value) {
  const temp = `${paths.runtimeStatePath}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, paths.runtimeStatePath);
  return value;
}

export async function clearRuntimeState(paths) {
  try { await unlink(paths.runtimeStatePath); } catch (error) { if (error?.code !== "ENOENT") throw error; }
}

export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === "EPERM"; }
}

export async function runtimeStatus(paths) {
  const state = await readRuntimeState(paths);
  if (!state) return { status: "stopped", running: false, stale: false, state: null };
  const running = isProcessAlive(state.pid);
  return { status: running ? "running" : "stale", running, stale: !running, state };
}

export async function stopRuntime(paths, { force = false } = {}) {
  const current = await runtimeStatus(paths);
  if (!current.state) return { status: "stopped", stopped: false, reason: "not_running" };
  if (!current.running) {
    await clearRuntimeState(paths);
    return { status: "stopped", stopped: false, reason: "stale_state_cleared", previousPid: current.state.pid ?? null };
  }
  const signal = force ? "SIGKILL" : "SIGTERM";
  process.kill(current.state.pid, signal);
  const deadline = Date.now() + (force ? 1500 : 5000);
  while (Date.now() < deadline) {
    if (!isProcessAlive(current.state.pid)) {
      await clearRuntimeState(paths);
      return { status: "stopped", stopped: true, signal, previousPid: current.state.pid };
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return { status: "stopping", stopped: false, signal, pid: current.state.pid };
}

export async function tailLog(logPath, { maxBytes = 64 * 1024 } = {}) {
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 1024 * 1024) throw new Error("maxBytes must be between 1 and 1048576");
  let info;
  try { info = await stat(logPath); } catch (error) { if (error?.code === "ENOENT") return ""; throw error; }
  const length = Math.min(info.size, maxBytes);
  if (length === 0) return "";
  const handle = await open(logPath, "r");
  try {
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, info.size - length);
    return buffer.toString("utf8");
  } finally {
    await handle.close();
  }
}
