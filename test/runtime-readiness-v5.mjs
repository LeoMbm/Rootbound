import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { addConnection } from "../src/connection-registry.mjs";
import { resolveConnectionPaths } from "../src/connection-paths.mjs";
import { readRuntimeState } from "../src/runtime-state.mjs";
import { resolveRootboundPaths } from "../src/state-paths.mjs";
import { saveTunnelConfig } from "../src/tunnel-config.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");
const root = await mkdtemp(path.join(os.tmpdir(), "rootbound-readiness-"));
const fakeTunnel = path.join(root, "fake-tunnel.mjs");
await writeFile(fakeTunnel, `
import http from "node:http";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
const home = process.env.ROOTBOUND_HOME;
const id = process.env.ROOTBOUND_CONNECTION_ID;
const server = http.createServer((req, res) => {
  if (req.url === "/readyz") { res.statusCode = process.env.FAKE_READY === "1" ? 200 : 503; res.end("ready"); return; }
  if (req.url === "/healthz") { res.statusCode = 200; res.end("alive"); return; }
  res.statusCode = 404; res.end("not found");
});
server.listen(0, "127.0.0.1", async () => {
  const address = server.address();
  const runtime = path.join(home, "runtime");
  await mkdir(runtime, { recursive: true });
  await writeFile(path.join(runtime, \`tunnel-health-\${id}.url\`), \`http://127.0.0.1:\${address.port}\\n\`);
});
process.on("SIGTERM", () => server.close(() => process.exit(0)));
setInterval(() => {}, 1000);
`, "utf8");

await readyCase();
await notReadyCase();
console.log("runtime-readiness-v5: ok");

async function readyCase() {
  const home = path.join(root, "ready");
  const paths = resolveRootboundPaths({ env: { ROOTBOUND_HOME: home } });
  const added = await addConnection({ paths, name: "ready", tunnelId: "tunnel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", makeActive: true });
  const connectionPaths = resolveConnectionPaths({ paths, connection: added.connection });
  await saveTunnelConfig({ argv: [process.execPath, fakeTunnel], paths: connectionPaths });
  const child = launchSupervisor({ home, connectionId: added.connection.id, ready: true });
  try {
    const state = await waitFor(async () => {
      const value = await readRuntimeState(paths).catch(() => null);
      return value?.ready === true ? value : null;
    }, 5000);
    assert.equal(state.status, "ready");
    assert.equal(state.connectionId, added.connection.id);
    assert.equal(state.projectRef, "project_ready");
  } finally {
    child.kill("SIGTERM");
    await waitForExit(child);
  }
}

async function notReadyCase() {
  const home = path.join(root, "not-ready");
  const paths = resolveRootboundPaths({ env: { ROOTBOUND_HOME: home } });
  const added = await addConnection({ paths, name: "not-ready", tunnelId: "tunnel_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", makeActive: true });
  const connectionPaths = resolveConnectionPaths({ paths, connection: added.connection });
  await saveTunnelConfig({ argv: [process.execPath, fakeTunnel], paths: connectionPaths });
  const child = launchSupervisor({ home, connectionId: added.connection.id, ready: false });
  const exit = await waitForExit(child, 7000);
  assert.notEqual(exit.code, 0, "scoped supervisor must fail when /readyz never becomes ready");
  const state = await readRuntimeState(paths).catch(() => null);
  assert.equal(state, null, "failed scoped startup must not publish a running runtime state");
}

function launchSupervisor({ home, connectionId, ready }) {
  return spawn(process.execPath, [path.join(repoRoot, "scripts", "supervisor.mjs")], {
    cwd: repoRoot,
    env: {
      ...process.env,
      ROOTBOUND_HOME: home,
      ROOTBOUND_PROJECT_REF: ready ? "project_ready" : "project_not_ready",
      ROOTBOUND_PROJECT_ROOT: root,
      ROOTBOUND_CONNECTION_ID: connectionId,
      ROOTBOUND_TUNNEL_RESTART_LIMIT: "0",
      FAKE_READY: ready ? "1" : "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
}

async function waitFor(check, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`condition did not become true within ${timeoutMs}ms`);
}

async function waitForExit(child, timeoutMs = 5000) {
  if (child.exitCode !== null || child.signalCode !== null) return { code: child.exitCode, signal: child.signalCode };
  return Promise.race([
    new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal }))),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`child did not exit within ${timeoutMs}ms`)), timeoutMs)),
  ]);
}
