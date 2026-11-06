import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { isProcessAlive } from "./runtime-state.mjs";
import { RootboundToolError } from "./tool-errors.mjs";

const CONNECTION_ID = /^connection_[0-9a-f]{24}$/;
const IDENTIFIER = /^[A-Za-z0-9_.:/@-]{1,256}$/;
const SCHEMA_VERSION = 2;
const MAX_TOOLS = 256;

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

function validateToolNames(tools) {
  if (!Array.isArray(tools) || tools.length > MAX_TOOLS || new Set(tools).size !== tools.length) {
    throw new RootboundToolError("Invalid local MCP tool grants.", { code: "LOCAL_MCP_GRANTS_INVALID", category: "configuration" });
  }
  for (const tool of tools) assertLocalMcpIdentifier(tool, "tool");
  return [...tools];
}

function validateGrants(value) {
  if (!value || ![1, SCHEMA_VERSION].includes(value.schemaVersion) || !value.connections || typeof value.connections !== "object" || Array.isArray(value.connections)) {
    throw new RootboundToolError("Invalid local MCP grants file.", { code: "LOCAL_MCP_GRANTS_INVALID", category: "configuration" });
  }
  const connections = Object.create(null);
  for (const [connectionId, servers] of Object.entries(value.connections)) {
    assertLocalMcpConnectionId(connectionId);
    if (!servers || typeof servers !== "object" || Array.isArray(servers)) throw new Error("Invalid local MCP server grants");
    const policies = Object.create(null);
    for (const [server, policy] of Object.entries(servers)) {
      assertLocalMcpIdentifier(server, "server");
      if (value.schemaVersion === 1) {
        policies[server] = { all: false, allow: validateToolNames(policy), deny: [] };
        continue;
      }
      if (!policy || typeof policy !== "object" || Array.isArray(policy)
        || typeof policy.all !== "boolean" || !Array.isArray(policy.allow) || !Array.isArray(policy.deny)
        || Object.keys(policy).some((key) => !["all", "allow", "deny"].includes(key))) {
        throw new RootboundToolError("Invalid local MCP server policy.", { code: "LOCAL_MCP_GRANTS_INVALID", category: "configuration" });
      }
      const allow = validateToolNames(policy.allow);
      const deny = validateToolNames(policy.deny);
      if ((policy.all && allow.length) || (!policy.all && deny.length) || allow.some((tool) => deny.includes(tool))) {
        throw new RootboundToolError("Contradictory local MCP permissions.", { code: "LOCAL_MCP_GRANTS_INVALID", category: "configuration" });
      }
      policies[server] = { all: policy.all, allow, deny };
    }
    connections[connectionId] = policies;
  }
  return { schemaVersion: SCHEMA_VERSION, connections };
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

export function isLocalMcpToolAllowed(grants, server, tool) {
  const policy = Object.hasOwn(grants, server) ? grants[server] : null;
  return Boolean(policy && (policy.all ? !policy.deny.includes(tool) : policy.allow.includes(tool)));
}

// Local control-plane only. The public MCP surface never calls this mutation.
export async function setLocalMcpGrant({ paths, connectionId, server, tool = null, allowed }) {
  assertLocalMcpConnectionId(connectionId);
  assertLocalMcpIdentifier(server, "server");
  if (tool !== null) assertLocalMcpIdentifier(tool, "tool");
  if (typeof allowed !== "boolean") throw new Error("allowed must be a boolean");
  const target = accessPath(paths);
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const lock = `${target}.lock`;
  const lockHandle = await acquireGrantLock(lock);
  try {
    let current;
    try { current = validateGrants(JSON.parse(await readFile(target, "utf8"))); }
    catch (error) {
      if (error?.code !== "ENOENT") throw error;
      current = { schemaVersion: SCHEMA_VERSION, connections: Object.create(null) };
    }
    const connection = Object.assign(Object.create(null), current.connections[connectionId] ?? {});
    const previous = connection[server] ?? { all: false, allow: [], deny: [] };
    let next = null;
    if (tool === null) {
      // Whole-server operations override prior tool-level decisions.
      if (allowed) next = { all: true, allow: [], deny: [] };
    } else if (previous.all) {
      next = { all: true, allow: [], deny: [...new Set(allowed
        ? previous.deny.filter((name) => name !== tool)
        : [...previous.deny, tool])].sort() };
    } else {
      next = { all: false, allow: [...new Set(allowed
        ? [...previous.allow, tool]
        : previous.allow.filter((name) => name !== tool))].sort(), deny: [] };
    }
    if (next && (next.all || next.allow.length)) connection[server] = next;
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
