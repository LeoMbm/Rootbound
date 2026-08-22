import path from "node:path";
import process from "node:process";
import { ACCEPTED_CODEX_VERSIONS, CodexAuthorityExecutor } from "./codex-authority-executor.mjs";
import { probeCodexExecutable, resolveCodexExecutable } from "./codex-bin.mjs";

export function parseCodexVersion(text) {
  return String(text ?? "").match(/codex-cli\s+([^\s]+)/i)?.[1] ?? null;
}

export function canCapabilityProbeUnknownCodex({ platform = process.platform, arch = process.arch } = {}) {
  return platform === "darwin" && arch === "arm64";
}

export async function resolveCompatibleCodexRuntime({
  env = process.env,
  cwd,
  profileOverride = null,
  configOverrides = [],
  acceptedVersions = ACCEPTED_CODEX_VERSIONS,
  maxTimeoutMs = 30_000,
  outputBytesCap = 64 * 1024,
} = {}) {
  if (typeof cwd !== "string" || !cwd.trim()) throw new Error("Codex compatibility verification requires cwd");
  if (!Array.isArray(configOverrides)) throw new Error("configOverrides must be an array");

  const effectiveCwd = path.resolve(cwd);
  const resolution = await resolveCodexExecutable({ env, acceptedVersions: null });
  const probe = await probeCodexExecutable(resolution.path, { cwd: effectiveCwd });
  const version = parseCodexVersion(probe.versionText);
  if (!probe.ok || !version) {
    throw new Error(`Unable to probe Codex executable compatibility: ${probe.versionText ?? probe.error ?? "unknown version"}`);
  }

  const known = acceptedVersions.includes(version);
  if (!known && !canCapabilityProbeUnknownCodex()) {
    throw new Error(
      `unsupported Codex CLI version for Rootbound direct-profile authority: ${version}. ` +
      `Accepted versions: ${acceptedVersions.join(", ")}. ` +
      "Automatic capability verification for unknown builds is currently limited to Apple Silicon macOS."
    );
  }

  const processAcceptedVersions = known
    ? [...acceptedVersions]
    : [...new Set([...acceptedVersions, version])];

  const executor = new CodexAuthorityExecutor({
    codexBin: resolution.path,
    defaultCwd: effectiveCwd,
    profileOverride,
    configOverrides,
    acceptedCodexVersions: processAcceptedVersions,
    maxTimeoutMs,
    watchdogGraceMs: 5_000,
    outputBytesCap,
  });

  const validation = await executor.validate();
  const authority = await executor.resolveAuthority({ cwd: effectiveCwd, access: "readOnly", timeoutMs: 10_000 });
  if (authority.permissionProfile !== ":read-only") {
    throw new Error(`Codex compatibility probe expected :read-only downscope, got ${String(authority.permissionProfile)}`);
  }
  if (path.resolve(authority.trustedAncestor ?? "") !== effectiveCwd) {
    throw new Error(`Codex compatibility probe expected exact trusted root ${effectiveCwd}, got ${authority.trustedAncestor ?? "none"}`);
  }

  if (!known) {
    const marker = `rootbound-codex-compat-${process.pid}`;
    const command = await executor.exec({
      command: [process.execPath, "-e", `process.stdout.write(${JSON.stringify(marker)})`],
      cwd: effectiveCwd,
      access: "readOnly",
      timeoutMs: 10_000,
    });
    if (command.exitCode !== 0 || command.stdout !== marker) {
      throw new Error(`Codex compatibility command/exec probe failed: exit=${command.exitCode} stdout=${JSON.stringify(command.stdout)} stderr=${JSON.stringify(command.stderr)}`);
    }
  }

  return {
    resolution: { ...resolution, version },
    version,
    knownAcceptedVersion: known,
    acceptanceSource: known ? "built-in-version-policy" : "runtime-capability-probe",
    acceptedVersions: processAcceptedVersions,
    executor,
    validation,
    authority,
    modelTurnStarted: false,
  };
}
