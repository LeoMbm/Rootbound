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
import { resolveTunnelLaunch, tunnelConfigStatus } from "../src/tunnel-config.mjs";
import {
  discoverTunnelCandidates,
  probeTunnelClient,
  rollbackManagedTunnelSetup,
  TUNNEL_SETUP_URLS,
  validateManagedTunnel,
  validateRuntimeKey,
  validateTunnelId,
  writeManagedTunnelSetup,
} from "../src/tunnel-bootstrap.mjs";
import { ensureExactProjectTrust, resolveCodexConfigPath, rollbackTrustConfig } from "../src/trust-config.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const command = args.shift() ?? "help";
const options = parseOptions(args);
const paths = resolveCodexlessPaths();

try {
  switch (command) {
    case "connect": await connectCommand(options); break;
    case "start": await startCommand(options); break;
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
  if (options.json) process.stdout.write(`${JSON.stringify({ ok: false, error: message, ...(error?.code ? { errorCode: error.code } : {}) })}\n`);
  else process.stderr.write(`Codexless: ${message}\n`);
  process.exitCode = error instanceof CliUsageError ? 2 : 1;
}

async function connectCommand(opts) {
  const input = opts.positionals[0] ?? ".";
  const resolved = await resolveProjectRoot(input);
  const configPath = resolveCodexConfigPath();
  const tunnel = opts.noStart ? { configured: false, skipped: true, reason: "no-start" } : await ensureTunnelReadyForConnect(opts, resolved.root);

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
      tunnel,
    };
    if (!opts.noStart) result.runtime = await startSupervisor(project);
    printResult(result, opts);
  } finally { store.close(); }
}

async function ensureTunnelReadyForConnect(opts, projectRoot) {
  const current = tunnelConfigStatus({ paths });
  if (current.configured) {
    resolveTunnelLaunch({ packageRoot, projectRoot, paths });
    setupLine(opts, "✓ Tunnel configuration already available");
    return { configured: true, source: current.source ?? "existing", reused: true };
  }

  const interactive = !opts.json && !opts.yes && process.stdin.isTTY && process.stdout.isTTY;
  setupLine(opts, "\nCodexless setup");
  setupLine(opts, "Checking ChatGPT tunnel prerequisites...");
  await probeTunnelClient({ cwd: packageRoot });
  setupLine(opts, "✓ tunnel-client detected");

  const candidates = await discoverTunnelCandidates();
  const tunnelId = await chooseTunnelId({ candidates, interactive, opts });
  const apiKey = await resolveRuntimeKey({ interactive, opts });

  let managed;
  try {
    managed = await writeManagedTunnelSetup({ tunnelId, apiKey, packageRoot, paths });
    setupLine(opts, "Validating tunnel configuration...");
    await validateManagedTunnel({ profilePath: managed.profilePath, cwd: packageRoot });
  } catch (error) {
    await rollbackManagedTunnelSetup({ paths }).catch(() => {});
    throw error;
  }

  setupLine(opts, `✓ Tunnel ready (${tunnelId})`);
  return { configured: true, source: "guided", reused: false, tunnelId };
}

async function chooseTunnelId({ candidates, interactive, opts }) {
  const envCandidate = candidates.find((candidate) => candidate.source === "environment");
  if (envCandidate) {
    setupLine(opts, `✓ Tunnel detected from environment (${envCandidate.id})`);
    return envCandidate.id;
  }

  if (candidates.length === 1) {
    const candidate = candidates[0];
    if (!interactive || await askYesNo(`Existing OpenAI tunnel found: ${candidate.id}\nUse this tunnel? [Y/n] `, true)) {
      setupLine(opts, `✓ Reusing ${candidate.id}`);
      return candidate.id;
    }
    return askForTunnelId();
  }

  if (candidates.length > 1) {
    if (!interactive) {
      throw new CliUsageError("Multiple OpenAI tunnels were detected. Run `codexless connect .` interactively once, or set CONTROL_PLANE_TUNNEL_ID for non-interactive setup.");
    }
    process.stdout.write("OpenAI tunnels found:\n");
    candidates.forEach((candidate, index) => process.stdout.write(`  ${index + 1}. ${candidate.id} (${candidate.source})\n`));
    const answer = (await askQuestion(`Choose a tunnel [1-${candidates.length}, default 1]: `)).trim();
    const index = answer === "" ? 0 : Number.parseInt(answer, 10) - 1;
    if (!Number.isInteger(index) || index < 0 || index >= candidates.length) throw new CliUsageError("Invalid tunnel selection.");
    return candidates[index].id;
  }

  if (!interactive) {
    throw new CliUsageError(`No OpenAI tunnel id was detected. Run connect interactively once, or set CONTROL_PLANE_TUNNEL_ID. Tunnels: ${TUNNEL_SETUP_URLS.tunnels}`);
  }
  return askForTunnelId();
}

async function askForTunnelId() {
  process.stdout.write(`No existing OpenAI tunnel was detected.\nCreate or inspect one here:\n  ${TUNNEL_SETUP_URLS.tunnels}\n`);
  const tunnelId = (await askQuestion("Paste tunnel ID: ")).trim();
  if (!validateTunnelId(tunnelId)) throw new CliUsageError("Invalid tunnel ID; expected tunnel_ followed by 32 lowercase letters/digits.");
  return tunnelId;
}

async function resolveRuntimeKey({ interactive, opts }) {
  for (const name of ["CONTROL_PLANE_API_KEY", "OPENAI_API_KEY"]) {
    const value = process.env[name];
    if (typeof value === "string" && value.length) {
      if (!validateRuntimeKey(value)) throw new CliUsageError(`${name} is set but does not have a valid runtime-key format.`);
      setupLine(opts, `✓ Runtime API key detected (${name})`);
      return value;
    }
  }

  if (!interactive) {
    throw new CliUsageError(`No tunnel runtime API key was detected. Run connect interactively once, or set CONTROL_PLANE_API_KEY. Runtime keys: ${TUNNEL_SETUP_URLS.runtimeKeys}`);
  }
  process.stdout.write(`A Tunnel runtime API key is required once.\nCreate or inspect it here:\n  ${TUNNEL_SETUP_URLS.runtimeKeys}\n`);
  const value = await askSecret("Paste runtime API key (input hidden): ");
  if (!validateRuntimeKey(value)) throw new CliUsageError("Invalid runtime API key format.");
  return value;
}

async function startCommand(opts) {
  const store = await openStateStore({ paths });
  try {
    let project = null;
    if (opts.positionals[0]) {
      const resolved = await resolveProjectRoot(opts.positionals[0]);
      project = store.getProjectByRoot(resolved.root);
    } else {
      const projects = store.listProjects();
      if (projects.length === 1) project = projects[0];
      else if (projects.length > 1) throw new CliUsageError("start requires a project path when multiple projects are registered");
    }
    if (!project) throw new CliUsageError("No registered project found; run codexless connect <path> first");
    if (!project.trusted) throw new Error(`Project is not marked trusted: ${project.root}`);
    try { resolveTunnelLaunch({ packageRoot, projectRoot: project.root, paths }); }
    catch (error) {
      if (error?.code === "TUNNEL_NOT_CONFIGURED") throw new CliUsageError("Tunnel setup is incomplete. Run `codexless connect .` interactively once to finish the guided setup.");
      throw error;
    }
    const runtime = await startSupervisor(project);
    printResult({ ok: true, action: "started", project, runtime }, opts);
  } finally { store.close(); }
}

async function startSupervisor(project) {
  const current = await runtimeStatus(paths);
  if (current.running) {
    if (current.state?.projectRef && current.state.projectRef !== project.projectRef) {
      throw new Error(`Codexless runtime is already connected to ${current.state.projectRef}; stop it before switching projects`);
    }
    return current;
  }
  if (current.stale) await stopRuntime(paths);
  const child = spawn(process.execPath, [path.join(packageRoot, "scripts", "supervisor.mjs")], {
    cwd: packageRoot,
    env: { ...process.env, CODEXLESS_PROJECT_REF: project.projectRef, CODEXLESS_PROJECT_ROOT: project.root },
    detached: true,
    windowsHide: true,
    stdio: "ignore",
  });
  let exited = null;
  child.once("exit", (code, signal) => { exited = { code, signal }; });
  child.unref();
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const runtime = await runtimeStatus(paths);
    if (runtime.running && runtime.state?.projectRef === project.projectRef) return runtime;
    if (exited) {
      const detail = (await tailLog(paths.logPath, { maxBytes: 8192 })).trim();
      throw new Error(`Codexless supervisor exited during startup (code=${exited.code} signal=${exited.signal})${detail ? `: ${detail}` : ""}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Codexless supervisor did not become ready within 5 seconds; inspect codexless logs");
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
  process.stdout.write(`\nProject access\nCodexless needs explicit Codex trust for exactly:\n  ${root}\nConfig: ${configPath}\nA backup is created before mutation.\n`);
  if (!await askYesNo("Allow this exact project root? [Y/n] ", true)) throw new CliUsageError("connect cancelled; trust was not changed");
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

async function askQuestion(prompt) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try { return await rl.question(prompt); }
  finally { rl.close(); }
}

async function askYesNo(prompt, defaultYes = false) {
  const answer = (await askQuestion(prompt)).trim().toLowerCase();
  if (answer === "") return defaultYes;
  if (answer === "y" || answer === "yes") return true;
  if (answer === "n" || answer === "no") return false;
  throw new CliUsageError("Expected yes or no.");
}

async function askSecret(prompt) {
  if (!process.stdin.isTTY || !process.stdout.isTTY || typeof process.stdin.setRawMode !== "function") {
    throw new CliUsageError("Secret input requires an interactive terminal; set CONTROL_PLANE_API_KEY and retry for non-interactive setup.");
  }
  process.stdout.write(prompt);
  const input = process.stdin;
  const wasRaw = Boolean(input.isRaw);
  input.setRawMode(true);
  input.resume();
  input.setEncoding("utf8");
  return await new Promise((resolve, reject) => {
    let value = "";
    let done = false;
    const cleanup = () => {
      input.off("data", onData);
      try { input.setRawMode(wasRaw); } catch {}
      if (!wasRaw) input.pause();
    };
    const finish = (fn, result) => {
      if (done) return;
      done = true;
      cleanup();
      process.stdout.write("\n");
      fn(result);
    };
    const onData = (chunk) => {
      for (const ch of String(chunk)) {
        if (ch === "\u0003") { finish(reject, new CliUsageError("setup cancelled")); return; }
        if (ch === "\r" || ch === "\n") { finish(resolve, value); return; }
        if (ch === "\u007f" || ch === "\b") { value = value.slice(0, -1); continue; }
        if (ch >= " ") value += ch;
      }
    };
    input.on("data", onData);
  });
}

function setupLine(opts, text) {
  if (!opts.json) process.stdout.write(`${text}\n`);
}

function parseOptions(argv) {
  const out = { positionals: [], json: false, yes: false, follow: false, force: false, noStart: false, bytes: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") out.json = true;
    else if (arg === "--yes" || arg === "-y") out.yes = true;
    else if (arg === "--follow" || arg === "-f") out.follow = true;
    else if (arg === "--force") out.force = true;
    else if (arg === "--no-start") out.noStart = true;
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
    process.stdout.write(`\nCodexless is ready.\nProject: ${value.project.root}\nRef: ${value.project.projectRef}\nTrust: ${value.trust.changed ? "added exact-root trust" : "already trusted"}\nTunnel: ${value.tunnel?.configured ? (value.tunnel.reused ? "reused" : "configured") : "not started"}\nRuntime: ${value.runtime?.status ?? "not started"}\n`);
    if (value.runtime?.status === "running") process.stdout.write(`ChatGPT connector settings: ${TUNNEL_SETUP_URLS.connectors}\n`);
  } else if (Array.isArray(value.projects)) {
    process.stdout.write(`Runtime: ${value.runtime.status}\nState: ${value.stateRoot}\nProjects: ${value.projects.length}\n`);
    for (const project of value.projects) process.stdout.write(`- ${project.projectRef}  ${project.root}${project.trusted ? "  trusted" : ""}\n`);
  } else process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function printHelp() {
  process.stdout.write(`Codexless V5 control plane\n\nUsage:\n  codexless connect [path] [--yes] [--no-start] [--json]\n  codexless start [path] [--json]\n  codexless status [path] [--json]\n  codexless doctor [path] [--json]\n  codexless logs [--bytes N] [--follow] [--json]\n  codexless stop [--force] [--json]\n  codexless version\n\nFor normal setup, run only: codexless connect .\nThe interactive wizard detects/reuses an OpenAI tunnel, securely stores the runtime key in private local state when needed, validates the tunnel, asks for exact-root Codex trust, and starts the supervised runtime.\nUse codexless tunnel ... only for advanced/manual tunnel configuration.\n`);
}

class CliUsageError extends Error {}
