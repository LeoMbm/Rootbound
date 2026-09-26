import { readFile } from "node:fs/promises";

const DEFAULT_COMPONENTS = Object.freeze(["mcp", "control-plane", "response-delivery", "queue", "dispatcher"]);

export async function readTunnelHealthSnapshot({
  healthUrlPath,
  fetchFn = fetch,
  timeoutMs = 1500,
  now = () => Date.now(),
} = {}) {
  if (!healthUrlPath) return unavailable("health_url_path_unavailable", now());
  let baseUrl;
  try {
    baseUrl = normalizeBaseUrl(await readFile(healthUrlPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return unavailable("health_url_not_published", now());
    return unavailable("health_url_read_failed", now(), error);
  }
  if (!baseUrl) return unavailable("health_url_empty", now());

  const [liveness, readiness, aggregate, mcp] = await Promise.all([
    readEndpoint(fetchFn, `${baseUrl}/healthz`, timeoutMs, false),
    readEndpoint(fetchFn, `${baseUrl}/readyz`, timeoutMs, false),
    readEndpoint(fetchFn, `${baseUrl}/health?details=true`, timeoutMs, true),
    readEndpoint(fetchFn, `${baseUrl}/health/mcp`, timeoutMs, true),
  ]);

  const aggregateValue = aggregate.ok && isRecord(aggregate.json) ? aggregate.json : null;
  const mcpValue = mcp.ok && isRecord(mcp.json) ? mcp.json : null;
  const components = {};
  for (const name of DEFAULT_COMPONENTS) {
    const fromAggregate = aggregateValue?.components?.[name];
    if (isRecord(fromAggregate)) components[name] = normalizeComponent(fromAggregate);
  }
  if (mcpValue) components.mcp = normalizeComponent(mcpValue);

  return {
    available: true,
    observedAt: now(),
    live: liveness.ok,
    ready: readiness.ok,
    healthDetailsSupported: aggregate.status !== null && mcp.status !== null && aggregate.status !== 404 && mcp.status !== 404,
    endpoints: {
      healthz: publicEndpoint(liveness),
      readyz: publicEndpoint(readiness),
      details: publicEndpoint(aggregate),
      mcp: publicEndpoint(mcp),
    },
    runtime: aggregateValue?.runtime ? {
      version: safeString(aggregateValue.runtime.version),
      flavor: safeString(aggregateValue.runtime.flavor),
      lifecycle: safeString(aggregateValue.runtime.lifecycle),
      uptimeSeconds: Number.isFinite(aggregateValue.runtime.uptime_seconds) ? aggregateValue.runtime.uptime_seconds : null,
    } : null,
    snapshotAt: safeString(aggregateValue?.snapshot_at) ?? safeString(mcpValue?.snapshot_at),
    components,
  };
}

export function summarizeTunnelHealth(snapshot) {
  if (!snapshot?.available) return {
    available: false,
    live: false,
    ready: false,
    healthDetailsSupported: false,
    components: {},
    reason: snapshot?.reason ?? "unavailable",
  };
  return {
    available: true,
    live: snapshot.live === true,
    ready: snapshot.ready === true,
    healthDetailsSupported: snapshot.healthDetailsSupported === true,
    runtime: snapshot.runtime ?? null,
    snapshotAt: snapshot.snapshotAt ?? null,
    components: snapshot.components ?? {},
  };
}

function normalizeComponent(value) {
  return {
    status: safeString(value.status),
    state: safeString(value.state),
    reasonCode: safeString(value.reason_code),
    observedAt: safeString(value.observed_at),
    limited: typeof value.limited === "boolean" ? value.limited : null,
    details: normalizeDetails(value.details),
  };
}

function normalizeDetails(value) {
  if (!isRecord(value)) return null;
  const allowed = {};
  for (const key of [
    "transport", "child_state", "evidence", "initialize_epoch",
    "active_operations", "pool_limit", "oldest_active_age_seconds",
    "queue_depth", "queue_capacity", "utilization",
    "active_uploads", "last_success_at", "last_failure_at",
    "last_poll_at", "last_successful_poll_at",
  ]) {
    if (value[key] !== undefined && value[key] !== null && ["string", "number", "boolean"].includes(typeof value[key])) {
      allowed[key] = value[key];
    }
  }
  return Object.keys(allowed).length ? allowed : null;
}

async function readEndpoint(fetchFn, url, timeoutMs, parseJson) {
  try {
    const response = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs), cache: "no-store" });
    let json = null;
    if (parseJson) {
      try { json = await response.json(); } catch {}
    }
    return { ok: response.ok, status: response.status, json, error: null };
  } catch (error) {
    return { ok: false, status: null, json: null, error: error instanceof Error ? error.message : String(error) };
  }
}

function publicEndpoint(value) {
  return {
    ok: value.ok,
    status: value.status,
    error: value.error,
  };
}

function unavailable(reason, observedAt, error = null) {
  return {
    available: false,
    observedAt,
    live: false,
    ready: false,
    healthDetailsSupported: false,
    reason,
    error: error ? (error instanceof Error ? error.message : String(error)) : null,
    endpoints: {},
    runtime: null,
    snapshotAt: null,
    components: {},
  };
}

function normalizeBaseUrl(value) {
  const text = String(value ?? "").trim().replace(/\/$/, "");
  if (!text) return null;
  try {
    const url = new URL(text);
    if (!["http:", "https:"].includes(url.protocol)) return null;
    if (!["127.0.0.1", "localhost", "::1"].includes(url.hostname)) return null;
    return url.origin + url.pathname.replace(/\/$/, "");
  } catch {
    return null;
  }
}

function safeString(value) {
  return typeof value === "string" && value ? value : null;
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
