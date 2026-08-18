import { readFileSync } from "node:fs";
import { rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { inspectSensitiveArgv, redactArgv } from "./secret-boundaries.mjs";
import { ensureCodexlessStateDirs, resolveCodexlessPaths } from "./state-paths.mjs";
import { CodexlessToolError } from "./tool-errors.mjs";

const SCHEMA_VERSION = 1;
const ENV_PLACEHOLDER = /^\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/;
const KNOWN_PLACEHOLDERS = new Set(["{node}", "{packageRoot}", "{launchScript}", "{projectRoot}"]);
const CREDENTIAL_QUERY = /[?&](?:token|key|api_key|apikey|auth|authorization|sig|signature|secret|password)=/i;

export function resolveTunnelLaunch({ env = process.env, packageRoot, projectRoot = null, paths = resolveCodexlessPaths({ env }) } = {}) {
  if (!packageRoot) throw new Error("resolveTunnelLaunch requires packageRoot");
  const source = loadTunnelTemplate({ env, paths });
  const replacements = new Map([
    ["{node}", process.execPath],
    ["{packageRoot}", packageRoot],
    ["{launchScript}", path.join(packageRoot, "scripts", "launch.mjs")],
    ["{projectRoot}", projectRoot ?? ""],
  ]);
  const expanded = source.argv.map((value) => expandValue(value, { env, replacements }));
  if (expanded.some((value) => value === "")) throw tunnelError("TUNNEL_PROJECT_REQUIRED", "Tunnel argv uses {projectRoot}, but no project root was supplied.", ["Start/connect with a project root."]);
  return { command: expanded[0], args: expanded.slice(1), argv: expanded, source: source.source };
}

export async function saveTunnelConfig({ argv, paths = resolveCodexlessPaths() } = {}) {
  validateTunnelArgvTemplate(argv);
  await ensureCodexlessStateDirs(paths);
  const payload = { schemaVersion: SCHEMA_VERSION, argv: [...argv], updatedAt: Date.now() };
  const temp = `${paths.tunnelConfigPath}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, paths.tunnelConfigPath);
  return { configured: true, path: paths.tunnelConfigPath, argv: redactArgv(argv), envPlaceholders: envNames(argv) };
}

export async function clearTunnelConfig({ paths = resolveCodexlessPaths() } = {}) {
  try {
    await unlink(paths.tunnelConfigPath);
    return { configured: false, cleared: true, path: paths.tunnelConfigPath };
  } catch (error) {
    if (error?.code === "ENOENT") return { configured: false, cleared: false, path: paths.tunnelConfigPath };
    throw error;
  }
}

export function tunnelConfigStatus({ paths = resolveCodexlessPaths(), env = process.env } = {}) {
  if (typeof env.CODEXLESS_TUNNEL_ARGV_JSON === "string" && env.CODEXLESS_TUNNEL_ARGV_JSON.trim()) {
    const argv = parseArgvJson(env.CODEXLESS_TUNNEL_ARGV_JSON, "CODEXLESS_TUNNEL_ARGV_JSON");
    return { configured: true, source: "environment", path: null, argv: redactArgv(argv), envPlaceholders: envNames(argv) };
  }
  try {
    const payload = readPersistent(paths.tunnelConfigPath);
    return { configured: true, source: "persistent", path: paths.tunnelConfigPath, argv: redactArgv(payload.argv), envPlaceholders: envNames(payload.argv) };
  } catch (error) {
    if (error?.code === "ENOENT") return { configured: false, source: null, path: paths.tunnelConfigPath, argv: null, envPlaceholders: [] };
    throw error;
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
      { redactedArgv: redactArgv(argv), sensitiveArgumentCount: unsafe.length }
    );
  }
  return argv;
}

function loadTunnelTemplate({ env, paths }) {
  const raw = env.CODEXLESS_TUNNEL_ARGV_JSON;
  if (typeof raw === "string" && raw.trim()) {
    return { source: "environment", argv: parseArgvJson(raw, "CODEXLESS_TUNNEL_ARGV_JSON") };
  }
  try {
    const payload = readPersistent(paths.tunnelConfigPath);
    validateTunnelArgvTemplate(payload.argv);
    return { source: "persistent", argv: payload.argv };
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw tunnelError(
        "TUNNEL_NOT_CONFIGURED",
        "Secure MCP Tunnel is not configured. Configure it once with `codexless tunnel configure ...` or set CODEXLESS_TUNNEL_ARGV_JSON for a temporary override.",
        ["Run `codexless tunnel configure --argv-json '<json argv>'` using {env:VARIABLE} placeholders for credentials."]
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
  if (payload?.schemaVersion !== SCHEMA_VERSION || !Array.isArray(payload?.argv)) {
    throw tunnelError("TUNNEL_CONFIG_INVALID", `Unsupported persistent tunnel config schema: ${configPath}`);
  }
  return payload;
}

function expandValue(value, { env, replacements }) {
  if (replacements.has(value)) return replacements.get(value);
  const envMatch = value.match(ENV_PLACEHOLDER);
  if (envMatch) {
    const name = envMatch[1];
    const resolved = env[name];
    if (typeof resolved !== "string" || !resolved.length) {
      throw tunnelError("TUNNEL_ENV_MISSING", `Tunnel configuration requires environment variable ${name}, but it is not set.`, [`Export ${name} in the environment that starts Codexless.`]);
    }
    return resolved;
  }
  return value;
}

function parseArgvJson(raw, label) {
  let argv;
  try { argv = JSON.parse(raw); }
  catch { throw tunnelError("TUNNEL_CONFIG_INVALID", `${label} must be valid JSON.`); }
  if (!Array.isArray(argv) || argv.length < 1 || !argv.every((value) => typeof value === "string" && value.length > 0)) {
    throw tunnelError("TUNNEL_CONFIG_INVALID", `${label} must be a non-empty JSON array of non-empty strings.`);
  }
  return argv;
}

function envNames(argv) {
  return [...new Set(argv.flatMap((value) => {
    const match = String(value).match(ENV_PLACEHOLDER);
    return match ? [match[1]] : [];
  }))];
}

function tunnelError(code, message, nextActions = [], details = null) {
  return new CodexlessToolError(message, { code, category: code.includes("SECRET") ? "safety" : "configuration", retryable: false, nextActions, details });
}
