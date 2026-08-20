import path from "node:path";
import { ACCEPTED_CODEX_VERSIONS, CodexAuthorityExecutor } from "./codex-authority-executor.mjs";
import { CodexBrowserReaderExecutor } from "./browser-reader-executor.mjs";
import { resolveCodexExecutable } from "./codex-bin.mjs";
import { createCommandManager } from "./command-manager.mjs";
import { createDurableRescueManager } from "./durable-rescue.mjs";
import { readJsonFile } from "./json-file.mjs";
import { createPersistentContinuityState } from "./persistent-continuity-state.mjs";
import { CodexPublicContextExecutor } from "./public-context-executor.mjs";
import { createPublicServerFactory } from "./public-server-factory.mjs";
import { createRescueAutopilot } from "./rescue-autopilot.mjs";
import { createRescueSessionManager } from "./rescue-continuity.mjs";
import { withRootboundPermissionOverrides } from "./rootbound-permission-profile.mjs";
import { resolveRootboundPaths } from "./state-paths.mjs";
import { openStateStore } from "./state-store.mjs";
import { PUBLIC_SERVER_VERSION, PUBLIC_SURFACE_VERSION, PUBLIC_TOOL_NAMES } from "./surface-contracts.mjs";

function envString(env, name, fallback = null) {
  const value = env?.[name];
  return typeof value === "string" && value.length ? value : fallback;
}

function envInteger(env, name, fallback, min, max) {
  const raw = envString(env, name, null);
  if (raw === null) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || String(parsed) !== raw || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

export async function createPublicRuntime({ env = process.env } = {}) {
  const supportedPlatform = process.platform === "win32" || (process.platform === "darwin" && process.arch === "arm64");
  if (!supportedPlatform && env.ROOTBOUND_ALLOW_NONWINDOWS_PROBE !== "1") {
    throw new Error("Rootbound Technical Preview currently supports Windows and Apple Silicon macOS only");
  }

  const probeVersion = !supportedPlatform && env.ROOTBOUND_ALLOW_NONWINDOWS_PROBE === "1"
    ? envString(env, "ROOTBOUND_PROBE_CODEX_VERSION", null)
    : null;
  const acceptedCodexVersions = probeVersion
    ? [...new Set([...ACCEPTED_CODEX_VERSIONS, probeVersion])]
    : ACCEPTED_CODEX_VERSIONS;
  const codexResolution = await resolveCodexExecutable({ env, acceptedVersions: acceptedCodexVersions });
  const codexBin = codexResolution.path;

  const defaultCwd = envString(env, "ROOTBOUND_DEFAULT_CWD", process.cwd());
  const profileOverride = envString(env, "ROOTBOUND_PROFILE", null);
  const configOverridesFile = envString(env, "ROOTBOUND_CONFIG_OVERRIDES_FILE", null);
  const configuredOverrides = configOverridesFile
    ? (await readJsonFile(configOverridesFile, "ROOTBOUND_CONFIG_OVERRIDES_FILE"))?.overrides
    : [];
  if (!Array.isArray(configuredOverrides) || !configuredOverrides.every((value) => typeof value === "string" && value.trim())) {
    throw new Error("ROOTBOUND_CONFIG_OVERRIDES_FILE must contain { overrides: [\"key=value\", ...] }");
  }
  const configOverrides = withRootboundPermissionOverrides(configuredOverrides, { profileOverride });
  const rescueAutopilotEnabled = envString(env, "ROOTBOUND_RESCUE_AUTOPILOT", "1") !== "0";
  const rescueAutopilotThreshold = envInteger(env, "ROOTBOUND_RESCUE_ARM_PERCENT", 85, 50, 100);
  const rescueAutopilotIntervalMs = envInteger(env, "ROOTBOUND_RESCUE_POLL_MS", 60_000, 10_000, 3_600_000);

  let publicContext = null;
  let stateStore = null;
  let commandManager = null;
  let rescueAutopilot = null;
  let closed = false;

  try {
    const authorityExecutor = new CodexAuthorityExecutor({
      codexBin,
      defaultCwd,
      profileOverride,
      configOverrides,
      maxTimeoutMs: 120_000,
      watchdogGraceMs: 5_000,
      outputBytesCap: 1_048_576,
      acceptedCodexVersions,
    });
    const authorityValidation = await authorityExecutor.validate();

    publicContext = new CodexPublicContextExecutor({ codexBin, defaultCwd, configOverrides });
    await publicContext.start();
    stateStore = await openStateStore({ paths: resolveRootboundPaths({ env }) });

    const continuityState = createPersistentContinuityState({ store: stateStore });
    const baseRescueManager = createRescueSessionManager({ store: stateStore, authorityExecutor, continuityState });
    const rescueManager = createDurableRescueManager({ base: baseRescueManager, store: stateStore });
    commandManager = createCommandManager({
      store: stateStore,
      continuityState,
      rescueManager,
      authorityExecutor,
      codexBin,
      configOverrides,
      packageRoot: path.resolve(import.meta.dirname, ".."),
      env,
    });
    const browserReader = new CodexBrowserReaderExecutor({ context: publicContext, defaultCwd });

    if (rescueAutopilotEnabled) {
      rescueAutopilot = createRescueAutopilot({
        publicContext,
        store: stateStore,
        rescueManager,
        authorityExecutor,
        defaultCwd,
        thresholdPercent: rescueAutopilotThreshold,
        intervalMs: rescueAutopilotIntervalMs,
      });
      rescueAutopilot.start();
    }

    const createServer = createPublicServerFactory({
      executor: authorityExecutor,
      authorityExecutor,
      publicContext,
      browserReader,
      continuityState,
      rescueManager,
      rescueAutopilot,
      commandManager,
      stateStore,
      maxConcurrent: 1,
    });

    async function close() {
      if (closed) return;
      closed = true;
      const autopilotDrain = rescueAutopilot?.close() ?? Promise.resolve();
      try { await commandManager?.close(); }
      finally {
        try { await publicContext?.close(); }
        finally {
          await autopilotDrain.catch(() => {});
          stateStore?.close();
        }
      }
    }

    return {
      createServer,
      close,
      version: PUBLIC_SERVER_VERSION,
      surfaceVersion: PUBLIC_SURFACE_VERSION,
      toolNames: PUBLIC_TOOL_NAMES,
      defaultCwd,
      authorityValidation,
      modelLane: "chatgpt-only",
      rescueAutopilot: rescueAutopilot ? { enabled: true, thresholdPercent: rescueAutopilotThreshold, intervalMs: rescueAutopilotIntervalMs } : { enabled: false },
    };
  } catch (error) {
    const autopilotDrain = rescueAutopilot?.close() ?? Promise.resolve();
    await commandManager?.close().catch(() => {});
    await publicContext?.close().catch(() => {});
    await autopilotDrain.catch(() => {});
    try { stateStore?.close(); } catch {}
    throw error;
  }
}
