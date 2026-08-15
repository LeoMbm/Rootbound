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
const requestedCwd = args.cwd ? path.resolve(args.cwd) : null;
const runtimeCwd = requestedCwd ?? projectRoot;
const checks = [];
const warnings = [];
const notes = [];
let codexResolution = null;
let codexProbe = null;
let appServer = null;
let projectContext = null;
let browser = { status: "not_checked", reason: "conditional_feature" };
let nodeRepl = { status: "not_checked", reason: "conditional_feature" };

const supportedPlatform = process.platform === "win32" || (process.platform === "darwin" && process.arch === "arm64");
record(
  "platform",
  supportedPlatform,
  process.platform === "win32"
    ? "Windows"
    : process.platform === "darwin" && process.arch === "arm64"
      ? "Apple Silicon macOS"
      : `Unsupported platform: ${process.platform}/${process.arch}`
);
const nodeMajor = Number.parseInt(process.versions.node.split(".")[0], 10);
record("node", Number.isInteger(nodeMajor) && nodeMajor >= 22, `Node ${process.version}`, nodeMajor >= 22 ? null : "Node.js 22+ is required");
record("public-surface", PUBLIC_TOOL_NAMES.length === 21, `${PUBLIC_SURFACE_VERSION}; ${PUBLIC_TOOL_NAMES.length} tools`);

for (const spec of ["@modelcontextprotocol/node", "@modelcontextprotocol/server", "zod"]) {
  try {
    const resolved = require.resolve(spec);
    const local = isWithin(projectRoot, resolved) && resolved.toLowerCase().includes(`${path.sep}node_modules${path.sep}`.toLowerCase());
    record(`dependency:${spec}`, local, local ? "resolved from Codexless node_modules" : "resolved outside Codexless", local ? null : "Run npm ci in the Codexless install directory");
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
    versionAccepted ? null : `This Technical Preview has accepted these Codex CLI builds only: ${ACCEPTED_CODEX_VERSIONS.join(", ")}. Re-validation is required before using another CLI build.`
  );
} catch (error) {
  record("codex-executable", false, "Codex executable resolution failed", error instanceof Error ? error.message : String(error));
}

if (codexResolution?.path && codexProbe?.ok) {
  const stderrCapture = [];
  const client = new CodexAppServerClient({
    cwd: runtimeCwd,
    launch: () => ({
      command: codexResolution.path,
      args: ["app-server", "--stdio"],
      options: { cwd: runtimeCwd },
    }),
    requestTimeoutMs: 20_000,
    initializeCapabilities: { experimentalApi: true },
    stderrHandler: (chunk) => captureBounded(stderrCapture, String(chunk)),
    clientInfo: {
      name: "codexless_doctor",
      title: "Codexless Doctor",
      version: packageJson.version,
    },
  });
  try {
    const initialized = await client.start();
    appServer = {
      ok: true,
      serverName: initialized?.serverInfo?.name ?? null,
      serverVersion: initialized?.serverInfo?.version ?? null,
    };
    record("codex-app-server", true, "initialize succeeded");

    if (requestedCwd) {
      try {
        const authority = new CodexAuthorityExecutor({
          codexBin: codexResolution.path,
          defaultCwd: requestedCwd,
          acceptedCodexVersions: ACCEPTED_CODEX_VERSIONS,
        });
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
        record("project-authority", true, `Codexless authority resolver accepted ${redactHomePath(requestedCwd)} as ${resolved.permissionProfile}`);
      } catch (error) {
        projectContext = { ok: false, error: sanitizeText(error instanceof Error ? error.message : String(error)) };
        warnings.push({ kind: "project-authority", message: projectContext.error });
      }
    }

    try {
      const skillsResult = await client.request("skills/list", { cwds: [runtimeCwd], forceReload: false });
      const skills = (skillsResult?.data ?? []).flatMap((row) => row?.skills ?? []);
      const chromeSkill = skills.find((skill) => skill?.name === "chrome:control-chrome" && skill?.enabled !== false);
      const mcp = await client.request("mcpServerStatus/list", { detail: "toolsAndAuthOnly", limit: 100 });
      const rows = Array.isArray(mcp?.data) ? mcp.data : [];
      const codexApps = rows.find((server) => server?.name === "codex_apps");
      const appTools = codexApps?.tools && typeof codexApps.tools === "object" ? Object.values(codexApps.tools) : [];
      const browserTools = appTools.map((tool) => tool?.name).filter((name) => typeof name === "string" && name.startsWith("browser."));
      const repl = rows.find((server) => server?.name === "node_repl");
      const replTools = repl?.tools && typeof repl.tools === "object" ? Object.values(repl.tools).map((tool) => tool?.name).filter(Boolean) : [];
      browser = chromeSkill?.path && browserTools.length
        ? { status: "available", skill: "chrome:control-chrome", toolCount: browserTools.length }
        : { status: "unavailable", reason: !chromeSkill?.path ? "chrome_skill_unavailable" : "browser_tools_unavailable", toolCount: browserTools.length };
      nodeRepl = replTools.includes("js")
        ? { status: "available", toolCount: replTools.length }
        : { status: "unavailable", reason: repl?.error ? "node_repl_error" : "node_repl_js_unavailable", toolCount: replTools.length };
      if (browser.status !== "available" || nodeRepl.status !== "available") {
        warnings.push({ kind: "browser-reader", message: "Browser Reader prerequisites are not fully available. Core Codexless can still be usable; Browser Reader is conditional." });
      }
    } catch (error) {
      browser = { status: "unknown", reason: "probe_failed" };
      nodeRepl = { status: "unknown", reason: "probe_failed" };
      warnings.push({ kind: "browser-reader", message: sanitizeText(error instanceof Error ? error.message : String(error)) });
    }
  } catch (error) {
    appServer = { ok: false, error: sanitizeText(error instanceof Error ? error.message : String(error)) };
    record("codex-app-server", false, "initialize failed", appServer.error);
  } finally {
    await client.close().catch(() => {});
    const stderrWarnings = classifyStderr(stderrCapture.join(""));
    warnings.push(...stderrWarnings);
  }
}

notes.push("Browser Reader is conditional; unavailable Browser/Node REPL prerequisites do not make the Codexless core install invalid.");
notes.push("Permission fields have different meanings: permissionCeiling is the locally authorized maximum for an operation, while permissionProfile is the profile actually used. Read-only operations downscope; explicit write operations may inherit the local Codex ceiling. Remote callers cannot select a stronger profile.");
notes.push("codex.project_context reports a fresh Codex bootstrap projection for its cwd; per-operation authority is resolved separately. Doctor --cwd uses the same Codexless authority resolver as project execution rather than treating the bootstrap projection as a global permission result.");
notes.push("Tunnel connectivity is intentionally not changed or provisioned by doctor. Verify the release-candidate tunnel separately after local install/doctor passes.");
notes.push("Doctor does not start a Codex model turn.");

const failedCoreChecks = checks.filter((check) => check.required && !check.ok);
const status = failedCoreChecks.length ? "error" : warnings.length || (requestedCwd && !projectContext?.ok) ? "partial" : "ok";
const result = {
  status,
  codexless: {
    packageVersion: packageJson.version,
    serverVersion: PUBLIC_SERVER_VERSION,
    surfaceVersion: PUBLIC_SURFACE_VERSION,
    publicToolCount: PUBLIC_TOOL_NAMES.length,
    installRoot: redactHomePath(projectRoot),
  },
  host: {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
  },
  codex: {
    resolutionSource: codexResolution?.source ?? null,
    executable: codexResolution?.path ? redactHomePath(codexResolution.path) : null,
    version: codexProbe?.versionText ?? null,
    appServer,
  },
  project: requestedCwd ? projectContext ?? { ok: false, error: "project context was not checked" } : { status: "not_requested" },
  capabilities: {
    browserReader: browser,
    nodeRepl,
    tunnel: { status: "not_checked", reason: "separate_release_boundary" },
  },
  checks,
  warnings: dedupeWarnings(warnings),
  notes,
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

function isWithin(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function captureBounded(chunks, chunk) {
  chunks.push(chunk);
  let total = chunks.reduce((sum, value) => sum + value.length, 0);
  while (total > 32_768 && chunks.length > 1) total -= chunks.shift().length;
}

function classifyStderr(stderr) {
  const out = [];
  const seen = new Set();
  for (const raw of String(stderr ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean)) {
    const line = sanitizeText(raw)
      .replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\s+/, "")
      .slice(0, 1000);
    if (!line || seen.has(line)) continue;
    seen.add(line);
    out.push({ kind: /mcp|transport|http\/request failed/i.test(line) ? "configured-mcp" : "codex-app-server-stderr", message: line });
    if (out.length >= 20) break;
  }
  return out;
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

function printHuman(result) {
  const mark = (ok) => ok ? "PASS" : "FAIL";
  process.stdout.write(`Codexless doctor: ${result.status.toUpperCase()}\n`);
  process.stdout.write(`Version ${result.codexless.packageVersion} | ${result.codexless.surfaceVersion} | ${result.codexless.publicToolCount} public tools\n\n`);
  for (const check of result.checks) {
    process.stdout.write(`[${mark(check.ok)}] ${check.name}: ${check.detail}\n`);
    if (!check.ok && check.action) process.stdout.write(`       -> ${check.action}\n`);
  }
  process.stdout.write(`\nBrowser Reader: ${result.capabilities.browserReader.status}\n`);
  process.stdout.write(`Tunnel: ${result.capabilities.tunnel.status} (verified separately)\n`);
  if (result.project.status !== "not_requested") {
    process.stdout.write(`Project authority: ${result.project.ok ? "ok" : "needs attention"}\n`);
    if (result.project.ok) {
      process.stdout.write(`  actual profile: ${result.project.permissionProfile}\n`);
      process.stdout.write(`  local ceiling: ${result.project.permissionCeiling}\n`);
      process.stdout.write(`  authority source: ${result.project.authoritySource}\n`);
    }
  }
  if (result.warnings.length) {
    process.stdout.write("\nWarnings:\n");
    for (const warning of result.warnings) process.stdout.write(`- ${warning.kind}: ${warning.message}\n`);
  }
  process.stdout.write("\nNo Codex model turn was started.\n");
}
