const ACCOUNT_USAGE_METHOD = "account/usage/read";
const ACCOUNT_RATE_LIMITS_METHOD = "account/rateLimits/read";

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeUnavailable(method, error) {
  const rpcError = isRecord(error?.rpcError) ? error.rpcError : null;
  return {
    status: "unavailable",
    method,
    error: {
      name: error instanceof Error ? error.name : "Error",
      message: error instanceof Error ? error.message : String(error),
      rpcCode: Number.isInteger(rpcError?.code) ? rpcError.code : null,
      rpcMessage: typeof rpcError?.message === "string" ? rpcError.message : null,
    },
  };
}

function normalizeWindow(kind, window) {
  if (!isRecord(window) || !Number.isInteger(window.usedPercent)) return null;
  return {
    kind,
    usedPercent: window.usedPercent,
    resetsAt: Number.isInteger(window.resetsAt) ? window.resetsAt : null,
    windowDurationMins: Number.isInteger(window.windowDurationMins) ? window.windowDurationMins : null,
  };
}

function normalizeLimitBucket(key, snapshot) {
  const source = isRecord(snapshot) ? snapshot : {};
  const windows = [
    normalizeWindow("primary", source.primary),
    normalizeWindow("secondary", source.secondary),
  ].filter(Boolean);
  return {
    key,
    limitId: typeof source.limitId === "string" ? source.limitId : null,
    limitName: typeof source.limitName === "string" ? source.limitName : null,
    planType: typeof source.planType === "string" ? source.planType : null,
    rateLimitReachedType: typeof source.rateLimitReachedType === "string" ? source.rateLimitReachedType : null,
    spendControlReached: typeof source.spendControlReached === "boolean" ? source.spendControlReached : null,
    windows,
    credits: source.credits ?? null,
    individualLimit: source.individualLimit ?? null,
  };
}

export function normalizeCodexRateLimits(response) {
  const source = isRecord(response) ? response : {};
  const byLimitId = isRecord(source.rateLimitsByLimitId) ? source.rateLimitsByLimitId : null;
  const validByLimitEntries = byLimitId ? Object.entries(byLimitId).filter(([, snapshot]) => isRecord(snapshot)) : [];
  const legacyRateLimits = isRecord(source.rateLimits) ? source.rateLimits : null;
  const legacyKey = typeof legacyRateLimits?.limitId === "string" ? legacyRateLimits.limitId : null;
  const entries = validByLimitEntries.length ? validByLimitEntries : legacyRateLimits ? [[legacyKey, legacyRateLimits]] : [];
  return {
    raw: response,
    limits: entries.map(([key, snapshot]) => normalizeLimitBucket(key, snapshot)),
    rateLimitResetCredits: source.rateLimitResetCredits ?? null,
  };
}

async function readObservedMethod(client, method, normalize = (value) => value) {
  try {
    const value = await client.request(method, null);
    return { status: "ok", method, value: normalize(value) };
  } catch (error) {
    return normalizeUnavailable(method, error);
  }
}

export async function readCodexQuotaSnapshot({ client, now = Date.now } = {}) {
  if (!client || typeof client.request !== "function") throw new Error("readCodexQuotaSnapshot requires a Codex App Server client");
  if (typeof now !== "function") throw new Error("now must be a function");
  const [usage, rateLimits] = await Promise.all([
    readObservedMethod(client, ACCOUNT_USAGE_METHOD),
    readObservedMethod(client, ACCOUNT_RATE_LIMITS_METHOD, normalizeCodexRateLimits),
  ]);
  const okCount = [usage, rateLimits].filter((entry) => entry.status === "ok").length;
  return {
    status: okCount === 2 ? "ok" : okCount === 1 ? "partial" : "unavailable",
    observedAt: new Date(now()).toISOString(),
    usage,
    rateLimits,
  };
}
