import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { createPublicServerFactory } from "../src/public-server-factory.mjs";
import { openStateStore } from "../src/state-store.mjs";
import { resolveRootboundPaths } from "../src/state-paths.mjs";

const require = createRequire(import.meta.url);
const { Client, InMemoryTransport } = require("@modelcontextprotocol/client");

const projectRoot = path.resolve(import.meta.dirname, "..");
const tempRoot = await mkdtemp(path.join(projectRoot, "node_modules", ".rootbound-command-concurrency-"));
const paths = resolveRootboundPaths({ env: { ...process.env, ROOTBOUND_HOME: tempRoot } });
const stateStore = await openStateStore({ paths });

let execCalls = 0;
let firstStartedResolve;
let releaseFirstResolve;
const firstStarted = new Promise((resolve) => { firstStartedResolve = resolve; });
const releaseFirst = new Promise((resolve) => { releaseFirstResolve = resolve; });

const authorityExecutor = {
  defaultCwd: projectRoot,
  async resolveAuthority({ cwd = null, access = "readOnly" } = {}) {
    return {
      effectiveCwd: cwd ?? projectRoot,
      permissionProfile: access === "readOnly" ? ":read-only" : "rootbound",
      permissionCeiling: "rootbound",
      authoritySource: "test",
      trustedAncestor: projectRoot,
    };
  },
  async exec({ cwd = null, access = "readOnly" } = {}) {
    execCalls += 1;
    const call = execCalls;
    if (call === 1) {
      firstStartedResolve();
      await releaseFirst;
    }
    return {
      exitCode: 0,
      stdout: `call-${call}`,
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      effectiveCwd: cwd ?? projectRoot,
      permissionProfile: access === "readOnly" ? ":read-only" : "rootbound",
      permissionCeiling: "rootbound",
      authoritySource: "test",
      trustedAncestor: projectRoot,
    };
  },
};

const continuityState = {
  assertCwd(_bindingRef, cwd) { return { targetCwd: cwd ?? projectRoot }; },
  record() {},
};
const rescueManager = {
  resolveBinding() { return { bindingRef: null, rescue: null, implicit: false }; },
  publicSession() { return null; },
  activeByBinding() { return null; },
};
const publicContext = {};
const browserReader = {};
const commandManager = {};

const createServer = createPublicServerFactory({
  executor: authorityExecutor,
  authorityExecutor,
  publicContext,
  browserReader,
  continuityState,
  rescueManager,
  commandManager,
  stateStore,
  maxConcurrent: 1,
});

const first = await connectClient("rootbound-concurrency-one");
const second = await connectClient("rootbound-concurrency-two");
let firstCall = null;

try {
  firstCall = first.client.callTool({
    name: "codex.command_exec",
    arguments: {
      command: ["synthetic-first"],
      cwd: projectRoot,
      access: "readOnly",
      timeoutMs: 30_000,
    },
  });
  await firstStarted;

  const secondResult = await second.client.callTool({
    name: "codex.command_exec",
    arguments: {
      command: ["synthetic-second"],
      cwd: projectRoot,
      access: "readOnly",
      timeoutMs: 30_000,
    },
  });

  assert.equal(secondResult.isError, true, "a second command on another MCP server instance must hit the runtime-global concurrency limit");
  assert.equal(secondResult.structuredContent?.errorCode, "BRIDGE_CONCURRENCY_LIMIT");
  assert.equal(secondResult.structuredContent?.retryable, true);
  assert.equal(execCalls, 1, "the rejected second command must not reach the authority executor");

  releaseFirstResolve();
  const firstResult = await firstCall;
  firstCall = null;
  assert.equal(firstResult.isError, false, "the original in-flight command should still complete normally");

  const afterRelease = await second.client.callTool({
    name: "codex.command_exec",
    arguments: {
      command: ["synthetic-after-release"],
      cwd: projectRoot,
      access: "readOnly",
      timeoutMs: 30_000,
    },
  });
  assert.equal(afterRelease.isError, false, "the runtime-global slot must be released after the active command finishes");
  assert.equal(execCalls, 2, "a later command should reach the authority executor after the slot is released");
} finally {
  releaseFirstResolve();
  await firstCall?.catch(() => {});
  await closeClient(first);
  await closeClient(second);
  stateStore.close();
  await rm(tempRoot, { recursive: true, force: true });
}

console.log("runtime-command-concurrency-v6: ok");

async function connectClient(name) {
  const server = createServer({ requestInfo: new Request(`http://127.0.0.1/${name}`) });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name, version: "0.1.0" });
  await client.connect(clientTransport);
  return { client, clientTransport, server, serverTransport };
}

async function closeClient(connection) {
  await connection.client.close().catch(() => {});
  await connection.clientTransport.close().catch(() => {});
  await connection.server.close().catch(() => {});
  await connection.serverTransport.close().catch(() => {});
}
