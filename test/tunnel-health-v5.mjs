import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readTunnelHealthSnapshot, summarizeTunnelHealth } from "../src/tunnel-health.mjs";

const root = await mkdtemp(path.join(os.tmpdir(), "rootbound-tunnel-health-"));
const runtime = path.join(root, "runtime");
await mkdir(runtime, { recursive: true });
const healthUrlPath = path.join(runtime, "health.url");
await writeFile(healthUrlPath, "http://127.0.0.1:43210\n", "utf8");

const calls = [];
const responses = new Map([
  ["/healthz", response(200, "live")],
  ["/readyz", response(200, "ready")],
  ["/health?details=true", response(200, {
    schema_version: 1,
    ready: true,
    snapshot_at: "2026-09-27T00:00:00Z",
    runtime: { version: "0.0.15", flavor: "full", lifecycle: "running", uptime_seconds: 42 },
    components: {
      "control-plane": { status: "ok", state: "polling", observed_at: "2026-09-27T00:00:00Z" },
      "response-delivery": { status: "ok", state: "idle" },
      queue: { status: "ok", state: "idle", details: { queue_depth: 0, queue_capacity: 100 } },
      dispatcher: { status: "ok", state: "idle", details: { active_operations: 0, pool_limit: 8 } },
    },
  })],
  ["/health/mcp", response(200, {
    schema_version: 1,
    component: "mcp",
    status: "ok",
    state: "discovered",
    observed_at: "2026-09-27T00:00:00Z",
    details: { transport: "stdio", child_state: "running", evidence: "same_child", secret: "must-not-leak" },
  })],
]);

const snapshot = await readTunnelHealthSnapshot({
  healthUrlPath,
  now: () => 123,
  fetchFn: async (url) => {
    const parsed = new URL(url);
    const key = parsed.pathname + parsed.search;
    calls.push(key);
    return responses.get(key) ?? response(404, "missing");
  },
});
assert.equal(snapshot.available, true);
assert.equal(snapshot.live, true);
assert.equal(snapshot.ready, true);
assert.equal(snapshot.healthDetailsSupported, true);
assert.equal(snapshot.runtime.version, "0.0.15");
assert.equal(snapshot.components.mcp.status, "ok");
assert.equal(snapshot.components.mcp.state, "discovered");
assert.equal(snapshot.components.mcp.details.transport, "stdio");
assert.equal(snapshot.components.mcp.details.secret, undefined);
assert.equal(snapshot.components.queue.details.queue_depth, 0);
assert.deepEqual(calls.sort(), ["/health/mcp", "/health?details=true", "/healthz", "/readyz"].sort());

const summary = summarizeTunnelHealth(snapshot);
assert.equal(summary.live, true);
assert.equal(summary.ready, true);
assert.equal(summary.components.dispatcher.status, "ok");

const oldRuntime = await readTunnelHealthSnapshot({
  healthUrlPath,
  fetchFn: async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/healthz" || parsed.pathname === "/readyz") return response(200, "ok");
    return response(404, "not found");
  },
});
assert.equal(oldRuntime.available, true);
assert.equal(oldRuntime.live, true);
assert.equal(oldRuntime.ready, true);
assert.equal(oldRuntime.healthDetailsSupported, false);

const missing = await readTunnelHealthSnapshot({ healthUrlPath: path.join(root, "missing.url") });
assert.equal(missing.available, false);
assert.equal(missing.reason, "health_url_not_published");

console.log("tunnel-health-v5: ok");

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      if (typeof body === "string") throw new Error("not json");
      return body;
    },
  };
}
