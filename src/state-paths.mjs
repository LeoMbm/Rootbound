import os from "node:os";
import path from "node:path";
import { mkdir } from "node:fs/promises";

export function resolveRootboundPaths({ env = process.env, platform = process.platform, home = os.homedir() } = {}) {
  const override = typeof env.ROOTBOUND_HOME === "string" && env.ROOTBOUND_HOME.trim()
    ? path.resolve(env.ROOTBOUND_HOME.trim())
    : null;

  let root = override;
  if (!root && platform === "win32") {
    const localAppData = typeof env.LOCALAPPDATA === "string" && env.LOCALAPPDATA.trim()
      ? env.LOCALAPPDATA.trim()
      : path.join(home, "AppData", "Local");
    root = path.join(localAppData, "Rootbound");
  }
  if (!root && platform === "darwin") root = path.join(home, "Library", "Application Support", "Rootbound");
  if (!root) {
    const xdgState = typeof env.XDG_STATE_HOME === "string" && env.XDG_STATE_HOME.trim()
      ? env.XDG_STATE_HOME.trim()
      : path.join(home, ".local", "state");
    root = path.join(xdgState, "rootbound");
  }

  const stateDir = path.join(root, "state");
  const runtimeDir = path.join(root, "runtime");
  const logsDir = path.join(root, "logs");
  const backupsDir = path.join(root, "backups");
  return Object.freeze({
    root,
    appDir: path.join(root, "app"),
    stateDir,
    dbPath: path.join(stateDir, "rootbound.sqlite3"),
    tunnelConfigPath: path.join(stateDir, "tunnel.json"),
    tunnelManagedProfilePath: path.join(stateDir, "tunnel-client.yaml"),
    tunnelSecretPath: path.join(stateDir, "tunnel-runtime.key"),
    runtimeDir,
    runtimeStatePath: path.join(runtimeDir, "runtime.json"),
    logsDir,
    logPath: path.join(logsDir, "rootbound.log"),
    backupsDir,
  });
}

export async function ensureRootboundStateDirs(paths) {
  for (const dir of [paths.stateDir, paths.runtimeDir, paths.logsDir, paths.backupsDir]) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  }
  return paths;
}
