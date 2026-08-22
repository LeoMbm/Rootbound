#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import { resolveCompatibleCodexRuntime } from "../src/codex-compatibility.mjs";
import { CodexPublicContextExecutor } from "../src/public-context-executor.mjs";
import { ROOTBOUND_PERMISSION_PROFILE, withRootboundPermissionOverrides } from "../src/rootbound-permission-profile.mjs";

const args = parseArgs(process.argv.slice(2));
const cwd = path.resolve(args.cwd ?? process.cwd());
const result = { ok: false, cwd, codex: null, checks: [] };
let publicContext = null;

try {
  const configOverrides = withRootboundPermissionOverrides([], { profileOverride: ROOTBOUND_PERMISSION_PROFILE });
  const compatible = await resolveCompatibleCodexRuntime({
    cwd,
    profileOverride: ROOTBOUND_PERMISSION_PROFILE,
    configOverrides,
    maxTimeoutMs: 30_000,
    outputBytesCap: 64 * 1024,
  });

  result.codex = {
    path: compatible.resolution.path,
    source: compatible.resolution.source,
    version: compatible.version,
    acceptanceSource: compatible.acceptanceSource,
  };
  pass("codex-executable", `${compatible.version} via ${compatible.resolution.source}`);
  pass("authority-validate", `allowed profiles: ${(compatible.validation.allowedProfiles ?? []).join(", ")}`);
  pass("authority-readonly", `${compatible.authority.permissionProfile}; source=${compatible.authority.authoritySource}`);
  pass("command-exec-permission-profile", "model-free read-only command succeeded");

  publicContext = new CodexPublicContextExecutor({ codexBin: compatible.resolution.path, defaultCwd: cwd, configOverrides });
  await publicContext.start();
  const project = await publicContext.projectContext({ cwd });
  if (project.modelTurnStarted !== false) throw new Error("project context unexpectedly started a model turn");
  pass("thread-start-readonly", `activePermissionProfile=${formatProfile(project.activePermissionProfile)}`);

  try {
    const quota = await publicContext.quotaSnapshot();
    pass("rate-limits-read", `codex availability=${quota?.codex?.availability ?? "unknown"}`);
  } catch (error) {
    warn("rate-limits-read", `non-gating account/quota probe failed: ${message(error)}`);
  }

  result.ok = true;
} catch (error) {
  fail("compatibility", message(error));
  result.error = message(error);
} finally {
  await publicContext?.close().catch(() => {});
}

if (args.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
else {
  process.stdout.write(`Rootbound Codex compatibility probe: ${result.ok ? "PASS" : "FAIL"}\n`);
  if (result.codex) process.stdout.write(`Codex: ${result.codex.version} (${result.codex.source}; ${result.codex.acceptanceSource})\n`);
  for (const check of result.checks) process.stdout.write(`${check.status.toUpperCase()} ${check.name}: ${check.detail}\n`);
  if (result.error) process.stdout.write(`Error: ${result.error}\n`);
}
process.exitCode = result.ok ? 0 : 1;

function pass(name, detail) { result.checks.push({ name, status: "pass", detail }); }
function warn(name, detail) { result.checks.push({ name, status: "warn", detail }); }
function fail(name, detail) { result.checks.push({ name, status: "fail", detail }); }
function message(error) { return error instanceof Error ? error.message : String(error); }
function formatProfile(value) { return typeof value === "string" ? value : value?.id ?? "null"; }
function parseArgs(argv) {
  const out = { cwd: null, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--cwd") {
      const value = argv[++i];
      if (!value) throw new Error("--cwd requires a path");
      out.cwd = value;
    } else if (arg === "--json") out.json = true;
    else if (arg === "--help" || arg === "-h") {
      process.stdout.write("Usage: node scripts/probe-codex-compat.mjs [--cwd <project>] [--json]\n");
      process.exit(0);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  return out;
}
