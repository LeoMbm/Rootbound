import assert from "node:assert/strict";
import { CodexPublicContextExecutor } from "../src/public-context-executor.mjs";

const requests = [];
let running = false;
const fakeClient = {
  get running() { return running; },
  get initializedResult() { return { serverInfo: { name: "Codex" } }; },
  onNotification() {},
  async start() { running = true; return this.initializedResult; },
  async close() { running = false; },
  async request(method, params, options) {
    requests.push({ method, params, options });
    if (method === "thread/start") return { thread: { id: `thread-${requests.filter((r) => r.method === "thread/start").length}` } };
    if (method === "mcpServerStatus/list") {
      return params.cursor
        ? { data: [{ name: "second", tools: {} }], nextCursor: null }
        : { data: [{ name: "first", tools: {} }], nextCursor: "next-page" };
    }
    if (method === "mcpServer/tool/call") return { content: [{ type: "text", text: "pong" }], isError: false };
    throw new Error(`Unexpected RPC ${method}`);
  },
};

const context = new CodexPublicContextExecutor({
  codexBin: "unused-in-this-test", defaultCwd: "/trusted/root",
  clientFactory: () => fakeClient,
});
try {
  const servers = await context.localMcpServers({ cwd: "/trusted/root" });
  assert.deepEqual(servers.map((server) => server.name), ["first", "second"]);
  const result = await context.localMcpCall({ cwd: "/trusted/root", server: "first", tool: "ping", arguments: { value: 42 } });
  assert.equal(result.content[0].text, "pong");
  assert.equal(requests.filter((request) => request.method === "thread/start").length, 1);
  const invoke = requests.find((request) => request.method === "mcpServer/tool/call");
  assert.deepEqual(invoke.params, { server: "first", tool: "ping", threadId: "thread-1", arguments: { value: 42 } });
  assert.equal(invoke.options.timeoutMs, 60_000);
  assert.equal(requests.filter((request) => request.method === "mcpServerStatus/list").length, 2);
} finally { await context.close(); }

console.log("local-mcp-rpc: ok");
