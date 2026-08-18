import path from "node:path";
import process from "node:process";
import { ACCEPTED_CODEX_VERSIONS, CodexAuthorityExecutor } from "../src/codex-authority-executor.mjs";
import { resolveCodexExecutable } from "../src/codex-bin.mjs";
import { PUBLIC_SURFACE_VERSION, PUBLIC_TOOL_NAMES } from "../src/surface-contracts.mjs";

const args = parseArgs(process.argv.slice(2));
const cwd = path.resolve(args.cwd ?? process.cwd());
const checks = [];
let resolution = null;
let executor = null;
let authority = null;
let command = null;

try {
  resolution = await resolveCodexExecutable({ acceptedVersions: ACCEPTED_CODEX_VERSIONS });
  record("codex", true, resolution.version ?? "accepted Codex executable resolved");
} catch (error) {
  record("codex", false, error instanceof Error ? error.message : String(error));
}

if (resolution?.path) {
  try {
    executor = new CodexAuthorityExecutor({
      codexBin: resolution.path,
      defaultCwd: cwd,
      acceptedCodexVersions: ACCEPTED_CODEX_VERSIONS,
      maxTimeoutMs: 30_000,
      watchdogGraceMs: 5_000,
      outputBytesCap: 64 * 1024,
    });
    const validation = await executor.validate();
    record("app-server", true, `Codex ${validation.codexVersion}; App Server authority bootstrap succeeded`);
  } catch (error) {
    record("app-server", false, error instanceof Error ? error.message : String(error));
  }
}

if (executor && checks.at(-1)?.ok) {
  try {
    authority = await executor.resolveAuthority({ cwd, access: "readOnly", timeoutMs: 10_000 });
    record("authority", true, `${authority.permissionProfile} within ${authority.trustedAncestor ?? cwd}`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    record("authority", false, detail, error?.code, error?.nextActions);
  }
}

if (authority && executor) {
  try {
    const marker = `codexless-self-test-${process.pid}`;
    command = await executor.exec({
      command: [process.execPath, "-e", `process.stdout.write(${JSON.stringify(marker)})`],
      cwd,
      access: "readOnly",
      timeoutMs: 10_000,
    });
    const ok = command.exitCode === 0 && command.stdout === marker;
    record("command-exec", ok, ok ? `model-free command/exec returned expected marker; profile=${command.permissionProfile}` : `unexpected result exit=${command.exitCode} stdout=${JSON.stringify(command.stdout)} stderr=${JSON.stringify(command.stderr)}`);
  } catch (error) {
    record("command-exec", false, error instanceof Error ? error.message : String(error), error?.code, error?.nextActions);
  }
}

const ok = checks.every((check) => check.ok);
const result = {
  ok,
  status: ok ? "ok" : "error",
  cwd,
  surfaceVersion: PUBLIC_SURFACE_VERSION,
  publicToolCount: PUBLIC_TOOL_NAMES.length,
  modelLane: "chatgpt-only",
  modelTurnStarted: false,
  checks,
};

if (args.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
else {
  process.stdout.write(`Codexless self-test: ${ok ? "PASS" : "FAIL"}\n`);
  process.stdout.write(`${PUBLIC_SURFACE_VERSION} | ${PUBLIC_TOOL_NAMES.length} tools | model-free\n`);
  for (const check of checks) {
    process.stdout.write(`[${check.ok ? "PASS" : "FAIL"}] ${check.name}: ${check.detail}\n`);
    if (check.errorCode) process.stdout.write(`       code: ${check.errorCode}\n`);
    for (const action of check.nextActions ?? []) process.stdout.write(`       -> ${action}\n`);
  }
  process.stdout.write("No Codex model turn was started.\n");
}
process.exitCode = ok ? 0 : 1;

function record(name, okValue, detail, errorCode = null, nextActions = null) {
  const check = { name, ok: Boolean(okValue), detail: String(detail ?? "") };
  if (typeof errorCode === "string") check.errorCode = errorCode;
  if (Array.isArray(nextActions)) check.nextActions = nextActions.filter((value) => typeof value === "string");
  checks.push(check);
}

function parseArgs(argv) {
  const parsed = { cwd: null, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") parsed.json = true;
    else if (arg === "--cwd") {
      if (!argv[index + 1]) throw new Error("--cwd requires a path");
      parsed.cwd = argv[++index];
    } else if (arg === "-h" || arg === "--help") {
      process.stdout.write("Usage: node scripts/self-test.mjs [--cwd <project>] [--json]\n");
      process.exit(0);
    } else throw new Error(`Unknown self-test argument: ${arg}`);
  }
  return parsed;
}
