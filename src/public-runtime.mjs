import os from "node:os";
import path from "node:path";
import { createAgentPreviewState } from "./agent-tools.mjs";
import { CodexAgentExecutor } from "./codex-agent-executor.mjs";
import { ACCEPTED_CODEX_VERSIONS, CodexAuthorityExecutor } from "./codex-authority-executor.mjs";
import { CodexBrowserReaderExecutor } from "./browser-reader-executor.mjs";
import { resolveCodexExecutable } from "./codex-bin.mjs";
import { readCodexQuotaSnapshot } from "./codex-quota-snapshot.mjs";
import { createPreviewTelemetryClient } from "./codex-preview-account-preflight.mjs";
import { readJsonFile } from "./json-file.mjs";
import { CodexPublicContextExecutor } from "./public-context-executor.mjs";
import { createPublicServerFactory } from "./public-server-factory.mjs";
import { PUBLIC_SERVER_VERSION, PUBLIC_SURFACE_VERSION, PUBLIC_TOOL_NAMES } from "./surface-contracts.mjs";

function envString(env, name, fallback = null) {
  const value = env?.[name];
  return typeof value === "string" && value.length ? value : fallback;
}

export async function createPublicRuntime({ env = process.env } = {}) {
  const supportedPlatform = process.platform === "win32" || (process.platform === "darwin" && process.arch === "arm64");
  if (!supportedPlatform && env.CODEXLESS_ALLOW_NONWINDOWS_PROBE !== "1") {
    throw new Error("Codexless Technical Preview currently supports Windows and Apple Silicon macOS only");
  }

  const probeVersion = !supportedPlatform && env.CODEXLESS_ALLOW_NONWINDOWS_PROBE === "1"
    ? envString(env, "CODEXLESS_PROBE_CODEX_VERSION", null)
    : null;
  const acceptedCodexVersions = probeVersion
    ? [...new Set([...ACCEPTED_CODEX_VERSIONS, probeVersion])]
    : ACCEPTED_CODEX_VERSIONS;
  const codexResolution = await resolveCodexExecutable({ env, acceptedVersions: acceptedCodexVersions });
  const codexBin = codexResolution.path;

  const defaultCwd = envString(env, "CODEXLESS_DEFAULT_CWD", process.cwd());
  const profileOverride = envString(env, "CODEXLESS_PROFILE", null);
  const configOverridesFile = envString(env, "CODEXLESS_CONFIG_OVERRIDES_FILE", null);
  const configOverrides = configOverridesFile
    ? (await readJsonFile(configOverridesFile, "CODEXLESS_CONFIG_OVERRIDES_FILE"))?.overrides
    : [];
  if (!Array.isArray(configOverrides) || !configOverrides.every((value) => typeof value === "string" && value.trim())) {
    throw new Error("CODEXLESS_CONFIG_OVERRIDES_FILE must contain { overrides: [\"key=value\", ...] }");
  }

  const meteredConsentMode = envString(env, "CODEXLESS_AGENT_METERED_CONSENT", "always");
  if (!["off", "always"].includes(meteredConsentMode)) {
    throw new Error("CODEXLESS_AGENT_METERED_CONSENT must be off or always");
  }
  const agentTaskStateFile = envString(
    env,
    "CODEXLESS_AGENT_TASK_STATE_FILE",
    path.join(os.homedir(), ".config", "codexless", "agent-task-cards.json")
  );

  let publicContext = null;
  let agentExecutor = null;
  let closed = false;

  try {
    const authorityExecutor = new CodexAuthorityExecutor({
      codexBin,
      defaultCwd,
      profileOverride,
      configOverrides,
      maxTimeoutMs: 30_000,
      watchdogGraceMs: 5_000,
      outputBytesCap: 32_768,
      acceptedCodexVersions,
    });
    const authorityValidation = await authorityExecutor.validate();

    publicContext = new CodexPublicContextExecutor({ codexBin, defaultCwd, configOverrides });
    await publicContext.start();

    const resourceSnapshotProvider = async () => {
      const telemetry = createPreviewTelemetryClient({
        codexBin,
        defaultCwd,
        configOverrides,
        stderrHandler: () => {},
      });
      try {
        await telemetry.start();
        return await readCodexQuotaSnapshot({ client: telemetry });
      } finally {
        await telemetry.close().catch(() => {});
      }
    };

    agentExecutor = new CodexAgentExecutor({
      codexBin,
      defaultCwd,
      configOverrides,
      requestTimeoutMs: 30_000,
      resourceSnapshotProvider,
    });
    await agentExecutor.open();

    const agentPreviewState = createAgentPreviewState({
      meteredConsentMode,
      meteredQuotaProvider: resourceSnapshotProvider,
      taskStateFile: agentTaskStateFile,
    });

    const browserReader = new CodexBrowserReaderExecutor({ context: publicContext, defaultCwd });
    const createServer = createPublicServerFactory({
      executor: authorityExecutor,
      authorityExecutor,
      publicContext,
      browserReader,
      agentExecutor,
      meteredConsentMode,
      meteredQuotaProvider: resourceSnapshotProvider,
      agentPreviewState,
      maxConcurrent: 1,
    });

    async function close() {
      if (closed) return;
      closed = true;
      try {
        await agentExecutor?.close();
      } finally {
        await publicContext?.close();
      }
    }

    return {
      createServer,
      close,
      version: PUBLIC_SERVER_VERSION,
      surfaceVersion: PUBLIC_SURFACE_VERSION,
      toolNames: PUBLIC_TOOL_NAMES,
      defaultCwd,
      meteredConsentMode,
      authorityValidation,
    };
  } catch (error) {
    try {
      await agentExecutor?.close();
    } finally {
      await publicContext?.close();
    }
    throw error;
  }
}
