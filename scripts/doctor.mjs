import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { CodexAppServerClient } from "../src/codex-app-server-client.mjs";
import { ACCEPTED_CODEX_VERSIONS, CodexAuthorityExecutor } from "../src/codex-authority-executor.mjs";
import { probeCodexExecutable, redactHomePath, resolveCodexExecutable } from "../src/codex-bin.mjs";
import { readJsonFile } from "../src/json-file.mjs";
import { PUBLIC_SERVER_VERSION, PUBLIC_SURFACE_VERSION, PUBLIC_TOOL_NAMES } from "../src/surface-contracts.mjs";

const require = createRequire(import.meta.url);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const packageJson = await readJsonFile(path.join(projectRoot, "package.json"), "package.json");
const args = parseArgs(process.argv.slice(2));
const callerCwd = path.resolve(process.cwd());
const explicitCwd = args.cwd ? path.resolve(args.cwd) : null;
const requestedCwd = explicitCwd ?? (callerCwd !== projectRoot ? callerCwd : null);
const runtimeCwd = requestedCwd ?? projectRoot;
const checks = [];
const warnings = [];
let codexResolution = null;
let codexProbe = null;
let appServer = null;
let projectContext = null;

const supportedPlatform = process.platform === "win32" || (process.platform === "darwin" && process.arch === "arm64");
record("platform", supportedPlatform, supportedPlatform ? `${process.platform}/${process.arch}` : `Unsupported platform: ${process.platform}/${process.arch}`);
const nodeSupported = compareVersion(process.versions.node, "22.13.0") >= 0;
record("node", nodeSupported, `Node ${process.version}`, nodeSupported ? null : "Node.js >=22.13.0 is required by the V5 SQLite state layer");

const forbiddenModelTools = PUBLIC_TOOL_NAMES.filter((name) =>
  name === "codex.account_preflight" ||
  name === "codex.model_list" ||
  name.startsWith("codex.agent_")
);
const uniqueToolNames = new Set(PUBLIC_TOOL_NAMES).size === PUBLIC_TOOL_NAMES.length;
const expectedSurface = PUBLIC_SURFACE_VERSION === "rootbound-public-preview-v5" && uniqueToolNames && PUBLIC_TOOL_NAMES.length > 0;
record(
  "public-surface",
  expectedSurface && forbiddenModelTools.length === 0,
  `${PUBLIC_SURFACE_VERSION}; ${PUBLIC_TOOL_NAMES.length} tools; modelLane=chatgpt-only`,
  forbiddenModelTools.length
    ? `Forbidden Codex model tools exposed: ${forbiddenModelTools.join(", ")}`
    : !uniqueToolNames
      ? "Public tool list contains duplicate names"
      : "Expected a non-empty unique ChatGPT-only V5 public surface"
);
record(
  "surface-compatibility",
  expectedSurface,
  expectedSurface ? `V5 surface contract is internally consistent (${PUBLIC_TOOL_NAMES.length} tools)` : "Surface contract is stale or incomplete",
  expectedSurface ? null : "Restart/reconnect the Rootbound MCP connection after upgrading so ChatGPT refreshes its cached tool snapshot"
);

for (const spec of ["@modelcontextprotocol/node", "@modelcontextprotocol/server", "zod"]) {
  try {
    const resolved = require.resolve(spec);
    const local = isWithin(projectRoot, resolved) && resolved.toLowerCase().includes(`${path.sep}node_modules${path.sep}`.toLowerCase());
    record(`dependency:${spec}`, local, local ? "resolved from Rootbound node_modules" : "resolved outside Rootbound", local ? null : "Run npm ci in the Rootbound install directory");
  } catch (error) {
    record(`dependency:${spec}`, false, "not resolvable", error instanceof Error ? error.message : String(error));
  }
}

try {
  codexResolution = await resolveCodexExecutable({ acceptedVersions: ACCEPTED_CODEX_VERSIONS });
  codexProbe = await probeCodexExecutable(codexResolution.path, { cwd: runtimeCwd });
  record("codex-executable", codexProbe.ok, codexProbe.versionText ?? "Codex version probe failed", codexProbe.error);
  const parsedVersion = parseCodexVersion(codexProbe.versionText);
  const versionAccepted = Boolean(parsedVersion && ACCEPTED_CODEX_VERSIONS.includes(parsedVersion));
  record(
    "codex-version-gate",
    versionAccepted,
    parsedVersion ? `Codex CLI ${parsedVersion}` : "Codex CLI version could not be parsed",
    versionAccepted ? null : `Accepted Codex builds: ${ACCEPTED_CODEX_VERSIONS.join(", ")}`
  );
} catch (error) {
  record("codex-executable", false, "Codex executable resolution failed", error instanceof Error ? error.message : String(error));
}

if (codexResolution?.path && codexProbe?.ok) {
  const client = new CodexAppServerClient({
    cwd: runtimeCwd,
    launch: () => ({ command: codexResolution.path, args: ["app-server", "--stdio"], options: { cwd: runtimeCwd } }),
    requestTimeoutMs: 20_000,
    initializeCapabilities: { experimentalApi: true },
    stderrHandler: () => {},
    clientInfo: { name: "rootbound_doctor", title: "Rootbound Doctor", version: packageJson.version },
  });
  try {
    const initialized = await client.start();
    appServer = { ok: true, serverName: initialized?.serverInfo?.name ?? null, serverVersion: initialized?.serverInfo?.version ?? null };
    record("codex-app-server", true, "initialize succeeded");
  } catch (error) {
    appServer = { ok: false, error: sanitizeText(error instanceof Error ? error.message : String(error)) };
    record("codex-app-server", false, "initialize failed", appServer.error);
  } finally {
    await client.close().catch(() => {});
  }

  if (requestedCwd) {
    try {
      const authority = new CodexAuthorityExecutor({ codexBin: codexResolution.path, defaultCwd: requestedCwd, acceptedCodexVersions: ACCEPTED_CODEX_VERSIONS });
      await authority.validate();
      const resolved = await authority.resolveAuthority({ cwd: requestedCwd, access: "readOnly" });
      projectContext = {
        ok: true,
        cwd: redactHomePath(resolved.effectiveCwd),
        permissionProfile: resolved.permissionProfile,
        permissionCeiling: resolved.permissionCeiling,
        authoritySource: resolved.authoritySource,
        trustedAncestor: redactHomePath(resolved.trustedAncestor),
      };
      record("project-authority", true, `read-only authority accepted ${redactHomePath(requestedCwd)} as ${resolved.permissionProfile}`);
    } catch (error) {
      projectContext = { ok: false, error: sanitizeText(error instanceof Error ? error.message : String(error)) };
      warnings.push({ kind: "project-authority", message: projectContext.error });
    }
  }
}

const failedCoreChecks = checks.filter((check) => check.required && !check.ok);
const status = failedCoreChecks.length ? "error" : warnings.length || (requestedCwd && !projectContext?.ok) ? "partial" : "ok";
const result = {
  status,
  rootbound: {
    packageVersion: packageJson.version,
    serverVersion: PUBLIC_SERVER_VERSION,
    surfaceVersion: PUBLIC_SURFACE_VERSION,
    publicToolCount: PUBLIC_TOOL_NAMES.length,
    modelLane: "chatgpt-only",
    installRoot: redactHomePath(projectRoot),
  },
  host: { platform: process.platform, arch: process.arch, node: process.version },
  codex: {
    resolutionSource: codexResolution?.source ?? null,
    executable: codexResolution?.path ? redactHomePath(codexResolution.path) : null,
    version: codexProbe?.versionText ?? null,
    appServer,
  },
  project: requestedCwd ? projectContext ?? { ok: false, error: "project context was not checked" } : { status: "not_requested" },
  checks,
  warnings: dedupeWarnings(warnings),
  notes: [
    "The public MCP surface is ChatGPT-only and exposes no Codex model/agent/quota routing tools.",
    "Codex App Server remains the local sandbox, permission, history, and command execution substrate.",
    "Doctor does not start a Codex model turn.",
    "After a surface upgrade, reconnect ChatGPT to refresh its cached MCP tool snapshot.",
    "Tunnel connectivity and optional Browser Reader prerequisites are verified separately."
  ],
};

if (args.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
else printHuman(result);
process.exitCode = status === "error" ? 1 : 0;

function parseArgs(argv) {
  const parsed = { json: false, cwd: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") parsed.json = true;
    else if (arg === "--cwd") {
      const value = argv[i + 1];
      if (!value) throw new Error("--cwd requires a path");
      parsed.cwd = value;
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write("Usage: node scripts/doctor.mjs [--json] [--cwd <project-directory>]\n");
      process.exit(0);
    } else throw new Error(`Unknown doctor argument: ${arg}`);
  }
  return parsed;
}
function record(name, ok, detail, action = null) {
  checks.push({ name, ok: Boolean(ok), required: true, detail: sanitizeText(detail), ...(action ? { action: sanitizeText(action) } : {}) });
}
function parseCodexVersion(text) {
  const match = String(text ?? "").match(/codex-cli\s+([^\s]+)/i);
  return match?.[1] ?? null;
}
function compareVersion(a, b) {
  const left = String(a).split(".").map((part) => Number.parseInt(part, 10));
  const right = String(b).split(".").map((part) => Number.parseInt(part, 10));
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const delta = (left[i] ?? 0) - (right[i] ?? 0);
    if (delta !== 0) return delta > 0 ? 1 : -1;
  }
  return 0;
}
function isWithin(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
function sanitizeText(value) {
  return String(value ?? "")
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1<redacted>@")
    .replace(/([?&](?:token|key|api_key|apikey|auth|authorization|sig|signature|secret)=)[^&\s"']+/gi, "$1<redacted>")
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]{8,}=*/gi, "Bearer <redacted>");
}
function dedupeWarnings(rows) {
  const seen = new Set();
  return rows.filter((row) => {
    const key = `${row.kind}:${row.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
function printHuman(value) {
  const mark = (ok) => ok ? "PASS" : "FAIL";
  process.stdout.write(`Rootbound doctor: ${value.status.toUpperCase()}\n`);
  process.stdout.write(`Version ${value.rootbound.packageVersion} | ${value.rootbound.surfaceVersion} | ${value.rootbound.publicToolCount} public tools | ChatGPT-only\n\n`);
  for (const check of value.checks) {
    process.stdout.write(`[${mark(check.ok)}] ${check.name}: ${check.detail}\n`);
    if (!check.ok && check.action) process.stdout.write(`       -> ${check.action}\n`);
  }
  if (value.project.status !== "not_requested") process.stdout.write(`\nProject authority: ${value.project.ok ? "ok" : "needs attention"}\n`);
  if (value.warnings.length) {
    process.stdout.write("\nWarnings:\n");
    for (const warning of value.warnings) process.stdout.write(`- ${warning.kind}: ${warning.message}\n`);
  }
  process.stdout.write("\nNo Codex model turn was started.\n");
}
