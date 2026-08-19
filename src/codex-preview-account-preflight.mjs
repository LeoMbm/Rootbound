import path from "node:path";
import { CodexAppServerClient } from "./codex-app-server-client.mjs";
import { readCodexQuotaSnapshot } from "./codex-quota-snapshot.mjs";

const ACCOUNT_READ_METHOD = "account/read";

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeError(error) {
  const rpcError = isRecord(error?.rpcError) ? error.rpcError : null;
  return {
    name: error instanceof Error ? error.name : "Error",
    message: error instanceof Error ? error.message : String(error),
    rpcCode: Number.isInteger(rpcError?.code) ? rpcError.code : null,
    rpcMessage: typeof rpcError?.message === "string" ? rpcError.message : null,
  };
}

function unavailableAccount(error) {
  return {
    status: "unavailable",
    method: ACCOUNT_READ_METHOD,
    accountPresent: null,
    requiresOpenaiAuth: null,
    plan: null,
    error: normalizeError(error),
  };
}

function normalizeAccount(response) {
  const source = isRecord(response) ? response : {};
  const account = isRecord(source.account) ? source.account : null;
  return {
    status: "ok",
    method: ACCOUNT_READ_METHOD,
    accountPresent: Boolean(account),
    requiresOpenaiAuth: typeof source.requiresOpenaiAuth === "boolean" ? source.requiresOpenaiAuth : null,
    plan: typeof account?.planType === "string" ? account.planType : null,
    error: null,
  };
}

function projectQuotaEntry(entry) {
  return { status: entry?.status ?? "unavailable", error: entry?.status === "unavailable" ? entry.error ?? null : null };
}

function normalizeQuota(snapshot) {
  return {
    status: snapshot?.status ?? "unavailable",
    observedAt: typeof snapshot?.observedAt === "string" ? snapshot.observedAt : null,
    usage: projectQuotaEntry(snapshot?.usage),
    rateLimits: projectQuotaEntry(snapshot?.rateLimits),
  };
}

function unavailableQuota(error, now) {
  const normalized = normalizeError(error);
  return {
    status: "unavailable",
    observedAt: new Date(now()).toISOString(),
    usage: { status: "unavailable", error: normalized },
    rateLimits: { status: "unavailable", error: normalized },
  };
}

async function closeTelemetryClient(client) {
  if (!client || typeof client.close !== "function") return { status: "not-started", error: null };
  try {
    await client.close();
    return { status: "ok", error: null };
  } catch (error) {
    return { status: "unavailable", error: normalizeError(error) };
  }
}

export function createPreviewTelemetryClient({ codexBin, defaultCwd, configOverrides = [], stderrHandler = null } = {}) {
  if (!codexBin) throw new Error("createPreviewTelemetryClient requires codexBin");
  if (!defaultCwd) throw new Error("createPreviewTelemetryClient requires defaultCwd");
  if (!Array.isArray(configOverrides) || !configOverrides.every((value) => typeof value === "string" && value.trim())) {
    throw new Error("configOverrides must be an array of non-empty strings");
  }

  const cwd = path.resolve(defaultCwd);
  return new CodexAppServerClient({
    cwd,
    launch: () => ({
      command: codexBin,
      args: [...configOverrides.flatMap((value) => ["-c", value]), "app-server", "--stdio"],
      options: { cwd },
    }),
    requestTimeoutMs: 10_000,
    initializeCapabilities: { experimentalApi: true },
    stderrHandler,
    clientInfo: {
      name: "rootbound_preview_account_preflight",
      title: "Rootbound Preview Account Preflight",
      version: "0.1.0",
    },
  });
}

export async function readPreviewAccountPreflight({
  codexBin,
  defaultCwd,
  configOverrides = [],
  clientFactory = createPreviewTelemetryClient,
  now = Date.now,
} = {}) {
  if (typeof clientFactory !== "function") throw new Error("clientFactory must be a function");
  if (typeof now !== "function") throw new Error("now must be a function");

  const observedAt = new Date(now()).toISOString();
  let client = null;
  let account;
  let quota;

  try {
    client = clientFactory({ codexBin, defaultCwd, configOverrides });
    await client.start();
  } catch (error) {
    return {
      status: "unavailable",
      observedAt,
      account: unavailableAccount(error),
      quota: unavailableQuota(error, now),
      cleanup: await closeTelemetryClient(client),
    };
  }

  try {
    account = normalizeAccount(await client.request(ACCOUNT_READ_METHOD, { refreshToken: false }));
  } catch (error) {
    account = unavailableAccount(error);
  }

  try {
    quota = normalizeQuota(await readCodexQuotaSnapshot({ client, now }));
  } catch (error) {
    quota = unavailableQuota(error, now);
  }

  const cleanup = await closeTelemetryClient(client);
  const observedCount = [account.status === "ok", quota.status !== "unavailable"].filter(Boolean).length;
  const dataStatus = observedCount === 2 ? "ok" : observedCount === 1 ? "partial" : "unavailable";

  return {
    status: cleanup.status === "ok" ? dataStatus : dataStatus === "unavailable" ? "unavailable" : "partial",
    observedAt,
    account,
    quota,
    cleanup,
  };
}
