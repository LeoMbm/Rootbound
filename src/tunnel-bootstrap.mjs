import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { ensureRootboundStateDirs } from "./state-paths.mjs";
import { clearTunnelConfig, saveTunnelConfig } from "./tunnel-config.mjs";

const execFileAsync = promisify(execFile);
const TUNNEL_ID_PATTERN = /^tunnel_[0-9a-f]{32}$/;

export const MINIMUM_TUNNEL_CLIENT_VERSION = "0.0.12";
export const RECOMMENDED_TUNNEL_CLIENT_VERSION = "0.0.15";
export const DEFAULT_ROOTBOUND_HTTP_HOST = "127.0.0.1";
export const DEFAULT_ROOTBOUND_HTTP_PORT = 7690;

export const TUNNEL_SETUP_URLS = Object.freeze({
  tunnels: "https://platform.openai.com/settings/organization/tunnels",
  runtimeKeys: "https://platform.openai.com/settings/organization/api-keys",
  connectors: "https://chatgpt.com/#settings/Connectors",
});

export function validateTunnelId(value) {
  return typeof value === "string" && TUNNEL_ID_PATTERN.test(value.trim());
}

export function validateRuntimeKey(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 8192 && value.trim() === value && !/[\u0000\r\n]/.test(value);
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
      const pattern = /\btunnel_id\s*:\s*["']?(tunnel_[0-9a-f]{32})["']?/g;
      for (const match of text.matchAll(pattern)) add(match[1], `profile:${entry.name}`, profilePath);
    }
  }
  return candidates;
}

export function parseTunnelClientVersion(value) {
  const text = String(value ?? "").trim();
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?(?:\s|$)/.exec(text);
  if (!match) return null;
  return {
    version: `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}`,
    parts: [Number(match[1]), Number(match[2]), Number(match[3])],
  };
}

export function compareTunnelClientVersions(left, right) {
  const a = typeof left === "string" ? parseTunnelClientVersion(left)?.parts : left?.parts;
  const b = typeof right === "string" ? parseTunnelClientVersion(right)?.parts : right?.parts;
  if (!a || !b) throw new Error("compareTunnelClientVersions requires parseable semantic versions");
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  }
  return 0;
}

export async function probeTunnelClient({
  command = "tunnel-client",
  env = process.env,
  cwd = process.cwd(),
  timeoutMs = 5000,
  execFileFn = execFileAsync,
  minimumVersion = MINIMUM_TUNNEL_CLIENT_VERSION,
  recommendedVersion = RECOMMENDED_TUNNEL_CLIENT_VERSION,
} = {}) {
  let stdout = "";
  let stderr = "";
  try {
    ({ stdout = "", stderr = "" } = await execFileFn(command, ["--version"], {
      cwd,
      env,
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 512 * 1024,
    }));
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

  const parsed = parseTunnelClientVersion(stdout || stderr);
  if (!parsed) {
    const failed = new Error(`tunnel-client version could not be parsed from: ${cleanToolOutput(stdout || stderr)}`);
    failed.code = "TUNNEL_CLIENT_VERSION_UNPARSEABLE";
    throw failed;
  }
  if (compareTunnelClientVersions(parsed, minimumVersion) < 0) {
    const failed = new Error(`tunnel-client ${parsed.version} is unsupported; Rootbound requires ${minimumVersion} or newer.`);
    failed.code = "TUNNEL_CLIENT_VERSION_UNSUPPORTED";
    failed.version = parsed.version;
    failed.minimumVersion = minimumVersion;
    throw failed;
  }
  return {
    ok: true,
    command,
    version: parsed.version,
    minimumVersion,
    recommendedVersion,
    recommended: compareTunnelClientVersions(parsed, recommendedVersion) >= 0,
  };
}

export async function writeManagedTunnelSetup({
  tunnelId,
  apiKey,
  packageRoot,
  paths,
  nodePath = "node",
  tunnelClientCommand = "tunnel-client",
  platform = process.platform,
  transport = "http",
  mcpServerUrl = buildHttpServerUrl(),
} = {}) {
  if (!validateTunnelId(tunnelId)) throw new Error("Invalid OpenAI tunnel id; expected tunnel_ followed by 32 lowercase hexadecimal characters.");
  if (!validateRuntimeKey(apiKey)) throw new Error("Invalid runtime API key format.");
  if (!packageRoot) throw new Error("writeManagedTunnelSetup requires packageRoot");
  if (!paths?.tunnelManagedProfilePath || !paths?.tunnelSecretPath) throw new Error("writeManagedTunnelSetup requires Rootbound state paths");
  if (!["http", "stdio"].includes(transport)) throw new Error("writeManagedTunnelSetup transport must be http or stdio");
  if (transport === "http") assertLoopbackMcpUrl(mcpServerUrl);

  if (paths.stateDir) await ensureRootboundStateDirs(paths);
  await mkdir(path.dirname(paths.tunnelSecretPath), { recursive: true, mode: 0o700 });
  if (paths.tunnelHealthUrlPath) await unlink(paths.tunnelHealthUrlPath).catch((error) => { if (error?.code !== "ENOENT") throw error; });
  await writePrivateFile(paths.tunnelSecretPath, apiKey, { platform });

  const mcpCommand = transport === "stdio" ? buildStdioCommand({ nodePath, packageRoot }) : null;
  const mcpBinding = transport === "http"
    ? ["  server_urls:", "    - channel: main", `      url: ${yamlString(mcpServerUrl)}`]
    : ["  commands:", "    - channel: main", `      command: ${yamlString(mcpCommand)}`];
  const profile = [
    "config_version: 1",
    "control_plane:",
    `  base_url: ${yamlString("https://api.openai.com")}`,
    `  tunnel_id: ${yamlString(tunnelId)}`,
    `  api_key: ${yamlString(`file:${paths.tunnelSecretPath}`)}`,
    "health:",
    `  listen_addr: ${yamlString("127.0.0.1:0")}`,
    ...(paths.tunnelHealthUrlPath ? [`  url_file: ${yamlString(paths.tunnelHealthUrlPath)}`] : []),
    "admin_ui:",
    "  open_browser: false",
    "log:",
    "  level: info",
    "  format: json",
    "mcp:",
    ...mcpBinding,
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
    healthUrlPath: paths.tunnelHealthUrlPath ?? null,
    transport,
    mcpServerUrl: transport === "http" ? mcpServerUrl : null,
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
  execFileFn = execFileAsync,
  packageRoot = cwd,
  platform = process.platform,
} = {}) {
  if (!profilePath) throw new Error("validateManagedTunnel requires profilePath");
  const profile = await inspectManagedTunnelProfile({ profilePath });
  let validationProfilePath = profilePath;
  let temporaryProfilePath = null;
  if (profile.transport === "http") {
    temporaryProfilePath = `${profilePath}.${process.pid}.doctor-stdio.yaml`;
    const source = await readFile(profilePath, "utf8");
    const validationSource = replaceManagedHttpBindingWithStdio(source, buildStdioCommand({ nodePath: process.execPath, packageRoot }));
    await writePrivateFile(temporaryProfilePath, validationSource, { platform });
    validationProfilePath = temporaryProfilePath;
  }
  try {
    const { stdout = "", stderr = "" } = await execFileFn(command, ["doctor", "--profile-file", validationProfilePath], {
      cwd,
      env: managedTunnelEnvironment(env),
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    return {
      ok: true,
      detail: cleanToolOutput(stdout || stderr || "tunnel-client doctor passed"),
      validationTransport: profile.transport === "http" ? "stdio" : profile.transport,
      runtimeTransport: profile.transport,
    };
  } catch (error) {
    const detail = cleanToolOutput(error?.stdout || error?.stderr || error?.message || "tunnel-client doctor failed");
    const failed = new Error(`OpenAI tunnel validation failed: ${detail}`);
    failed.code = "TUNNEL_DOCTOR_FAILED";
    throw failed;
  } finally {
    if (temporaryProfilePath) await unlink(temporaryProfilePath).catch(() => {});
  }
}

export async function rollbackManagedTunnelSetup({ paths } = {}) {
  if (!paths) return;
  await clearTunnelConfig({ paths }).catch(() => {});
  for (const target of [paths.tunnelManagedProfilePath, paths.tunnelSecretPath, paths.tunnelHealthUrlPath]) {
    if (!target) continue;
    await unlink(target).catch((error) => { if (error?.code !== "ENOENT") throw error; });
  }
}

export function managedTunnelEnvironment(env = process.env) {
  const safe = { ...env };
  for (const name of ["CONTROL_PLANE_TUNNEL_ID", "CONTROL_PLANE_API_KEY", "OPENAI_API_KEY", "TUNNEL_ID", "TUNNEL_API_KEY"]) delete safe[name];
  return safe;
}

export function buildStdioCommand({ nodePath = "node", packageRoot } = {}) {
  if (!packageRoot) throw new Error("buildStdioCommand requires packageRoot");
  return [nodePath, path.join(packageRoot, "scripts", "launch.mjs"), "stdio"].map(quoteCommandArg).join(" ");
}

export function buildHttpServerUrl({ host = DEFAULT_ROOTBOUND_HTTP_HOST, port = DEFAULT_ROOTBOUND_HTTP_PORT } = {}) {
  if (!["127.0.0.1", "localhost", "::1"].includes(host)) throw new Error("Rootbound managed HTTP MCP must bind to loopback");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Rootbound managed HTTP MCP port must be between 1 and 65535");
  const authority = host === "::1" ? `[${host}]:${port}` : `${host}:${port}`;
  return `http://${authority}/mcp`;
}

export async function inspectManagedTunnelProfile({ profilePath } = {}) {
  if (!profilePath) return { managed: false, transport: null, serverUrl: null };
  let text;
  try { text = await readFile(profilePath, "utf8"); }
  catch (error) {
    if (error?.code === "ENOENT") return { managed: false, transport: null, serverUrl: null };
    throw error;
  }
  const serverUrl = text.match(/\n\s*server_urls:\s*\n\s*-\s*channel:\s*main\s*\n\s*url:\s*["']?([^\s"'\n]+)["']?/m)?.[1] ?? null;
  if (serverUrl) {
    assertLoopbackMcpUrl(serverUrl);
    return { managed: true, transport: "http", serverUrl };
  }
  if (/\n\s*commands:\s*\n\s*-\s*channel:\s*main\s*\n\s*command:/m.test(text)) {
    return { managed: true, transport: "stdio", serverUrl: null };
  }
  return { managed: true, transport: "unknown", serverUrl: null };
}

function replaceManagedHttpBindingWithStdio(source, command) {
  const block = /\n  server_urls:\n    - channel: main\n      url: [^\n]+\n/;
  if (!block.test(source)) throw new Error("Managed HTTP tunnel profile is missing the expected main server_url binding");
  return source.replace(block, `\n  commands:\n    - channel: main\n      command: ${yamlString(command)}\n`);
}

function assertLoopbackMcpUrl(value) {
  let parsed;
  try { parsed = new URL(String(value)); }
  catch { throw new Error("Rootbound managed HTTP MCP URL is invalid"); }
  if (parsed.protocol !== "http:" || !["127.0.0.1", "localhost", "::1"].includes(parsed.hostname) || parsed.pathname !== "/mcp") {
    throw new Error("Rootbound managed HTTP MCP URL must be loopback http://.../mcp");
  }
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

function yamlString(value) { return JSON.stringify(String(value)); }
function cleanToolOutput(value) {
  const text = String(value ?? "").trim().replaceAll(/\u001b\[[0-9;]*m/g, "");
  if (!text) return "no details returned";
  return text.length > 1200 ? `${text.slice(0, 1200)}…` : text;
}
