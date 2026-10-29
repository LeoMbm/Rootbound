import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import vm from "node:vm";
import { registerStudioMcpTools, requestStudio, STUDIO_URI } from "../src/studio-mcp-tools.mjs";

const require = createRequire(import.meta.url);
const { McpServer } = require("@modelcontextprotocol/server");
const { Client, InMemoryTransport } = require("@modelcontextprotocol/client");

const home = mkdtempSync(join(tmpdir(), "rootbound-studio-mcp-"));
try {
  const allowedRoot = home;
  const authorized = { projectRef: "project_" + "a".repeat(20), name: "Allowed", root: allowedRoot, trusted: true };
  const blocked = { projectRef: "project_" + "b".repeat(20), name: "Blocked", root: allowedRoot, trusted: true };
  const store = { listProjects: () => [authorized, blocked] };
  const bridgeCalls = [];
  let pings = 0;
  const tools = new Map();
  const resources = new Map();
  const server = {
    registerTool(name, options, handler) { tools.set(name, { options, handler }); },
    registerResource(name, uri, options, handler) { resources.set(uri, { options, handler }); },
  };
  registerStudioMcpTools(server, {
    store,
    projectAccessProvider: async () => ({ enforced: true, projectRefs: [authorized.projectRef] }),
    bridge: async (request) => {
      if (request.action === "ping") { pings += 1; return { ok: true }; }
      bridgeCalls.push(request);
      return { ok: true };
    },
  });
  assert.deepEqual([...tools.keys()].sort(), ["studio.action", "studio.open", "studio.projects"]);
  const view = await resources.get(STUDIO_URI).handler();
  assert.equal(view.contents[0].mimeType, "text/html;profile=mcp-app");
  assert.match(view.contents[0].text, /sendFollowUpMessage/);
  const script = view.contents[0].text.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script, "Widget must have an embedded script");
  assert.doesNotThrow(() => new vm.Script(script), "Widget JavaScript must parse");
  const launch = await tools.get("studio.open").handler();
  assert.equal(launch.structuredContent.status, "ready");
  assert.equal(launch.structuredContent.companion.connected, true);
  assert.equal(pings, 1);
  assert.deepEqual(launch.structuredContent.projects.map((p) => p.projectRef), [authorized.projectRef]);
  assert.equal(tools.get("studio.action").options._meta.ui.visibility[0], "app");
  await assert.rejects(tools.get("studio.action").handler({ projectRef: blocked.projectRef, action: "notes" }), /not authorized/);
  assert.equal(bridgeCalls.length, 0);
  await tools.get("studio.action").handler({ projectRef: authorized.projectRef, action: "activate" });
  assert.deepEqual(bridgeCalls[0], { cwd: allowedRoot, action: "activate" });

  const offlineTools = new Map();
  registerStudioMcpTools({
    registerTool(name, options, handler) { offlineTools.set(name, handler); },
    registerResource() {},
  }, {
    store,
    projectAccessProvider: async () => ({ enforced: true, projectRefs: [authorized.projectRef] }),
    bridge: async () => { throw new Error("Local Studio backend unreachable"); },
  });
  const offline = await offlineTools.get("studio.open")();
  assert.equal(offline.structuredContent.status, "companion_offline");
  assert.equal(offline.structuredContent.companion.connected, false);
  assert.match(offline.content[0].text, /not its root page or Vite frontend port/);

  const liveServer = new McpServer({ name: "studio-test", version: "1.0" });
  registerStudioMcpTools(liveServer, {
    store,
    projectAccessProvider: async () => ({ enforced: true, projectRefs: [authorized.projectRef] }),
    bridge: async () => ({ ok: true }),
  });
  const liveClient = new Client({ name: "studio-ui-test", version: "1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([liveServer.connect(serverTransport), liveClient.connect(clientTransport)]);
  try {
    const listed = await liveClient.listTools();
    assert.deepEqual(listed.tools.map((t) => t.name).sort(), ["studio.action", "studio.open", "studio.projects"]);
    assert.equal(listed.tools.find((t) => t.name === "studio.open")._meta.ui.resourceUri, STUDIO_URI);
    const opened = await liveClient.callTool({ name: "studio.open", arguments: {} });
    assert.equal(opened.structuredContent.projects.length, 1);
    const action = await liveClient.callTool({ name: "studio.action", arguments: { projectRef: authorized.projectRef, action: "activate" } });
    assert.equal(action.structuredContent.ok, true);
    const rejected = await liveClient.callTool({ name: "studio.action", arguments: { projectRef: blocked.projectRef, action: "notes" } });
    assert.equal(rejected.isError, true);
    const widget = await liveClient.readResource({ uri: STUDIO_URI });
    assert.equal(widget.contents[0].mimeType, "text/html;profile=mcp-app");
    assert.match(widget.contents[0].text, /sendFollowUpMessage/);
  } finally {
    await liveClient.close();
    await liveServer.close();
  }

  await assert.rejects(requestStudio({ cwd: allowedRoot, action: "notes" }, {
    env: { ROOTBOUND_STUDIO_URL: "http://example.com" }, readToken: () => "a".repeat(64), fetcher: () => Promise.resolve(),
  }), /loopback/);
  console.log("Rootbound Studio MCP widget, project scope and local proxy PASS");
} finally {
  rmSync(home, { recursive: true, force: true });
}
