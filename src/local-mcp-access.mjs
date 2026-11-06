import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { isProcessAlive } from "./runtime-state.mjs";
import { RootboundToolError } from "./tool-errors.mjs";

const CONNECTION_ID = /^connection_[0-9a-f]{24}$/;
const IDENTIFIER = /^[A-Za-z0-9_.:/@-]{1,256}$/;

function accessPath(paths) {
  if (!paths?.stateDir) throw new Error("local MCP grants require Rootbound state paths");
  return path.join(paths.stateDir, "local-mcp-grants.json");
}

export function assertLocalMcpConnectionId(connectionId) {
  if (!CONNECTION_ID.test(connectionId ?? "")) {
    throw new RootboundToolError("Local MCP tools require an active saved Rootbound connection.", {
      code: "LOCAL_MCP_CONNECTION_REQUIRED", category: "permission", retryable: false,
      nextActions: ["Select a saved Rootbound connection, then retry."],
    });
  }
  return connectionId;
}

export function assertLocalMcpIdentifier(value, label) {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    throw new RootboundToolError(`Invalid local MCP ${label}.`, { code: "LOCAL_MCP_INVALID_NAME", category: "configuration" });
  }
  return value;
}

function validateGrants(value) {
  if (!value || value.schemaVersion !== 1 || !value.connections || typeof value.connections !== "object" || Array.isArray(value.connections)) {
    throw new RootboundToolError("Invalid local MCP grants file.", { code: "LOCAL_MCP_GRANTS_INVALID", category: "configuration" });
  }
  for (const [connectionId, servers] of Object.entries(value.connections)) {
    assertLocalMcpConnectionId(connectionId);
    if (!servers || typeof servers !== "object" || Array.isArray(servers)) throw new Error("Invalid local MCP server grants");
    for (const [server, tools] of Object.entries(servers)) {
      assertLocalMcpIdentifier(server, "server");
      if (!Array.isArray(tools) || tools.length > 256 || new Set(tools).size !== tools.length) throw new Error("Invalid local MCP tool grants");
      tools.forEach((tool) => assertLocalMcpIdentifier(tool, "tool"));
    }
  }
  return value;
}

export async function readLocalMcpGrants({ paths, connectionId }) {
  assertLocalMcpConnectionId(connectionId);
  try {
    const parsed = validateGrants(JSON.parse(await readFile(accessPath(paths), "utf8")));
    return structuredClone(parsed.connections[connectionId] ?? {});
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    if (error instanceof SyntaxError) throw new RootboundToolError("Malformed local MCP grants file.", { code: "LOCAL_MCP_GRANTS_INVALID", category: "configuration" });
    throw error;
  }
}

// Local control-plane only. The public MCP surface never calls this mutation.
export async function setLocalMcpGrant({ paths, connectionId, server, tool, allowed }) {
  assertLocalMcpConnectionId(connectionId);
  assertLocalMcpIdentifier(server, "server");
  assertLocalMcpIdentifier(tool, "tool");
  const target = accessPath(paths);
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const lock = `${target}.lock`;
  const lockHandle = await acquireGrantLock(lock);
  try {
    let current;
    try { current = validateGrants(JSON.parse(await readFile(target, "utf8"))); }
    catch (error) {
      if (error?.code !== "ENOENT") throw error;
      current = { schemaVersion: 1, connections: {} };
    }
    const connection = { ...(current.connections[connectionId] ?? {}) };
    const tools = new Set(connection[server] ?? []);
    if (allowed) tools.add(tool);
    else tools.delete(tool);
    if (tools.size) connection[server] = [...tools].sort();
    else delete connection[server];
    if (Object.keys(connection).length) current.connections[connectionId] = connection;
    else delete current.connections[connectionId];
    validateGrants(current);
    const temp = `${target}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temp, "wx", 0o600);
      try { await handle.writeFile(`${JSON.stringify(current, null, 2)}\n`, "utf8"); await handle.sync(); }
      finally { await handle.close(); }
      await rename(temp, target);
    } finally { await unlink(temp).catch(() => {}); }
    return { connectionId, server, tool, allowed, grants: connection };
  } finally {
    await lockHandle.close();
    await unlink(lock).catch(() => {});
  }
}

async function acquireGrantLock(lock) {
  const deadline = Date.now() + 2_000;
  while (true) {
    try {
      const handle = await open(lock, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid }));
        await handle.sync();
      } catch (error) {
        await handle.close().catch(() => {});
        await unlink(lock).catch(() => {});
        throw error;
      }
      return handle;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      // Avoid deleting a freshly created lock before its owner writes the PID.
      const details = await stat(lock).catch(() => null);
      if (details && Date.now() - details.mtimeMs > 5_000) {
        let owner = null;
        try { owner = JSON.parse(await readFile(lock, "utf8")); } catch {}
        if (!Number.isInteger(owner?.pid) || !isProcessAlive(owner.pid)) {
          await unlink(lock).catch((unlinkError) => { if (unlinkError?.code !== "ENOENT") throw unlinkError; });
          continue;
        }
      }
      if (Date.now() >= deadline) {
        throw new RootboundToolError("Local MCP grants are being updated; retry.", { code: "LOCAL_MCP_GRANTS_BUSY", category: "transient", retryable: true });
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}
