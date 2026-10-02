import { constants as fsConstants } from "node:fs";
import { access, realpath } from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
let defaultResolutionPromise = null;

export function resolveGitExecutable() {
  if (!defaultResolutionPromise) {
    defaultResolutionPromise = resolveGitExecutableUncached().catch((error) => {
      defaultResolutionPromise = null;
      throw error;
    });
  }
  return defaultResolutionPromise;
}

export async function resolveGitExecutableUncached({
  platform = process.platform,
  env = process.env,
  accessFn = access,
  realpathFn = realpath,
  execFileFn = execFileAsync,
} = {}) {
  const override = cleanString(env.ROOTBOUND_GIT_BIN);
  if (override) {
    const resolved = await executablePath(override, { accessFn, realpathFn });
    if (!resolved) throw new Error(`ROOTBOUND_GIT_BIN is not executable: ${override}`);
    return resolved;
  }

  if (platform !== "darwin") return "git";

  const pathGit = await firstNonSystemPathGit(env.PATH, { accessFn, realpathFn });
  if (pathGit) return pathGit;

  const candidates = [];
  const developerDir = cleanString(env.DEVELOPER_DIR);
  if (developerDir) candidates.push(path.join(developerDir, "usr", "bin", "git"));

  try {
    const selected = await execFileFn("/usr/bin/xcode-select", ["-p"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 2_000,
      maxBuffer: 64 * 1024,
    });
    const selectedDir = cleanString(selected?.stdout);
    if (selectedDir) candidates.push(path.join(selectedDir, "usr", "bin", "git"));
  } catch {}

  candidates.push(
    "/Library/Developer/CommandLineTools/usr/bin/git",
    "/Applications/Xcode.app/Contents/Developer/usr/bin/git"
  );

  for (const candidate of unique(candidates)) {
    const resolved = await executablePath(candidate, { accessFn, realpathFn });
    if (resolved) return resolved;
  }
  return "git";
}

async function firstNonSystemPathGit(pathValue, { accessFn, realpathFn }) {
  if (typeof pathValue !== "string" || !pathValue.trim()) return null;
  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, "git");
    const resolved = await executablePath(candidate, { accessFn, realpathFn });
    if (!resolved || resolved === "/usr/bin/git") continue;
    return resolved;
  }
  return null;
}

async function executablePath(candidate, { accessFn, realpathFn }) {
  try {
    await accessFn(candidate, fsConstants.X_OK);
    return await realpathFn(candidate);
  } catch {
    return null;
  }
}

function cleanString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}
