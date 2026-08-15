import { constants as fsConstants } from "node:fs";
import { access, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const WINDOWS_NATIVE_EXTENSIONS = new Set([".exe", ".com"]);
const WINDOWS_SHIM_EXTENSIONS = new Set([".cmd", ".bat", ".ps1"]);

export class CodexExecutableResolutionError extends Error {
  constructor(message, { checked = [] } = {}) {
    super(message);
    this.name = "CodexExecutableResolutionError";
    this.code = "CODEX_EXECUTABLE_NOT_FOUND";
    this.checked = checked;
  }
}

export async function resolveCodexExecutable({ env = process.env, acceptedVersions = null } = {}) {
  if (process.platform !== "win32") {
    const checked = [];
    const explicit = env.CODEX_BIN?.trim();
    if (explicit) {
      checked.push("CODEX_BIN");
      const resolved = await normalizeAcceptedPosixCandidate(explicit, { source: "CODEX_BIN", checked, acceptedVersions });
      if (resolved) return resolved;
      throw new CodexExecutableResolutionError(
        "CODEX_BIN exists but does not resolve to an executable accepted Codex build.",
        { checked }
      );
    }

    if (process.platform === "darwin") {
      const bundledCandidates = [
        { path: "/Applications/ChatGPT.app/Contents/Resources/codex", source: "chatgpt-app-bundled", label: "ChatGPT.app:bundled-codex" },
      ];
      for (const candidate of bundledCandidates) {
        checked.push(candidate.label);
        const resolved = await normalizeAcceptedPosixCandidate(candidate.path, { source: candidate.source, checked, acceptedVersions });
        if (resolved) return resolved;
      }
    }

    const found = whichFirst("codex");
    if (found) {
      checked.push("PATH:codex");
      const resolved = await normalizeAcceptedPosixCandidate(found, { source: "PATH", checked, acceptedVersions });
      if (resolved) return resolved;
    }
    const acceptedHint = Array.isArray(acceptedVersions) && acceptedVersions.length
      ? ` No discovered executable matched the currently accepted Codex CLI builds: ${acceptedVersions.join(", ")}.`
      : "";
    throw new CodexExecutableResolutionError(
      `An executable accepted Codex build could not be resolved.${acceptedHint} Set CODEX_BIN when auto-detection cannot resolve it.`,
      { checked }
    );
  }

  const checked = [];
  const explicit = env.CODEX_BIN?.trim();
  if (explicit) {
    checked.push("CODEX_BIN");
    const resolved = await normalizeAcceptedWindowsCandidate(explicit, { source: "CODEX_BIN", checked, acceptedVersions });
    if (resolved) return resolved;
    throw new CodexExecutableResolutionError(
      "CODEX_BIN exists but does not resolve to a directly launchable accepted native Codex executable. Point CODEX_BIN at an accepted codex.exe rather than an npm .cmd/.ps1 shim.",
      { checked }
    );
  }

  const desktopCliPath = env.CODEX_CLI_PATH?.trim();
  if (desktopCliPath) {
    checked.push("CODEX_CLI_PATH");
    const resolved = await normalizeAcceptedWindowsCandidate(desktopCliPath, { source: "CODEX_CLI_PATH", checked, acceptedVersions });
    if (resolved) return resolved;
  }

  for (const candidate of windowsDesktopCandidates(env)) {
    checked.push(candidate.label);
    const resolved = await normalizeAcceptedWindowsCandidate(candidate.path, { source: candidate.source, checked, acceptedVersions });
    if (resolved) return resolved;
  }

  for (const candidate of whereAll("codex.exe")) {
    checked.push("PATH:codex.exe");
    const resolved = await normalizeAcceptedWindowsCandidate(candidate, { source: "PATH", checked, acceptedVersions });
    if (resolved) return resolved;
  }

  for (const candidate of whereAll("codex")) {
    checked.push(`PATH:${path.extname(candidate).toLowerCase() || "bare"}`);
    const resolved = await normalizeAcceptedWindowsCandidate(candidate, { source: "PATH", checked, acceptedVersions });
    if (resolved) return resolved;
  }

  const appData = env.APPDATA?.trim();
  if (appData) {
    const npmPackageRoot = path.join(appData, "npm", "node_modules", "@openai", "codex");
    checked.push("APPDATA:npm-package");
    const native = await findNativeCodexUnderPackage(npmPackageRoot);
    if (native) {
      const resolved = await normalizeAcceptedWindowsCandidate(native, { source: "npm-global-package", checked, acceptedVersions });
      if (resolved) return resolved;
    }
  }

  const acceptedHint = Array.isArray(acceptedVersions) && acceptedVersions.length
    ? ` No discovered executable matched the currently accepted Codex CLI builds: ${acceptedVersions.join(", ")}.`
    : "";
  throw new CodexExecutableResolutionError(
    `A directly launchable accepted Codex executable could not be resolved.${acceptedHint} Codexless supports accepted Codex Desktop/runtime executables, native codex.exe on PATH, or npm-installed Codex with its native Windows package present. Set CODEX_BIN to a native codex.exe when auto-detection cannot resolve it.`,
    { checked }
  );
}

export async function probeCodexExecutable(target, { cwd = process.cwd(), timeoutMs = 10_000 } = {}) {
  await assertAccessible(target, "Codex executable");
  const result = spawnSync(target, ["--version"], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024,
  });
  const text = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  return {
    ok: result.status === 0 && Boolean(text),
    status: result.status,
    versionText: text || null,
    error: result.error?.message ?? null,
  };
}

export function redactHomePath(value) {
  if (typeof value !== "string" || !value) return value ?? null;
  const home = os.homedir();
  if (!home) return value;
  const normalizedValue = path.resolve(value);
  const normalizedHome = path.resolve(home);
  const comparableValue = process.platform === "win32" ? normalizedValue.toLowerCase() : normalizedValue;
  const comparableHome = process.platform === "win32" ? normalizedHome.toLowerCase() : normalizedHome;
  const homeToken = process.platform === "win32" ? "%USERPROFILE%" : "$HOME";
  if (comparableValue === comparableHome) return homeToken;
  if (comparableValue.startsWith(`${comparableHome}${path.sep}`)) return `${homeToken}${normalizedValue.slice(normalizedHome.length)}`;
  return normalizedValue;
}

async function normalizeAcceptedPosixCandidate(candidate, { source, checked, acceptedVersions }) {
  if (typeof candidate !== "string" || !candidate.trim()) return null;
  const resolved = path.resolve(candidate.trim());
  if (!(await isExecutable(resolved))) return null;
  if (!Array.isArray(acceptedVersions) || !acceptedVersions.length) return { path: resolved, source };
  const probe = await probeCodexExecutable(resolved).catch(() => null);
  const version = parseCodexVersion(probe?.versionText);
  if (probe?.ok && version && acceptedVersions.includes(version)) return { path: resolved, source, version };
  checked.push(`${source}:unsupported:${version ?? "unknown"}`);
  return null;
}

async function normalizeAcceptedWindowsCandidate(candidate, { source, checked, acceptedVersions }) {
  const normalized = await normalizeWindowsCandidate(candidate, { source, checked });
  if (!normalized || !Array.isArray(acceptedVersions) || !acceptedVersions.length) return normalized;
  const probe = await probeCodexExecutable(normalized.path).catch(() => null);
  const version = parseCodexVersion(probe?.versionText);
  if (probe?.ok && version && acceptedVersions.includes(version)) return { ...normalized, version };
  checked.push(`${source}:unsupported:${version ?? "unknown"}`);
  return null;
}

async function normalizeWindowsCandidate(candidate, { source, checked }) {
  if (typeof candidate !== "string" || !candidate.trim()) return null;
  const resolved = path.resolve(candidate.trim());
  if (!(await isAccessible(resolved))) return null;
  const extension = path.extname(resolved).toLowerCase();
  if (WINDOWS_NATIVE_EXTENSIONS.has(extension)) return { path: resolved, source };

  if (WINDOWS_SHIM_EXTENSIONS.has(extension) || !extension) {
    const packageRoot = inferNpmCodexPackageRoot(resolved);
    if (packageRoot) {
      checked.push("npm-shim:native-package");
      const native = await findNativeCodexUnderPackage(packageRoot);
      if (native) return { path: native, source: `${source}-npm-native` };
    }
  }
  return null;
}

function inferNpmCodexPackageRoot(candidate) {
  const directory = path.dirname(candidate);
  const basename = path.basename(candidate).toLowerCase();
  if (!["codex", "codex.cmd", "codex.ps1", "codex.bat"].includes(basename)) return null;
  return path.join(directory, "node_modules", "@openai", "codex");
}

async function findNativeCodexUnderPackage(packageRoot) {
  if (!(await isAccessible(packageRoot))) return null;
  const directCandidates = buildDirectNpmNativeCandidates(packageRoot);
  for (const candidate of directCandidates) {
    if (await isAccessible(candidate)) return path.resolve(candidate);
  }

  // Packaging layout has changed across Codex CLI releases. Restrict the fallback walk
  // to the @openai/codex package and return only vendor/.../codex.exe.
  try {
    const entries = await readdir(packageRoot, { recursive: true, withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || entry.name.toLowerCase() !== "codex.exe") continue;
      const parent = entry.parentPath ?? entry.path;
      const candidate = path.join(parent, entry.name);
      if (!candidate.toLowerCase().includes(`${path.sep}vendor${path.sep}`)) continue;
      return path.resolve(candidate);
    }
  } catch {
    return null;
  }
  return null;
}

function buildDirectNpmNativeCandidates(packageRoot) {
  const platformPackage = process.arch === "arm64" ? "codex-win32-arm64" : "codex-win32-x64";
  const triple = process.arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";
  const roots = [
    path.join(packageRoot, "node_modules", "@openai", platformPackage),
    path.join(path.dirname(packageRoot), platformPackage),
  ];
  const candidates = [];
  for (const root of roots) {
    candidates.push(
      path.join(root, "vendor", triple, "codex", "codex.exe"),
      path.join(root, "vendor", triple, "bin", "codex.exe"),
      path.join(root, "vendor", triple, "codex.exe")
    );
  }
  return candidates;
}

function windowsDesktopCandidates(env) {
  const rows = [];
  const localAppData = env.LOCALAPPDATA?.trim();
  const userProfile = env.USERPROFILE?.trim();
  if (localAppData) {
    rows.push(
      {
        path: path.join(localAppData, "Programs", "OpenAI", "Codex", "bin", "codex.exe"),
        source: "codex-desktop-programs",
        label: "LOCALAPPDATA:Programs/OpenAI/Codex",
      },
      {
        path: path.join(localAppData, "OpenAI", "Codex", "bin"),
        source: "codex-desktop-runtime-cache",
        label: "LOCALAPPDATA:OpenAI/Codex/bin",
        searchDirectory: true,
      }
    );
  }
  if (userProfile) {
    rows.push({
      path: path.join(userProfile, ".codex", "packages", "standalone", "current", "bin", "codex.exe"),
      source: "codex-standalone-current",
      label: "USERPROFILE:.codex/standalone/current",
    });
  }
  return rows.flatMap((row) => row.searchDirectory ? findDesktopRuntimeCandidatesSync(row) : [row]);
}

function findDesktopRuntimeCandidatesSync(row) {
  try {
    const { readdirSync, statSync } = requireNodeFs();
    if (!statSync(row.path).isDirectory()) return [];
    const children = readdirSync(row.path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(row.path, entry.name, "codex.exe"));
    const direct = path.join(row.path, "codex.exe");
    return [direct, ...children].map((candidate) => ({ path: candidate, source: row.source, label: row.label }));
  } catch {
    return [];
  }
}

function requireNodeFs() {
  // Kept as a tiny lazy CommonJS bridge so the normal resolver path does not need another top-level import.
  return process.getBuiltinModule("node:fs");
}

function parseCodexVersion(text) {
  const match = String(text ?? "").match(/codex-cli\s+([^\s]+)/i);
  return match?.[1] ?? null;
}

function whereAll(name) {
  const result = spawnSync("where.exe", [name], { encoding: "utf8", windowsHide: true, timeout: 3_000 });
  if (result.status !== 0) return [];
  return String(result.stdout ?? "").split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
}

function whichFirst(name) {
  const result = spawnSync("which", [name], { encoding: "utf8", timeout: 3_000 });
  if (result.status !== 0) return null;
  return String(result.stdout ?? "").split(/\r?\n/).map((value) => value.trim()).find(Boolean) ?? null;
}

async function assertAccessible(target, label) {
  try {
    await access(target);
  } catch {
    throw new CodexExecutableResolutionError(`${label} does not exist or is not accessible: ${target}`);
  }
}

async function isAccessible(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function isExecutable(target) {
  try {
    await access(target, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}
