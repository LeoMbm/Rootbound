import { readFileSync } from "node:fs";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { inspectSensitiveArgv, redactArgv } from "./secret-boundaries.mjs";
import { ensureRootboundStateDirs, resolveRootboundPaths } from "./state-paths.mjs";
import { RootboundToolError } from "./tool-errors.mjs";

const SCHEMA_VERSION = 1;
const ENV_PLACEHOLDER = /^\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/;
const KNOWN_PLACEHOLDERS = new Set(["{node}", "{packageRoot}", "{launchScript}", "{projectRoot}"]);
const CREDENTIAL_QUERY = /[?&](?:token|key|api_key|apikey|auth|authorization|sig|signature|secret|password)=/i;

export function resolveTunnelLaunch({ env = process.env, packageRoot, projectRoot = null, paths = resolveRootboundPaths({ env }) } = {}) {
  if (!packageRoot) throw new Error("resolveTunnelLaunch requires packageRoot");
  const effectivePaths = effectiveTunnelPaths(paths);
  const source = loadTunnelTemplate({ env, paths: effectivePaths });
  const replacements = new Map([
    ["{node}", process.execPath],
    ["{packageRoot}", packageRoot],
    ["{launchScript}", path.join(packageRoot, "scripts", "launch.mjs")],
    ["{projectRoot}", projectRoot ?? ""],
  ]);
  const expanded = source.argv.map((value) => expandValue(value, { env, replacements }));
  if (expanded.some((value) => value === "")) throw tunnelError("TUNNEL_PROJECT_REQUIRED", "Tunnel argv uses {projectRoot}, but no project root was supplied.", ["Start/connect with a project root."]);
  return { command: expanded[0], args: expanded.slice(1), argv: expanded, source: source.source, connectionId: effectivePaths.connectionId ?? null };
}

export async function saveTunnelConfig({ argv, paths = resolveRootboundPaths() } = {}) {
  validateTunnelArgvTemplate(argv);
  await ensureRootboundStateDirs(paths);
  const effectivePaths = effectiveTunnelPaths(paths);
  await mkdir(path.dirname(effectivePaths.tunnelConfigPath), { recursive: true, mode: 0o700 });
  const payload = { schemaVersion: SCHEMA_VERSION, argv: [...argv], updatedAt: Date.now() };
  const temp = `${effectivePaths.tunnelConfigPath}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, effectivePaths.tunnelConfigPath);
  return { configured: true, path: effectivePaths.tunnelConfigPath, argv: redactTemplateArgv(argv), envPlaceholders: envNames(argv), connectionId: effectivePaths.connectionId ?? null };
}

export async function clearTunnelConfig({ paths = resolveRootboundPaths() } = {}) {
  const effectivePaths = effectiveTunnelPaths(paths);
  try {
    await unlink(effectivePaths.tunnelConfigPath);
    return { configured: false, cleared: true, path: effectivePaths.tunnelConfigPath, connectionId: effectivePaths.connectionId ?? null };
  } catch (error) {
    if (error?.code === "ENOENT") return { configured: false, cleared: false, path: effectivePaths.tunnelConfigPath, connectionId: effectivePaths.connectionId ?? null };
    throw error;
  }
}

export function tunnelConfigStatus({ paths = resolveRootboundPaths(), env = process.env } = {}) {
  const effectivePaths = effectiveTunnelPaths(paths);
  if (!effectivePaths?.connectionId && typeof env.ROOTBOUND_TUNNEL_ARGV_JSON === "string" && env.ROOTBOUND_TUNNEL_ARGV_JSON.trim()) {
    const argv = parseArgvJson(env.ROOTBOUND_TUNNEL_ARGV_JSON, "ROOTBOUND_TUNNEL_ARGV_JSON");
    return { configured: true, source: "environment", path: null, argv: redactTemplateArgv(argv), envPlaceholders: envNames(argv) };
  }
  try {
    const payload = readPersistent(effectivePaths.tunnelConfigPath);
    return {
      configured: true,
      source: "persistent",
      path: effectivePaths.tunnelConfigPath,
      argv: redactTemplateArgv(payload.argv),
      envPlaceholders: envNames(payload.argv),
      tunnelId: managedTunnelId(payload.argv, effectivePaths),
      connectionId: effectivePaths.connectionId ?? null,
    };
  } catch (error) {
    if (error?.code === "ENOENT") return { configured: false, source: null, path: effectivePaths.tunnelConfigPath, argv: null, envPlaceholders: [], connectionId: effectivePaths.connectionId ?? null };
    throw error;
  }
}

function effectiveTunnelPaths(paths) {
  if (!paths || paths.connectionId || !paths.connectionRegistryPath || !paths.connectionsDir) return paths;
  let registry;
  try { registry = JSON.parse(readFileSync(paths.connectionRegistryPath, "utf8")); }
  catch (error) { if (error?.code === "ENOENT") return paths; throw tunnelError("CONNECTION_REGISTRY_INVALID", `Invalid connection registry: ${paths.connectionRegistryPath}`); }
  const active = Array.isArray(registry?.connections) ? registry.connections.find((entry) => entry?.id === registry.activeConnectionId) : null;
  if (!active) return paths;
  if (active.storageKind === "legacy-global") return { ...paths, connectionId: active.id };
  if (active.storageKind !== "scoped-v1" || !/^connection_[0-9a-f]{24}$/.test(active.id)) throw tunnelError("CONNECTION_REGISTRY_INVALID", "Active connection has invalid storage metadata.");
  const connectionDir = path.join(paths.connectionsDir, active.id);
  return {
    ...paths,
    connectionId: active.id,
    connectionDir,
    tunnelConfigPath: path.join(connectionDir, "tunnel.json"),
    tunnelManagedProfilePath: path.join(connectionDir, "tunnel-client.yaml"),
    tunnelSecretPath: path.join(connectionDir, "tunnel-runtime.key"),
    tunnelHealthUrlPath: path.join(paths.runtimeDir, `tunnel-health-${active.id}.url`),
  };
}

function managedTunnelId(argv, paths) {
  const profileFlag = argv.findIndex((value) => value === "--profile-file");
  if (profileFlag < 0 || !argv[profileFlag + 1]) return null;
  const requestedProfile = path.resolve(argv[profileFlag + 1]);
  const managedProfile = path.resolve(paths.tunnelManagedProfilePath);
  if (requestedProfile !== managedProfile) return null;
  try {
    const profile = readFileSync(managedProfile, "utf8");
    return profile.match(/\btunnel_id\s*:\s*["']?(tunnel_[0-9a-f]{32})["']?/)?.[1] ?? null;
  } catch {
    return null;
  }
}

export function validateTunnelArgvTemplate(argv) {
  if (!Array.isArray(argv) || argv.length < 1 || !argv.every((value) => typeof value === "string" && value.length > 0)) {
    throw tunnelError("TUNNEL_CONFIG_INVALID", "Tunnel argv must be a non-empty array of non-empty strings.");
  }
  for (const value of argv) {
    if (CREDENTIAL_QUERY.test(value)) {
      throw tunnelError("TUNNEL_SECRET_PERSISTENCE_BLOCKED", "Tunnel configuration cannot persist credentials inside URL query parameters.", ["Pass credentials through an environment variable supported by the tunnel client."]);
    }
    if (/^\{[^}]+\}$/.test(value) && !KNOWN_PLACEHOLDERS.has(value) && !ENV_PLACEHOLDER.test(value)) {
      throw tunnelError("TUNNEL_PLACEHOLDER_INVALID", `Unknown tunnel placeholder: ${value}`);
    }
  }
  const unsafe = inspectSensitiveArgv(argv).filter((finding) => !ENV_PLACEHOLDER.test(argv[finding.index] ?? ""));
  if (unsafe.length) {
    throw tunnelError(
      "TUNNEL_SECRET_PERSISTENCE_BLOCKED",
      "Tunnel configuration appears to contain a literal credential. Persistent tunnel config stores only non-secret argv; use {env:VARIABLE} for secret arguments.",
      ["Replace the credential argument with a placeholder such as {env:TUNNEL_TOKEN} and export that variable locally."],
      { redactedArgv: redactTemplateArgv(argv), sensitiveArgumentCount: unsafe.length }
    );
  }
  return argv;
}

function loadTunnelTemplate({ env, paths }) {
  const raw = !paths?.connectionId ? env.ROOTBOUND_TUNNEL_ARGV_JSON : null;
  if (typeof raw === "string" && raw.trim()) return { source: "environment", argv: parseArgvJson(raw, "ROOTBOUND_TUNNEL_ARGV_JSON") };
  try {
    const payload = readPersistent(paths.tunnelConfigPath);
    validateTunnelArgvTemplate(payload.argv);
    return { source: "persistent", argv: payload.argv };
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw tunnelError(
        "TUNNEL_NOT_CONFIGURED",
        "Secure MCP Tunnel is not configured for the active connection. Run `rootbound connect .` or configure this connection first.",
        ["Run `rootbound connection current` to inspect the active connection."]
      );
    }
    throw error;
  }
}

function readPersistent(configPath) {
  let payload;
  try { payload = JSON.parse(readFileSync(configPath, "utf8")); }
  catch (error) {
    if (error?.code === "ENOENT") throw error;
    throw tunnelError("TUNNEL_CONFIG_INVALID", `Invalid persistent tunnel config: ${configPath}`);
  }
  if (payload?.schemaVersion !== SCHEMA_VERSION || !Array.isArray(payload?.argv)) throw tunnelError("TUNNEL_CONFIG_INVALID", `Unsupported persistent tunnel config schema: ${configPath}`);
  return payload;
}

function expandValue(value, { env, replacements }) {
  if (replacements.has(value)) return replacements.get(value);
  const envMatch = value.match(ENV_PLACEHOLDER);
  if (envMatch) {
    const name = envMatch[1];
    const resolved = env[name];
    if (typeof resolved !== "string" || !resolved.length) throw tunnelError("TUNNEL_ENV_MISSING", `Tunnel configuration requires environment variable ${name}, but it is not set.`, [`Export ${name} in the environment that starts Rootbound.`]);
    return resolved;
  }
  return value;
}

function parseArgvJson(raw, label) {
  let argv;
  try { argv = JSON.parse(raw); }
  catch { throw tunnelError("TUNNEL_CONFIG_INVALID", `${label} must be valid JSON.`); }
  if (!Array.isArray(argv) || argv.length < 1 || !argv.every((value) => typeof value === "string" && value.length > 0)) throw tunnelError("TUNNEL_CONFIG_INVALID", `${label} must be a non-empty JSON array of non-empty strings.`);
  return argv;
}

function envNames(argv) {
  return [...new Set(argv.flatMap((value) => {
    const match = String(value).match(ENV_PLACEHOLDER);
    return match ? [match[1]] : [];
  }))];
}

function redactTemplateArgv(argv) {
  const redacted = redactArgv(argv);
  return redacted.map((value, index) => ENV_PLACEHOLDER.test(argv[index] ?? "") ? argv[index] : value);
}

function tunnelError(code, message, nextActions = [], details = null) {
  return new RootboundToolError(message, { code, category: code.includes("SECRET") ? "safety" : "configuration", retryable: false, nextActions, details });
}
