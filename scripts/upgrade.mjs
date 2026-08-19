import { realpath, readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveRootboundPaths } from "../src/state-paths.mjs";
import { runtimeStatus, stopRuntime } from "../src/runtime-state.mjs";

const args = parseArgs(process.argv.slice(2));

try {
  const output = await upgrade(args);
  if (args.json) process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  else {
    process.stdout.write(`Rootbound upgraded: ${output.fromVersion} -> ${output.toVersion}\n`);
    process.stdout.write(`App: ${output.installRoot}\nState preserved: ${output.stateRoot}\n`);
    if (output.legacyRootLayout) process.stdout.write("Legacy layout migrated to app/ without deleting root-level preview files.\n");
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (args.json) process.stdout.write(`${JSON.stringify({ ok: false, action: "upgrade-failed", error: message }, null, 2)}\n`);
  else process.stderr.write(`Rootbound upgrade failed: ${message}\n`);
  process.exitCode = 1;
}

async function upgrade(options) {
  const currentRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const paths = resolveRootboundPaths();
  const sourceRoot = await validateReleaseSource(options.from);
  if (samePath(currentRoot, sourceRoot)) {
    throw new Error("Refusing in-place self-upgrade: --from must point to a different Rootbound release directory than the currently running installation.");
  }
  const sourcePackage = JSON.parse(await readFile(path.join(sourceRoot, "package.json"), "utf8"));
  const currentPackage = JSON.parse(await readFile(path.join(currentRoot, "package.json"), "utf8"));
  const legacyRootLayout = samePath(currentRoot, paths.root);
  const installTarget = legacyRootLayout ? paths.appDir : currentRoot;

  const runtime = await runtimeStatus(paths);
  if (runtime.running || runtime.stale) {
    const stopped = await stopRuntime(paths);
    if (!new Set(["stopped", "not_running"]).has(stopped.status)) {
      throw new Error(`Unable to stop Rootbound runtime before upgrade: ${stopped.status}`);
    }
  }

  const installer = installerCommand({ sourceRoot, installTarget, json: true });
  const result = await run(installer.command, installer.args, { cwd: sourceRoot });
  const installerResult = parseLastJsonObject(result.stdout);
  if (result.exitCode !== 0 || !installerResult?.ok) {
    const detail = installerResult?.error ?? result.stderr.trim() ?? result.stdout.trim() ?? `exit ${result.exitCode}`;
    throw new Error(`Rootbound staged upgrade failed: ${detail}`);
  }

  return {
    ok: true,
    action: legacyRootLayout ? "upgraded-and-migrated-layout" : "upgraded",
    fromVersion: currentPackage.version,
    toVersion: sourcePackage.version,
    sourceRoot,
    previousInstallRoot: currentRoot,
    installRoot: installTarget,
    stateRoot: paths.root,
    statePreserved: true,
    legacyRootLayout,
    installer: installerResult,
    notes: legacyRootLayout
      ? [
          "A legacy install rooted at the Rootbound state directory was detected. The new app was installed under the dedicated app/ child so state is not replaced.",
          "The old root-level preview files are intentionally left untouched by this migration; use the new app/bin/rootbound entry after upgrade.",
        ]
      : ["The installer used staged activation with backup/rollback semantics.", "Rootbound state lives outside the app install tree and was preserved."],
  };
}

async function validateReleaseSource(value) {
  if (!value) throw new Error("upgrade requires --from <release-directory>");
  const root = await realpath(path.resolve(value));
  const info = await stat(root);
  if (!info.isDirectory()) throw new Error(`upgrade source is not a directory: ${root}`);
  const packagePath = path.join(root, "package.json");
  const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
  if (packageJson?.name !== "rootbound") throw new Error(`upgrade source package is not rootbound: ${packagePath}`);
  const installerPath = process.platform === "win32" ? path.join(root, "scripts", "install.ps1") : path.join(root, "scripts", "install.sh");
  const installerInfo = await stat(installerPath);
  if (!installerInfo.isFile()) throw new Error(`upgrade source is missing installer: ${installerPath}`);
  return root;
}

function installerCommand({ sourceRoot, installTarget, json }) {
  if (process.platform === "win32") {
    return {
      command: "powershell.exe",
      args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(sourceRoot, "scripts", "install.ps1"), "-InstallDir", installTarget, ...(json ? ["-Json"] : [])],
    };
  }
  if (process.platform === "darwin" && process.arch === "arm64") {
    return { command: "sh", args: [path.join(sourceRoot, "scripts", "install.sh"), "--install-dir", installTarget, ...(json ? ["--json"] : [])] };
  }
  throw new Error(`Rootbound upgrade is unsupported on ${process.platform}/${process.arch}`);
}

async function run(command, argv, { cwd }) {
  const child = spawn(command, argv, { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, shell: false });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8"); child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8"); child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exitCode = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (code) => resolve(code ?? 1)); });
  return { exitCode, stdout, stderr };
}

function parseLastJsonObject(text) {
  const lines = String(text ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const value = JSON.parse(lines[index]);
      if (value && typeof value === "object") return value;
    } catch {}
  }
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return null;
  try { return JSON.parse(trimmed); } catch { return null; }
}

function parseArgs(argv) {
  const parsed = { from: null, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") parsed.json = true;
    else if (arg === "--from") {
      if (!argv[index + 1]) throw new Error("--from requires a directory");
      parsed.from = argv[++index];
    } else if (!arg.startsWith("-") && !parsed.from) parsed.from = arg;
    else if (arg === "-h" || arg === "--help") {
      process.stdout.write("Usage: node scripts/upgrade.mjs --from <release-directory> [--json]\n");
      process.exit(0);
    } else throw new Error(`Unknown upgrade argument: ${arg}`);
  }
  return parsed;
}

function samePath(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}
