import { realpath, readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveCodexlessPaths } from "../src/state-paths.mjs";
import { runtimeStatus, stopRuntime } from "../src/runtime-state.mjs";

const args = parseArgs(process.argv.slice(2));
const currentRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const paths = resolveCodexlessPaths();
const sourceRoot = await validateReleaseSource(args.from);
const sourcePackage = JSON.parse(await readFile(path.join(sourceRoot, "package.json"), "utf8"));
const currentPackage = JSON.parse(await readFile(path.join(currentRoot, "package.json"), "utf8"));
const legacyRootLayout = samePath(currentRoot, paths.root);
const installTarget = legacyRootLayout ? paths.appDir : currentRoot;

const runtime = await runtimeStatus(paths);
if (runtime.running || runtime.stale) {
  const stopped = await stopRuntime(paths);
  if (!new Set(["stopped", "not_running"]).has(stopped.status)) {
    throw new Error(`Unable to stop Codexless runtime before upgrade: ${stopped.status}`);
  }
}

const installer = installerCommand({ sourceRoot, installTarget, json: true });
const result = await run(installer.command, installer.args, { cwd: sourceRoot });
if (result.exitCode !== 0) {
  const detail = result.stdout.trim() || result.stderr.trim() || `exit ${result.exitCode}`;
  throw new Error(`Codexless staged upgrade failed: ${detail}`);
}

let installerResult = null;
try { installerResult = JSON.parse(result.stdout.trim()); } catch {}
if (!installerResult?.ok) {
  throw new Error(`Codexless staged upgrade returned an invalid result: ${result.stdout.trim() || result.stderr.trim()}`);
}

const output = {
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
    ? ["A legacy install rooted at the Codexless state directory was detected. The new app was installed under the dedicated app/ child so state is not replaced.", "The old root-level preview files are intentionally left untouched by this migration; use the new app/bin/codexless entry after upgrade."]
    : ["The installer used staged activation with backup/rollback semantics.", "Codexless state lives outside the app install tree and was preserved."],
};

if (args.json) process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
else {
  process.stdout.write(`Codexless upgraded: ${output.fromVersion} -> ${output.toVersion}\n`);
  process.stdout.write(`App: ${output.installRoot}\nState preserved: ${output.stateRoot}\n`);
  if (legacyRootLayout) process.stdout.write("Legacy layout migrated to app/ without deleting root-level preview files.\n");
}

async function validateReleaseSource(value) {
  if (!value) throw new Error("upgrade requires --from <release-directory>");
  const root = await realpath(path.resolve(value));
  const info = await stat(root);
  if (!info.isDirectory()) throw new Error(`upgrade source is not a directory: ${root}`);
  const packagePath = path.join(root, "package.json");
  const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
  if (packageJson?.name !== "codexless") throw new Error(`upgrade source package is not codexless: ${packagePath}`);
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
  throw new Error(`Codexless upgrade is unsupported on ${process.platform}/${process.arch}`);
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
