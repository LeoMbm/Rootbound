import { createRequire } from "node:module";
import { assertLocalMcpIdentifier, readLocalMcpGrants, assertLocalMcpConnectionId, isLocalMcpToolAllowed } from "./local-mcp-access.mjs";
import { RootboundToolError, typedToolResponse } from "./tool-errors.mjs";

const require = createRequire(import.meta.url);
const z = require("zod/v4");
const name = z.string().min(1).max(256);
const cwd = z.string().min(1).max(32_768).optional();
const maxResponseBytes = 2 * 1024 * 1024;

function toolList(server) {
  const raw = server?.tools;
  if (!raw || typeof raw !== "object") return [];
  return (Array.isArray(raw) ? raw : Object.values(raw))
    .filter((item) => item && typeof item === "object" && typeof item.name === "string")
    .map((item) => ({
      name: item.name,
      description: typeof item.description === "string" ? item.description.slice(0, 4_096) : "",
      inputSchema: item.inputSchema && typeof item.inputSchema === "object" ? item.inputSchema : { type: "object" },
    }));
}

function findServer(servers, serverName) {
  const found = servers.find((item) => item?.name === serverName);
  if (!found) throw new RootboundToolError(`MCP server '${serverName}' is not registered in Codex.`, {
    code: "LOCAL_MCP_SERVER_NOT_FOUND", category: "state", nextActions: ["Check the MCP configuration in Codex and restart Rootbound if it changed."],
  });
  if (found.error) throw new RootboundToolError(`MCP server '${serverName}' is unavailable.`, {
    code: "LOCAL_MCP_SERVER_UNAVAILABLE", category: "state", nextActions: ["Check this server locally in Codex."],
  });
  return found;
}

export function registerLocalMcpTools(server, { context, authorityExecutor, projectAccessProvider, paths }) {
  if (!context?.localMcpServers || !context?.localMcpCall || !authorityExecutor || !projectAccessProvider || !paths) {
    throw new Error("Local MCP tools require a scoped context, authority, project access and state paths");
  }

  async function authorized(inputCwd) {
    const access = await projectAccessProvider();
    const connectionId = assertLocalMcpConnectionId(access.connectionId);
    if (access.enforced !== true) {
      throw new RootboundToolError("Local MCP requires a connection-scoped runtime.", { code: "LOCAL_MCP_CONNECTION_REQUIRED", category: "permission" });
    }
    const authority = await authorityExecutor.resolveAuthority({ cwd: inputCwd ?? null, access: "readOnly", timeoutMs: 10_000 });
    if (!authority?.effectiveCwd) throw new Error("No authorized workspace for local MCP execution");
    return { cwd: authority.effectiveCwd, connectionId };
  }

  server.registerTool("local_mcp.list_servers", {
    title: "List Locally Configured Codex MCP Servers",
    description: "Discover Codex-configured MCP servers in the authorized project context without returning environment variables, secrets or connection URLs. Never starts a Codex model turn. Tool execution requires separate local approval.",
    inputSchema: z.object({ cwd }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ cwd: requestedCwd }) => typedToolResponse(async () => {
    const scope = await authorized(requestedCwd);
    const grants = await readLocalMcpGrants({ paths, connectionId: scope.connectionId });
    const discovered = await context.localMcpServers({ cwd: scope.cwd });
    return {
      status: "ok", cwd: scope.cwd, connectionId: scope.connectionId,
      servers: discovered.map((item) => ({
        name: item.name,
        available: !item.error,
        toolCount: toolList(item).length,
        allToolsAllowed: grants[item.name]?.all === true,
        permittedTools: toolList(item).filter((tool) => isLocalMcpToolAllowed(grants, item.name, tool.name)).map((tool) => tool.name),
      })), modelTurnStarted: false,
    };
  }, { operation: "local_mcp.list_servers" }));

  server.registerTool("local_mcp.list_tools", {
    title: "Inspect Tools From a Local MCP Server",
    description: "Read tools and JSON input schemas published by one Codex-configured local MCP server. The remote caller cannot configure or launch an arbitrary server.",
    inputSchema: z.object({ server: name, cwd }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ server: serverName, cwd: requestedCwd }) => typedToolResponse(async () => {
    assertLocalMcpIdentifier(serverName, "server");
    const scope = await authorized(requestedCwd);
    const grants = await readLocalMcpGrants({ paths, connectionId: scope.connectionId });
    const target = findServer(await context.localMcpServers({ cwd: scope.cwd }), serverName);
    const tools = toolList(target).map((tool) => ({ ...tool, permitted: isLocalMcpToolAllowed(grants, serverName, tool.name) }));
    if (Buffer.byteLength(JSON.stringify(tools)) > 200_000) throw new RootboundToolError("MCP tool catalogue exceeds the response limit.", { code: "LOCAL_MCP_CATALOG_TOO_LARGE" });
    return { status: "ok", server: serverName, cwd: scope.cwd, tools, modelTurnStarted: false };
  }, { operation: "local_mcp.list_tools" }));

  server.registerTool("local_mcp.call_tool", {
    title: "Call a Locally Authorized MCP Tool",
    description: "Invoke exactly one explicitly locally approved tool from a Codex-configured MCP server in an authorized project. The selected tool may make external or destructive changes; permissions are checked afresh on every invocation. No Codex model turn is started.",
    inputSchema: z.object({ server: name, tool: name, arguments: z.record(z.string(), z.unknown()).default({}), cwd }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, async ({ server: serverName, tool: toolName, arguments: args, cwd: requestedCwd }) => {
    return typedToolResponse(async () => {
      assertLocalMcpIdentifier(serverName, "server");
      assertLocalMcpIdentifier(toolName, "tool");
      if (Buffer.byteLength(JSON.stringify(args)) > 64_000) throw new RootboundToolError("MCP tool arguments exceed 64 KB.", { code: "LOCAL_MCP_ARGUMENTS_TOO_LARGE" });
      const scope = await authorized(requestedCwd);
      const grants = await readLocalMcpGrants({ paths, connectionId: scope.connectionId });
      if (!isLocalMcpToolAllowed(grants, serverName, toolName)) {
        throw new RootboundToolError(`MCP tool '${serverName}/${toolName}' has not been approved locally.`, {
          code: "LOCAL_MCP_TOOL_NOT_ALLOWED", category: "permission", retryable: false,
          nextActions: [`On your Mac, run: rootbound mcp allow ${serverName} [${toolName}]`],
        });
      }
      const target = findServer(await context.localMcpServers({ cwd: scope.cwd }), serverName);
      if (!toolList(target).some((tool) => tool.name === toolName)) {
        throw new RootboundToolError(`MCP tool '${serverName}/${toolName}' is not exposed by this server.`, { code: "LOCAL_MCP_TOOL_NOT_FOUND", category: "state" });
      }
      const result = await context.localMcpCall({ cwd: scope.cwd, server: serverName, tool: toolName, arguments: args });
      if (Buffer.byteLength(JSON.stringify(result)) > maxResponseBytes) {
        throw new RootboundToolError("MCP tool response exceeds 2 MB; narrow the request.", { code: "LOCAL_MCP_RESPONSE_TOO_LARGE", category: "runtime" });
      }
      return { status: result?.isError === true ? "failed" : "ok", server: serverName, tool: toolName, result, modelTurnStarted: false };
    }, { operation: "local_mcp.call_tool", isError: (payload) => payload.status === "failed" });
  });
}
