import { execFile } from "node:child_process";
import { chmod, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { ensureCodexlessStateDirs } from "./state-paths.mjs";
import { clearTunnelConfig, saveTunnelConfig } from "./tunnel-config.mjs";

const execFileAsync = promisify(execFile);
const TUNNEL_ID_PATTERN = /^tunnel_[a-z0-9]{32}$/;
const API_KEY_PATTERN = /^[0-9A-Za-z_-]+$/;

export const TUNNEL_SETUP_URLS = Object.freeze({
  tunnels: "https://platform.openai.com/settings/organization/tunnels",
  runtimeKeys: "https://platform.openai.com/settings/organization/api-keys",
  connectors: "https://chatgpt.com/#settings/Connectors",
});

export function validateTunnelId(value) {
  return typeof value === "string" && TUNNEL_ID_PATTERN.test(value.trim());
}

export function validateRuntimeKey(value) {
  return typeof value === "string" && value.length > 0 && value.trim() === value && API_KEY_PATTERN.test(value);
}

export async function discoverTunnelCandidates({ env = process.env, home = os.homedir(), profileDirs = null } = {}) {
  const candidates = [];
  const seen = new Set();
  const add = (id, source, profilePath = null) => {
    const normalized = String(id ?? "").trim();
    if (!validateTunnelId(normalized) || seen.has(normalized)) return;
    seen.add(normalized);
    candidates.push({ id: normalized, source, profilePath });
  };

  add(env.CONTROL_PLANE_TUNNEL_ID, "environment");

  const dirs = profileDirs ?? [defaultTunnelProfileDir({ env, home })];
  for (const dir of dirs) {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); }
    catch (error) { if (error?.code === "ENOENT") continue; else throw error; }
    for (const entry of entries) {
      if (!entry.isFile() || !/\.ya?ml$/i.test(entry.name)) continue;
      const profilePath = path.join(dir, entry.name);
      let text;
      try { text = await readFile(profilePath, "utf8"); }
      catch { continue; }
      const pattern = /\btunnel_id\s*:\s*["']?(tunnel_[a-z0-9]{32})["']?/g;
      for (const match of text.matchAll(pattern)) add(match[1], `profile:${entry.name}`, profilePath);
    }
  }
  return candidates;
}

export async function probeTunnelClient({ command = "tunnel-client", env = process.env, cwd = process.cwd(), timeoutMs = 5000 } = {}) {
  try {
    await execFileAsync(command, ["--help"], { cwd, env, timeout: timeoutMs, windowsHide: true, maxBuffer: 512 * 1024 });
    return { ok: true, command };
  } catch (error) {
    if (error?.code === "ENOENT") {
      const missing = new Error(`tunnel-client was not found on PATH. Install the supported tunnel-client from ${TUNNEL_SETUP_URLS.tunnels}, then retry.`);
      missing.code = "TUNNEL_CLIENT_NOT_FOUND";
      throw missing;
    }
    const detail = cleanToolOutput(error?.stderr || error?.stdout || error?.message || "tunnel-client probe failed");
    const failed = new Error(`tunnel-client is installed but could not start: ${detail}`);
    failed.code = "TUNNEL_CLIENT_UNAVAILABLE";
    throw failed;
  }
}

export async function writeManagedTunnelSetup({
  tunnelId,
  apiKey,
  packageRoot,
  paths,
  nodePath = process.execPath,
  tunnelClientCommand = "tunnel-client",
  platform = process.platform,
} = {}) {
  if (!validateTunnelId(tunnelId)) throw new Error("Invalid OpenAI tunnel id; expected tunnel_ followed by 32 lowercase letters/digits.");
  if (!validateRuntimeKey(apiKey)) throw new Error("Invalid runtime API key format.");
  if (!packageRoot) throw new Error("writeManagedTunnelSetup requires packageRoot");
  if (!paths?.tunnelManagedProfilePath || !paths?.tunnelSecretPath) throw new Error("writeManagedTunnelSetup requires Codexless state paths");

  await ensureCodexlessStateDirs(paths);
  await writePrivateFile(paths.tunnelSecretPath, apiKey, { platform });

  const mcpCommand = buildStdioCommand({ nodePath, packageRoot });
  const profile = [
    "config_version: 1",
    "control_plane:",
    `  base_url: ${yamlString("https://api.openai.com")}`,
    `  tunnel_id: ${yamlString(tunnelId)}`,
    `  api_key: ${yamlString(`file:${paths.tunnelSecretPath}`)}`,
    "health:",
    `  listen_addr: ${yamlString("127.0.0.1:0")}`,
    "admin_ui:",
    "  open_browser: false",
    "log:",
    "  level: info",
    "  format: json",
    "mcp:",
    "  commands:",
    "    - channel: main",
    `      command: ${yamlString(mcpCommand)}`,
    "",
  ].join("\n");
  await writePrivateFile(paths.tunnelManagedProfilePath, profile, { platform });

  const saved = await saveTunnelConfig({
    argv: [tunnelClientCommand, "run", "--profile-file", paths.tunnelManagedProfilePath],
    paths,
  });
  return {
    configured: true,
    source: "guided",
    tunnelId,
    profilePath: paths.tunnelManagedProfilePath,
    secretPath: paths.tunnelSecretPath,
    mcpCommand,
    tunnel: saved,
  };
}

export async function validateManagedTunnel({
  profilePath,
  command = "tunnel-client",
  env = process.env,
  cwd = process.cwd(),
  timeoutMs = 20_000,
} = {}) {
  if (!profilePath) throw new Error("validateManagedTunnel requires profilePath");
  try {
    const { stdout = "", stderr = "" } = await execFileAsync(command, ["doctor", "--profile-file", profilePath], {
      cwd,
      env,
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    return { ok: true, detail: cleanToolOutput(stdout || stderr || "tunnel-client doctor passed") };
  } catch (error) {
    const detail = cleanToolOutput(error?.stdout || error?.stderr || error?.message || "tunnel-client doctor failed");
    const failed = new Error(`OpenAI tunnel validation failed: ${detail}`);
    failed.code = "TUNNEL_DOCTOR_FAILED";
    throw failed;
  }
}

export async function rollbackManagedTunnelSetup({ paths } = {}) {
  if (!paths) return;
  await clearTunnelConfig({ paths }).catch(() => {});
  for (const target of [paths.tunnelManagedProfilePath, paths.tunnelSecretPath]) {
    if (!target) continue;
    await unlink(target).catch((error) => { if (error?.code !== "ENOENT") throw error; });
  }
}

export function buildStdioCommand({ nodePath = process.execPath, packageRoot } = {}) {
  if (!packageRoot) throw new Error("buildStdioCommand requires packageRoot");
  return [nodePath, path.join(packageRoot, "scripts", "launch.mjs"), "stdio"].map(quoteCommandArg).join(" ");
}

function defaultTunnelProfileDir({ env, home }) {
  if (typeof env.TUNNEL_CLIENT_PROFILE_DIR === "string" && env.TUNNEL_CLIENT_PROFILE_DIR.trim()) return path.resolve(env.TUNNEL_CLIENT_PROFILE_DIR.trim());
  const base = typeof env.XDG_CONFIG_HOME === "string" && env.XDG_CONFIG_HOME.trim()
    ? path.resolve(env.XDG_CONFIG_HOME.trim())
    : path.join(home, ".config");
  return path.join(base, "tunnel-client");
}

async function writePrivateFile(target, content, { platform }) {
  const temp = `${target}.${process.pid}.tmp`;
  await writeFile(temp, content, { mode: 0o600 });
  if (platform !== "win32") await chmod(temp, 0o600);
  if (platform === "win32") await unlink(target).catch((error) => { if (error?.code !== "ENOENT") throw error; });
  await rename(temp, target);
  if (platform !== "win32") await chmod(target, 0o600);
  else await hardenWindowsPrivateFile(target);
}

async function hardenWindowsPrivateFile(target) {
  const username = process.env.USERNAME;
  const domain = process.env.USERDOMAIN;
  const principal = username ? (domain ? `${domain}\\${username}` : username) : null;
  if (!principal) {
    const error = new Error("Cannot determine the current Windows account for tunnel secret ACL hardening.");
    error.code = "TUNNEL_SECRET_ACL_FAILED";
    throw error;
  }
  try {
    await execFileAsync("icacls", [target, "/inheritance:r", "/grant:r", `${principal}:(F)`], {
      windowsHide: true,
      timeout: 10_000,
      maxBuffer: 512 * 1024,
    });
  } catch {
    const error = new Error("Failed to restrict the guided tunnel secret file to the current Windows account.");
    error.code = "TUNNEL_SECRET_ACL_FAILED";
    throw error;
  }
}

function quoteCommandArg(value) {
  const text = String(value);
  if (text && !/[\s'"\\]/.test(text)) return text;
  if (!text.includes("'")) return `'${text}'`;
  return `"${text.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function yamlString(value) {
  return JSON.stringify(String(value));
}

function cleanToolOutput(value) {
  const text = String(value ?? "").trim().replaceAll(/\u001b\[[0-9;]*m/g, "");
  if (!text) return "no details returned";
  return text.length > 1200 ? `${text.slice(0, 1200)}…` : text;
}
