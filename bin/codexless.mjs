#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { openStateStore } from "../src/state-store.mjs";
import { registerProject, resolveProjectRoot } from "../src/project-registry.mjs";
import { resolveCodexlessPaths } from "../src/state-paths.mjs";
import { runtimeStatus, stopRuntime, tailLog } from "../src/runtime-state.mjs";
import { ensureExactProjectTrust, resolveCodexConfigPath, rollbackTrustConfig } from "../src/trust-config.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const command = args.shift() ?? "help";
const options = parseOptions(args);
const paths = resolveCodexlessPaths();

try {
  switch (command) {
    case "connect": await connectCommand(options); break;
    case "status": await statusCommand(options); break;
    case "doctor": await doctorCommand(options); break;
    case "logs": await logsCommand(options); break;
    case "stop": await stopCommand(options); break;
    case "help": case "--help": case "-h": printHelp(); break;
    case "version": case "--version": case "-v": await versionCommand(); break;
    default: throw new CliUsageError(`Unknown command: ${command}`);
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (options.json) process.stdout.write(`${JSON.stringify({ ok: false, error: message })}\n`);
  else process.stderr.write(`Codexless: ${message}\n`);
  process.exitCode = error instanceof CliUsageError ? 2 : 1;
}

async function connectCommand(opts) {
  const input = opts.positionals[0] ?? ".";
  const resolved = await resolveProjectRoot(input);
  const configPath = resolveCodexConfigPath();
  if (!opts.yes) await confirmTrust(resolved.root, configPath);
  const trust = await ensureExactProjectTrust(resolved.root, { configPath, backupsDir: paths.backupsDir });
  let doctor;
  try {
    doctor = await runDoctor(resolved.root);
    if (doctor.exitCode !== 0 || doctor.value?.status === "error" || doctor.value?.project?.ok !== true) {
      const detail = doctor.value?.project?.error ?? doctor.stderr.trim() ?? `doctor status=${doctor.value?.status ?? "unknown"}`;
      throw new Error(`Project validation failed after trust update: ${detail}`);
    }
  } catch (error) {
    if (trust.changed) await rollbackTrustConfig(trust).catch(() => {});
    throw error;
  }

  const store = await openStateStore({ paths });
  try {
    const project = await registerProject(store, resolved.root, { trusted: true });
    const result = {
      ok: true,
      action: "connected",
      project,
      trust: { changed: trust.changed, configPath: trust.configPath, backupPath: trust.backupPath },
      doctor: { status: doctor.value.status, permissionProfile: doctor.value.project.permissionProfile ?? null },
    };
    printResult(result, opts);
  } finally { store.close(); }
}

async function statusCommand(opts) {
  const store = await openStateStore({ paths });
  try {
    const runtime = await runtimeStatus(paths);
    let projects;
    if (opts.positionals[0]) {
      const resolved = await resolveProjectRoot(opts.positionals[0]);
      projects = store.listProjects().filter((row) => row.root === resolved.root);
    } else projects = store.listProjects();
    printResult({ ok: true, runtime, projects, stateRoot: paths.root }, opts);
  } finally { store.close(); }
}

async function doctorCommand(opts) {
  const cwd = opts.positionals[0] ?? null;
  const result = await runDoctor(cwd);
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(result.value ?? { status: "error", stderr: result.stderr }, null, 2)}\n`);
  } else {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  }
  if (result.exitCode !== 0) process.exitCode = result.exitCode;
}

async function logsCommand(opts) {
  const maxBytes = opts.bytes ? parseInteger(opts.bytes, "--bytes", 1, 1024 * 1024) : 64 * 1024;
  const text = await tailLog(paths.logPath, { maxBytes });
  if (opts.json) printResult({ ok: true, logPath: paths.logPath, text }, opts);
  else if (text) process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
  if (opts.follow) await followLog(paths.logPath);
}

async function stopCommand(opts) {
  const result = await stopRuntime(paths, { force: opts.force });
  printResult({ ok: result.status === "stopped", ...result }, opts);
  if (result.status === "stopping") process.exitCode = 1;
}

async function versionCommand() {
  const pkg = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
  process.stdout.write(`${pkg.version}\n`);
}

async function confirmTrust(root, configPath) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new CliUsageError(`connect requires explicit approval in non-interactive mode; retry with --yes to trust exact root ${root}`);
  }
  process.stdout.write(`Codexless will trust exactly this project root in Codex config:\n  ${root}\nConfig: ${configPath}\nA backup is created before mutation.\n`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question('Type "yes" to continue: ')).trim().toLowerCase();
    if (answer !== "yes") throw new CliUsageError("connect cancelled; trust was not changed");
  } finally { rl.close(); }
}

async function runDoctor(cwd = null) {
  const argv = [path.join(packageRoot, "scripts", "doctor.mjs"), "--json"];
  if (cwd) argv.push("--cwd", cwd);
  const child = spawn(process.execPath, argv, { cwd: packageRoot, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8"); child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8"); child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exitCode = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (code) => resolve(code ?? 1)); });
  let value = null;
  try { value = stdout.trim() ? JSON.parse(stdout) : null; } catch {}
  return { exitCode, stdout, stderr, value };
}

async function followLog(logPath) {
  let offset = 0;
  try { offset = (await (await import("node:fs/promises")).stat(logPath)).size; } catch {}
  const { watch } = await import("node:fs");
  await new Promise((resolve, reject) => {
    const watcher = watch(path.dirname(logPath), async (event, filename) => {
      if (filename && filename.toString() !== path.basename(logPath)) return;
      try {
        const { open, stat } = await import("node:fs/promises");
        const info = await stat(logPath);
        if (info.size < offset) offset = 0;
        if (info.size === offset) return;
        const handle = await open(logPath, "r");
        try {
          const buffer = Buffer.alloc(info.size - offset);
          await handle.read(buffer, 0, buffer.length, offset);
          offset = info.size;
          process.stdout.write(buffer);
        } finally { await handle.close(); }
      } catch (error) { if (error?.code !== "ENOENT") reject(error); }
    });
    const stop = () => { watcher.close(); resolve(); };
    process.once("SIGINT", stop); process.once("SIGTERM", stop);
    watcher.once("error", reject);
  });
}

function parseOptions(argv) {
  const out = { positionals: [], json: false, yes: false, follow: false, force: false, bytes: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") out.json = true;
    else if (arg === "--yes" || arg === "-y") out.yes = true;
    else if (arg === "--follow" || arg === "-f") out.follow = true;
    else if (arg === "--force") out.force = true;
    else if (arg === "--bytes") { if (!argv[i + 1]) throw new CliUsageError("--bytes requires a value"); out.bytes = argv[++i]; }
    else if (arg.startsWith("-")) throw new CliUsageError(`Unknown option: ${arg}`);
    else out.positionals.push(arg);
  }
  return out;
}

function parseInteger(value, label, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || String(parsed) !== String(value) || parsed < min || parsed > max) throw new CliUsageError(`${label} must be an integer between ${min} and ${max}`);
  return parsed;
}

function printResult(value, opts) {
  if (opts.json) process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  else if (value.action === "connected") {
    process.stdout.write(`Connected ${value.project.name}\nProject: ${value.project.root}\nRef: ${value.project.projectRef}\nTrust: ${value.trust.changed ? "added exact-root trust" : "already trusted"}\n`);
  } else if (Array.isArray(value.projects)) {
    process.stdout.write(`Runtime: ${value.runtime.status}\nState: ${value.stateRoot}\nProjects: ${value.projects.length}\n`);
    for (const project of value.projects) process.stdout.write(`- ${project.projectRef}  ${project.root}${project.trusted ? "  trusted" : ""}\n`);
  } else process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function printHelp() {
  process.stdout.write(`Codexless V5 control plane\n\nUsage:\n  codexless connect [path] [--yes] [--json]\n  codexless status [path] [--json]\n  codexless doctor [path] [--json]\n  codexless logs [--bytes N] [--follow] [--json]\n  codexless stop [--force] [--json]\n  codexless version\n\nconnect never widens trust silently: interactive approval or --yes is required.\n`);
}

class CliUsageError extends Error {}
