import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { CodexAppServerClient } from "./codex-app-server-client.mjs";
import { assertNoNestedCodexInvocation } from "./public-command-policy.mjs";
import { assertRemoteModelFreeMethod } from "./toolbox-method-registry.mjs";
import { ToolwirePermissionError } from "./codex-permission-executor.mjs";

const execFileAsync = promisify(execFile);
const SUPPORTED_ACCESS = new Set(["inherit", "readOnly"]);
const WINDOWS_ACCEPTED_CODEX_VERSIONS = Object.freeze(["0.147.0", "0.147.0-alpha.6.6"]);
const MAC_ACCEPTED_CODEX_VERSIONS = Object.freeze(["0.148.0-alpha.15", "0.148.0-alpha.9"]);
export function acceptedCodexVersionsFor({ platform = process.platform, arch = process.arch } = {}) {
  if (platform === "win32") return WINDOWS_ACCEPTED_CODEX_VERSIONS;
  if (platform === "darwin" && arch === "arm64") return MAC_ACCEPTED_CODEX_VERSIONS;
  return Object.freeze([]);
}
export const ACCEPTED_CODEX_VERSIONS = acceptedCodexVersionsFor();
const MAC_NULL_PROFILE_COMPAT_VERSIONS = new Set(["0.148.0-alpha.15", "0.148.0-alpha.9"]);
const KNOWN_SANDBOX_FIELDS = Object.freeze({
  readOnly: new Set(["type", "networkAccess"]),
  workspaceWrite: new Set(["type", "networkAccess", "writableRoots", "excludeTmpdirEnvVar", "excludeSlashTmp"]),
});
const WINDOWS_LAUNCHABLE_EXTENSIONS = new Set([".exe", ".com", ".cmd", ".bat"]);
const WINDOWS_INVALID_BASENAME = /[<>:"/\\|?*\u0000-\u001F]/;
const WINDOWS_RESERVED_BASENAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export function isSafeWindowsBareExecutableName(value) {
  if (typeof value !== "string" || !value || value === "." || value === "..") return false;
  if (WINDOWS_INVALID_BASENAME.test(value) || /[ .]$/.test(value)) return false;
  return !WINDOWS_RESERVED_BASENAME.test(value);
}

async function resolveWindowsExecutable(command) {
  if (process.platform !== "win32") return { command, executableResolution: null };
  const requested = command[0];
  if (!requested || path.isAbsolute(requested) || requested.includes("\\") || requested.includes("/") || path.extname(requested)) return { command, executableResolution: null };
  if (!isSafeWindowsBareExecutableName(requested)) return { command, executableResolution: null };
  try {
    const { stdout } = await execFileAsync("where.exe", [requested], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 3_000,
      maxBuffer: 64 * 1024,
    });
    const resolved = String(stdout ?? "")
      .split(/\r?\n/)
      .map((value) => value.trim())
      .find((value) => value && WINDOWS_LAUNCHABLE_EXTENSIONS.has(path.extname(value).toLowerCase()));
    if (!resolved) return { command, executableResolution: null };
    return { command: [resolved, ...command.slice(1)], executableResolution: { requested, resolved, source: "windows-where" } };
  } catch {
    return { command, executableResolution: null };
  }
}

function normalizeConfigPath(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.replaceAll("/", "\\").toLowerCase() : resolved;
}

function isPathWithin(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function permissionProfileId(value) {
  return typeof value === "string" ? value : value?.id;
}

function getMcpServers(config) {
  return config?.mcpServers ?? config?.mcp_servers ?? {};
}

function hasCustomPermissionConfiguration(config) {
  const configuredProfiles = config?.permissions;
  const defaultPermissions = config?.default_permissions ?? config?.defaultPermissions ?? null;
  const hasNamedProfiles = Boolean(configuredProfiles && typeof configuredProfiles === "object" && Object.keys(configuredProfiles).length);
  const hasNonBuiltinDefault = defaultPermissions !== null && ![":read-only", ":workspace"].includes(defaultPermissions);
  return hasNamedProfiles || hasNonBuiltinDefault;
}

function inferBuiltinProfileFromProjection({ started, authorityRoot, allowedProfiles, codexVersion, effectiveConfig }) {
  if (!MAC_NULL_PROFILE_COMPAT_VERSIONS.has(codexVersion)) return null;
  if (process.platform !== "darwin" || process.arch !== "arm64") return null;
  if (hasCustomPermissionConfiguration(effectiveConfig)) {
    throw new Error("authority resolver failed closed: custom permission configuration cannot be inferred from a null activePermissionProfile");
  }
  if (started?.approvalPolicy !== "on-request" || started?.approvalsReviewer !== "user") {
    throw new Error("authority resolver failed closed: 0.148 Mac null-profile projection has an unaccepted approval contract");
  }
  const runtimeWorkspaceRoots = started?.runtimeWorkspaceRoots;
  const sandbox = started?.sandbox;
  if (!Array.isArray(runtimeWorkspaceRoots) || !sandbox?.type) {
    throw new Error("authority resolver failed closed: 0.148 Mac null-profile projection omitted runtimeWorkspaceRoots or sandbox");
  }
  if (!runtimeWorkspaceRoots.some((root) => normalizeConfigPath(root) === normalizeConfigPath(authorityRoot))) {
    throw new Error("authority resolver failed closed: trusted authority root is absent from Codex runtimeWorkspaceRoots");
  }
  const knownFields = KNOWN_SANDBOX_FIELDS[sandbox.type];
  if (!knownFields) throw new Error(`authority resolver failed closed: unsupported null-profile sandbox type: ${String(sandbox.type)}`);
  const unknownFields = Object.keys(sandbox).filter((field) => !knownFields.has(field));
  if (unknownFields.length) {
    throw new Error(`authority resolver failed closed: null-profile sandbox contains unaccepted fields: ${unknownFields.join(", ")}`);
  }
  const profileId = sandbox.type === "readOnly" ? ":read-only" : ":workspace";
  if (!allowedProfiles.has(profileId)) throw new Error(`authority resolver failed closed: inferred profile is not allowed by Codex: ${profileId}`);
  return {
    profileId,
    source: "codex-mac-null-profile-projection-downscope",
  };
}

function buildQuietSessionConfig(config) {
  const disabledMcpServers = Object.fromEntries(Object.keys(getMcpServers(config)).map((name) => [name, { enabled: false }]));
  return { features: { plugins: false, apps: false }, mcp_servers: disabledMcpServers };
}

function findTrustedAncestor(config, cwd) {
  const target = normalizeConfigPath(cwd);
  const projects = config?.projects ?? {};
  let best = null;
  for (const [rawRoot, entry] of Object.entries(projects)) {
    const trustLevel = entry?.trust_level ?? entry?.trustLevel ?? null;
    if (trustLevel !== "trusted") continue;
    const normalizedRoot = normalizeConfigPath(rawRoot);
    const withinRoot = isPathWithin(normalizedRoot, target);
    if (!withinRoot) continue;
    if (!best || normalizedRoot.length > best.normalizedRoot.length) best = { root: path.resolve(rawRoot), normalizedRoot, trustLevel };
  }
  return best;
}

function truncateUtf8(text, byteCap) {
  const value = typeof text === "string" ? text : String(text ?? "");
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= byteCap) return { text: value, truncated: false };
  return { text: bytes.subarray(0, byteCap).toString("utf8"), truncated: true };
}

function assertNoModelOrRuntimeSideEffects(client) {
  const methods = client.notificationMethods;
  if (methods.some((method) => method.startsWith("turn/") || method === "thread/tokenUsage/updated")) {
    throw new Error("authority resolver failed closed: a model turn/token-usage event appeared during model-free resolution");
  }
  if (methods.includes("mcpServer/startupStatus/updated")) {
    throw new Error("authority resolver failed closed: an MCP runtime initialized during quiet permission resolution");
  }
}

export class CodexAuthorityExecutor {
  #codexBin;
  #defaultCwd;
  #profileOverride;
  #configOverrides;
  #maxTimeoutMs;
  #watchdogGraceMs;
  #outputBytesCap;
  #acceptedCodexVersions;
  #codexVersion = null;

  constructor({
    codexBin,
    defaultCwd = null,
    profileOverride = null,
    configOverrides = [],
    maxTimeoutMs = 30_000,
    watchdogGraceMs = 5_000,
    outputBytesCap = 32_768,
    acceptedCodexVersions = ACCEPTED_CODEX_VERSIONS,
  }) {
    if (!codexBin) throw new Error("CodexAuthorityExecutor requires codexBin");
    if (defaultCwd !== null && (typeof defaultCwd !== "string" || !defaultCwd.trim())) throw new Error("defaultCwd must be a non-empty string when provided");
    if (profileOverride !== null && (typeof profileOverride !== "string" || !profileOverride.trim())) throw new Error("profileOverride must be a non-empty string when provided");
    if (!Array.isArray(configOverrides) || !configOverrides.every((value) => typeof value === "string" && value.trim())) throw new Error("configOverrides must be an array of non-empty Codex -c key=value strings");
    if (!Number.isInteger(maxTimeoutMs) || maxTimeoutMs <= 0) throw new Error("maxTimeoutMs must be a positive integer");
    if (!Number.isInteger(outputBytesCap) || outputBytesCap <= 0) throw new Error("outputBytesCap must be a positive integer");
    if (!Array.isArray(acceptedCodexVersions) || !acceptedCodexVersions.length || !acceptedCodexVersions.every((value) => typeof value === "string" && value)) throw new Error("acceptedCodexVersions must be a non-empty string array");

    this.#codexBin = codexBin;
    this.#defaultCwd = defaultCwd ? path.resolve(defaultCwd) : null;
    this.#profileOverride = profileOverride;
    this.#configOverrides = [...configOverrides];
    this.#maxTimeoutMs = maxTimeoutMs;
    this.#watchdogGraceMs = watchdogGraceMs;
    this.#outputBytesCap = outputBytesCap;
    this.#acceptedCodexVersions = new Set(acceptedCodexVersions);
  }

  get codexVersion() { return this.#codexVersion; }
  get defaultCwd() { return this.#defaultCwd; }
  get profileOverride() { return this.#profileOverride; }

  async validate() {
    if (this.#defaultCwd) this.#defaultCwd = await this.#validateCwd(this.#defaultCwd);
    const { stdout } = await execFileAsync(this.#codexBin, ["--version"], {
      cwd: this.#defaultCwd ?? process.cwd(),
      windowsHide: true,
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });
    const match = String(stdout).match(/codex-cli\s+([^\s]+)/i);
    if (!match) throw new Error(`unable to parse Codex CLI version from: ${String(stdout).trim()}`);
    this.#codexVersion = match[1];
    if (!this.#acceptedCodexVersions.has(this.#codexVersion)) {
      throw new Error(
        `unsupported Codex CLI version for Rootbound direct-profile authority: ${this.#codexVersion}. ` +
        `Accepted versions: ${[...this.#acceptedCodexVersions].join(", ")}. ` +
        "This path depends on the experimental command/exec.permissionProfile capability and must be re-accepted before upgrade."
      );
    }

    if (!this.#defaultCwd) {
      return { codexVersion: this.#codexVersion, defaultCwd: null, profileOverride: this.#profileOverride, configOverrides: [...this.#configOverrides] };
    }

    const client = this.#newClient(this.#defaultCwd, 15_000);
    await client.start();
    try {
      const configRead = await client.request("config/read", { cwd: this.#defaultCwd, includeLayers: false });
      const config = configRead?.config;
      if (!config || typeof config !== "object") throw new Error("Codex config/read did not return an effective config object");
      const profiles = await this.#listAllowedProfiles(client, this.#defaultCwd);
      if (this.#profileOverride && !profiles.has(this.#profileOverride)) throw new Error(`host profile override is not allowed by Codex for ${this.#defaultCwd}: ${this.#profileOverride}`);
      return {
        codexVersion: this.#codexVersion,
        defaultCwd: this.#defaultCwd,
        profileOverride: this.#profileOverride,
        configOverrides: [...this.#configOverrides],
        trustedAncestor: findTrustedAncestor(config, this.#defaultCwd)?.root ?? null,
        allowedProfiles: [...profiles],
      };
    } finally {
      await client.close();
    }
  }

  async resolveAuthority({ cwd = null, access = "inherit", timeoutMs = 10_000 } = {}) {
    if (!SUPPORTED_ACCESS.has(access)) throw new Error(`unsupported access mode: ${access}`);
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > this.#maxTimeoutMs) throw new Error(`timeoutMs must be an integer between 1 and ${this.#maxTimeoutMs}`);
    if (!this.#codexVersion) throw new Error("CodexAuthorityExecutor.validate() must succeed before resolveAuthority()");
    const requestedCwd = cwd ?? this.#defaultCwd;
    if (!requestedCwd) throw new Error("cwd is required when no local default cwd is configured");
    const effectiveCwd = await this.#validateCwd(requestedCwd);
    const client = this.#newClient(effectiveCwd, timeoutMs + this.#watchdogGraceMs);
    await client.start();
    try { return await this.#resolveAuthorityWithClient(client, effectiveCwd, access, timeoutMs); }
    finally { await client.close(); }
  }

  async exec({ command, cwd = null, access = "inherit", timeoutMs = 10_000 }) {
    if (!Array.isArray(command) || command.length === 0 || !command.every((item) => typeof item === "string")) throw new Error("command must be a non-empty argv string array");
    if (!SUPPORTED_ACCESS.has(access)) throw new Error(`unsupported access mode: ${access}`);
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > this.#maxTimeoutMs) throw new Error(`timeoutMs must be an integer between 1 and ${this.#maxTimeoutMs}`);
    if (!this.#codexVersion) throw new Error("CodexAuthorityExecutor.validate() must succeed before exec()");

    assertRemoteModelFreeMethod("command/exec");
    assertNoNestedCodexInvocation(command, { codexBin: this.#codexBin });
    const requestedCwd = cwd ?? this.#defaultCwd;
    if (!requestedCwd) throw new Error("cwd is required when no local default cwd is configured");
    const effectiveCwd = await this.#validateCwd(requestedCwd);
    const executable = await resolveWindowsExecutable(command);
    const client = this.#newClient(effectiveCwd, timeoutMs + this.#watchdogGraceMs);
    await client.start();
    try {
      const resolvedAuthority = await this.#resolveAuthorityWithClient(client, effectiveCwd, access, timeoutMs);
      const result = await client.exec(
        { command: executable.command, cwd: effectiveCwd, permissionProfile: resolvedAuthority.permissionProfile, timeoutMs },
        { timeoutMs: timeoutMs + this.#watchdogGraceMs }
      );
      assertNoModelOrRuntimeSideEffects(client);
      const stdout = truncateUtf8(result.stdout, this.#outputBytesCap);
      const stderr = truncateUtf8(result.stderr, this.#outputBytesCap);
      return {
        ...result,
        stdout: stdout.text,
        stderr: stderr.text,
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
        access,
        effectiveCwd,
        permissionProfile: resolvedAuthority.permissionProfile,
        permissionCeiling: resolvedAuthority.permissionCeiling,
        authoritySource: resolvedAuthority.authoritySource,
        trustedAncestor: resolvedAuthority.trustedAncestor,
        executableResolution: executable.executableResolution,
        notificationMethods: client.notificationMethods,
        serverRequestMethods: client.serverRequestMethods,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/CreateProcessWithLogonW failed:\s*267|helper_unknown_error|setup refresh had errors/i.test(message)) {
        throw new Error(
          `Codex Windows sandbox could not execute in cwd ${effectiveCwd}. ` +
          "Mapped/virtual drives such as Google Drive remain an upstream Codex compatibility case that requires the separate Codex approval/external-execution lane. " +
          `Original error: ${message}`
        );
      }
      throw error;
    } finally {
      await client.close();
    }
  }

  async #resolveAuthorityWithClient(client, effectiveCwd, access, timeoutMs) {
    const configRead = await client.request("config/read", { cwd: effectiveCwd, includeLayers: false });
    const effectiveConfig = configRead?.config;
    if (!effectiveConfig || typeof effectiveConfig !== "object") throw new Error("authority resolver failed closed: Codex config/read returned no effective config");

    const allowedProfiles = await this.#listAllowedProfiles(client, effectiveCwd);
    const trusted = findTrustedAncestor(effectiveConfig, effectiveCwd);
    if (this.#profileOverride && !trusted) {
      throw new ToolwirePermissionError(
        `Codex has no explicitly trusted project/root covering cwd ${effectiveCwd}; a host profile override may select permissions only inside an already authorized root.`,
        {
          code: "PERMISSION_APPROVAL_REQUIRED",
          nextActions: [
            "Explicitly trust/authorize the target path in Codex or local Rootbound policy, then retry.",
            "Use a cwd already covered by an explicitly trusted Codex project/root.",
          ],
        }
      );
    }
    const authority = this.#profileOverride
      ? { profileId: this.#profileOverride, source: "host-profile-override", trustedAncestor: trusted.root }
      : await this.#resolveCodexProfile(client, effectiveConfig, effectiveCwd, timeoutMs);

    if (!allowedProfiles.has(authority.profileId)) throw new Error(`authority resolver returned a Codex profile that is not currently allowed: ${authority.profileId}`);
    const permissionProfile = access === "readOnly" ? ":read-only" : authority.profileId;
    if (!allowedProfiles.has(permissionProfile)) throw new Error(`requested Rootbound downscope is not available in Codex: ${permissionProfile}`);

    return {
      effectiveCwd,
      permissionProfile,
      permissionCeiling: authority.profileId,
      authoritySource: authority.source,
      trustedAncestor: authority.trustedAncestor,
    };
  }

  async #resolveCodexProfile(client, effectiveConfig, cwd, timeoutMs) {
    const trusted = findTrustedAncestor(effectiveConfig, cwd);
    if (!trusted) {
      throw new ToolwirePermissionError(
        `Codex has no explicitly trusted project/root covering cwd ${cwd}; Rootbound will not create trust as a side effect of permission resolution.`,
        {
          code: "PERMISSION_APPROVAL_REQUIRED",
          nextActions: [
            "Explicitly trust/authorize the target path in Codex or local Rootbound policy, then retry.",
            "Use a cwd already covered by an explicitly trusted Codex project/root.",
          ],
        }
      );
    }

    const authorityRoot = await this.#validateCwd(trusted.root);
    let resolverConfig = effectiveConfig;
    if (normalizeConfigPath(authorityRoot) !== normalizeConfigPath(cwd)) {
      const rootConfigRead = await client.request("config/read", { cwd: authorityRoot, includeLayers: false });
      resolverConfig = rootConfigRead?.config;
      if (!resolverConfig || typeof resolverConfig !== "object") throw new Error("authority resolver failed closed: Codex config/read returned no config for the trusted authority root");
    }

    const started = await client.request(
      "thread/start",
      { cwd: authorityRoot, ephemeral: true, config: buildQuietSessionConfig(resolverConfig) },
      { timeoutMs: Math.min(timeoutMs + this.#watchdogGraceMs, 15_000) }
    );
    const profileId = permissionProfileId(started?.activePermissionProfile);
    assertNoModelOrRuntimeSideEffects(client);
    if (!profileId) {
      const allowedProfiles = await this.#listAllowedProfiles(client, authorityRoot);
      const inferred = inferBuiltinProfileFromProjection({
        started,
        authorityRoot,
        allowedProfiles,
        codexVersion: this.#codexVersion,
        effectiveConfig: resolverConfig,
      });
      if (inferred) return { ...inferred, trustedAncestor: trusted.root };
    }
    if (typeof profileId !== "string" || !profileId) throw new Error("authority resolver capability gate failed: Codex did not return activePermissionProfile.id");
    return { profileId, source: "codex-quiet-profile-resolver", trustedAncestor: trusted.root };
  }

  async #listAllowedProfiles(client, cwd) {
    const listed = await client.request("permissionProfile/list", { cwd });
    const rows = Array.isArray(listed?.data) ? listed.data : [];
    const allowed = rows.filter((row) => row?.allowed === true && typeof row?.id === "string").map((row) => row.id);
    if (!allowed.length) throw new Error("Codex permissionProfile/list returned no allowed profiles");
    return new Set(allowed);
  }

  #newClient(cwd, requestTimeoutMs) {
    return new CodexAppServerClient({
      cwd,
      launch: () => ({
        command: this.#codexBin,
        args: [...this.#configOverrides.flatMap((value) => ["-c", value]), "app-server", "--stdio"],
        options: { cwd },
      }),
      requestTimeoutMs,
      initializeCapabilities: { experimentalApi: true },
      clientInfo: { name: "rootbound_public_authority", title: "Rootbound Public Authority", version: "0.1.0" },
    });
  }

  async #validateCwd(value) {
    if (typeof value !== "string" || !value.trim()) throw new Error("cwd must be a non-empty string");
    const resolved = path.resolve(value);
    const info = await stat(resolved);
    if (!info.isDirectory()) throw new Error(`cwd is not a directory: ${resolved}`);
    return realpath(resolved);
  }
}
