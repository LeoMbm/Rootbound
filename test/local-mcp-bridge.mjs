import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readLocalMcpGrants, setLocalMcpGrant } from "../src/local-mcp-access.mjs";
import { registerLocalMcpTools } from "../src/local-mcp-tools.mjs";

const connectionId = "connection_aaaaaaaaaaaaaaaaaaaaaaaa";
const secondConnection = "connection_bbbbbbbbbbbbbbbbbbbbbbbb";
const directory = await mkdtemp(path.join(os.tmpdir(), "rootbound-local-mcp-"));
const paths = { stateDir: directory };
const handlers = new Map();
const seen = [];
const fixture = [{
  name: "test-server",
  tools: {
    safe: { name: "echo", description: "Echo one value", inputSchema: { type: "object", properties: { message: { type: "string" } } } },
    dangerous: { name: "delete", description: "Delete data", inputSchema: { type: "object" } },
  },
}];
let currentConnection = connectionId;
let currentCwd = "/trusted/project";
const context = {
  async localMcpServers({ cwd }) { seen.push(["list", cwd]); return fixture; },
  async localMcpCall({ cwd, server, tool, arguments: args }) {
    seen.push(["call", cwd, server, tool, args]);
    return { content: [{ type: "text", text: args.message }], isError: false };
  },
};
const scope = {
  async resolveAuthority({ cwd }) {
    if (cwd !== "/trusted/project") throw new Error("PROJECT_SCOPE_REQUIRED");
    return { effectiveCwd: cwd };
  },
};
const registered = { registerTool(name, definition, handler) { handlers.set(name, handler); assert.ok(definition.inputSchema); } };
registerLocalMcpTools(registered, {
  context, authorityExecutor: scope, paths,
  projectAccessProvider: async () => ({ enforced: true, connectionId: currentConnection }),
});
assert.deepEqual([...handlers.keys()], ["local_mcp.list_servers", "local_mcp.list_tools", "local_mcp.call_tool"]);

const invoke = (name, args = {}) => handlers.get(name)({ cwd: currentCwd, ...args });
try {
  const discovered = await invoke("local_mcp.list_servers");
  assert.equal(discovered.structuredContent.servers[0].name, "test-server");
  assert.deepEqual(discovered.structuredContent.servers[0].permittedTools, []);
  const tools = await invoke("local_mcp.list_tools", { server: "test-server" });
  assert.equal(tools.structuredContent.tools[0].inputSchema.properties.message.type, "string");
  assert.equal(tools.structuredContent.tools[0].permitted, false);

  const denied = await invoke("local_mcp.call_tool", { server: "test-server", tool: "echo", arguments: { message: "hi" } });
  assert.equal(denied.isError, true);
  assert.equal(denied.structuredContent.errorCode, "LOCAL_MCP_TOOL_NOT_ALLOWED");
  assert.equal(seen.some((row) => row[0] === "call"), false);

  await setLocalMcpGrant({ paths, connectionId, server: "test-server", tool: "echo", allowed: true });
  const grantStat = await readFile(path.join(directory, "local-mcp-grants.json"), "utf8");
  assert.ok(grantStat.includes("test-server"));
  const result = await invoke("local_mcp.call_tool", { server: "test-server", tool: "echo", arguments: { message: "hello" } });
  assert.equal(result.isError, false);
  assert.equal(result.structuredContent.result.content[0].text, "hello");
  assert.equal(seen.filter((row) => row[0] === "call").length, 1);
  assert.equal((await invoke("local_mcp.list_tools", { server: "test-server" })).structuredContent.tools[0].permitted, true);

  const unsafe = await invoke("local_mcp.call_tool", { server: "test-server", tool: "delete", arguments: {} });
  assert.equal(unsafe.structuredContent.errorCode, "LOCAL_MCP_TOOL_NOT_ALLOWED");
  currentConnection = secondConnection;
  assert.equal((await invoke("local_mcp.call_tool", { server: "test-server", tool: "echo" })).isError, true);
  currentConnection = connectionId;
  currentCwd = "/outside/project";
  assert.equal((await invoke("local_mcp.call_tool", { server: "test-server", tool: "echo" })).isError, true);
  currentCwd = "/trusted/project";

  await setLocalMcpGrant({ paths, connectionId, server: "test-server", tool: "echo", allowed: false });
  assert.deepEqual(await readLocalMcpGrants({ paths, connectionId }), {});
  assert.equal((await invoke("local_mcp.call_tool", { server: "test-server", tool: "echo" })).isError, true);

  await writeFile(path.join(directory, "local-mcp-grants.json"), '{"schemaVersion":1,"connections":{"connection_aaaaaaaaaaaaaaaaaaaaaaaa":{"test-server":["echo","echo"]}}}');
  const malformed = await invoke("local_mcp.call_tool", { server: "test-server", tool: "echo" });
  assert.equal(malformed.isError, true);
  assert.equal(seen.filter((row) => row[0] === "call").length, 1);
} finally {
  await rm(directory, { recursive: true, force: true });
}
console.log("local-mcp-bridge: ok");
