import { randomBytes } from "node:crypto";
import { chmod, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { ensureRootboundStateDirs } from "./state-paths.mjs";
import { isProcessAlive } from "./runtime-state.mjs";

const SCHEMA_VERSION = 1;
const NAME_PATTERN = /^[^\u0000-\u001f\u007f]{1,48}$/;
const TUNNEL_ID_PATTERN = /^tunnel_[0-9a-f]{32}$/;

export async function loadConnectionRegistry({ paths, initializeLegacy = true, now = Date.now } = {}) {
  if (!paths?.connectionRegistryPath) throw new Error("connection registry requires Rootbound paths");
  await ensureRootboundStateDirs(paths);
  try {
    const registry = await readRegistry(paths);
    if (!initializeLegacy || registry.connections.length > 0 || !await fileExists(paths.tunnelConfigPath)) return registry;
    return withRegistryLock(paths, async () => {
      const current = await readRegistry(paths);
      if (current.connections.length > 0 || !await fileExists(paths.tunnelConfigPath)) return current;
      const reconciled = await buildInitialRegistry(paths, now);
      await writeRegistryUnlocked(paths, reconciled, process.platform);
      return reconciled;
    });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    if (!initializeLegacy) return null;
  }
  return withRegistryLock(paths, async () => {
    try {
      const current = await readRegistry(paths);
      if (current.connections.length > 0 || !await fileExists(paths.tunnelConfigPath)) return current;
      const reconciled = await buildInitialRegistry(paths, now);
      await writeRegistryUnlocked(paths, reconciled, process.platform);
      return reconciled;
    } catch (error) { if (error?.code !== "ENOENT") throw error; }
    const registry = await buildInitialRegistry(paths, now);
    await writeRegistryUnlocked(paths, registry, process.platform);
    return registry;
  });
}

export async function writeConnectionRegistry({ paths, registry, platform = process.platform } = {}) {
  const value = validateRegistry(registry);
  await ensureRootboundStateDirs(paths);
  return withRegistryLock(paths, async () => writeRegistryUnlocked(paths, value, platform));
}

export function validateConnectionName(value) {
  const name = typeof value === "string" ? value.trim() : "";
  if (!NAME_PATTERN.test(name)) throw registryError("CONNECTION_NAME_INVALID", "Connection name must be 1-48 printable characters.");
  return name;
}

export function createConnectionId() { return `connection_${randomBytes(12).toString("hex")}`; }

export function getConnection(registry, selector) {
  if (!registry || !selector) return null;
  const normalized = String(selector).trim();
  if (normalized.startsWith("connection_")) return registry.connections.find((entry) => entry.id === normalized) ?? null;
  const lower = normalized.toLowerCase();
  return registry.connections.find((entry) => entry.name.toLowerCase() === lower) ?? null;
}

export function getActiveConnection(registry) {
  return registry?.activeConnectionId ? registry.connections.find((entry) => entry.id === registry.activeConnectionId) ?? null : null;
}

export async function addConnection({ paths, id = null, name, storageKind = "scoped-v1", source = "guided", tunnelId = null, makeActive = false, now = Date.now } = {}) {
  await ensureRootboundStateDirs(paths);
  return withRegistryLock(paths, async () => {
    const registry = await readOrInitializeRegistryUnlocked(paths, now);
    const safeName = validateConnectionName(name);
    if (getConnection(registry, safeName)) throw registryError("CONNECTION_NAME_CONFLICT", `Connection already exists: ${safeName}`);
    const connectionId = id ?? createConnectionId();
    if (!/^connection_[0-9a-f]{24}$/.test(connectionId) || getConnection(registry, connectionId)) throw registryError("CONNECTION_ID_INVALID", "Connection id is invalid or already exists.");
    if (tunnelId !== null && !TUNNEL_ID_PATTERN.test(tunnelId)) throw registryError("CONNECTION_TUNNEL_ID_INVALID", "Connection tunnel id must be tunnel_ followed by 32 lowercase hexadecimal characters.");
    const timestamp = now();
    const connection = { id: connectionId, name: safeName, storageKind, source, tunnelId, createdAt: timestamp, updatedAt: timestamp, lastUsedAt: null };
    const next = validateRegistry({ ...registry, connections: [...registry.connections, connection], activeConnectionId: registry.activeConnectionId ?? (makeActive || registry.connections.length === 0 ? connection.id : null) });
    await writeRegistryUnlocked(paths, next, process.platform);
    return { registry: next, connection };
  });
}

export async function setActiveConnection({ paths, selector, now = Date.now } = {}) {
  await ensureRootboundStateDirs(paths);
  return withRegistryLock(paths, async () => {
    const registry = await readOrInitializeRegistryUnlocked(paths, now);
    const connection = getConnection(registry, selector);
    if (!connection) throw registryError("CONNECTION_NOT_FOUND", `No connection matches: ${selector}`);
    const timestamp = now();
    const connections = registry.connections.map((entry) => entry.id === connection.id ? { ...entry, lastUsedAt: timestamp, updatedAt: timestamp } : entry);
    const next = validateRegistry({ ...registry, activeConnectionId: connection.id, connections });
    await writeRegistryUnlocked(paths, next, process.platform);
    return { registry: next, connection: connections.find((entry) => entry.id === connection.id) };
  });
}

export async function removeConnection({ paths, selector } = {}) {
  await ensureRootboundStateDirs(paths);
  return withRegistryLock(paths, async () => {
    const registry = await readOrInitializeRegistryUnlocked(paths, Date.now);
    const connection = getConnection(registry, selector);
    if (!connection) throw registryError("CONNECTION_NOT_FOUND", `No connection matches: ${selector}`);
    const connections = registry.connections.filter((entry) => entry.id !== connection.id);
    const activeConnectionId = registry.activeConnectionId === connection.id ? (connections[0]?.id ?? null) : registry.activeConnectionId;
    const next = validateRegistry({ ...registry, activeConnectionId, connections });
    await writeRegistryUnlocked(paths, next, process.platform);
    return { registry: next, connection, activeConnectionId };
  });
}

async function readOrInitializeRegistryUnlocked(paths, now) {
  try {
    const current = await readRegistry(paths);
    if (current.connections.length === 0 && await fileExists(paths.tunnelConfigPath)) {
      const reconciled = await buildInitialRegistry(paths, now);
      await writeRegistryUnlocked(paths, reconciled, process.platform);
      return reconciled;
    }
    return current;
  } catch (error) { if (error?.code !== "ENOENT") throw error; }
  const registry = await buildInitialRegistry(paths, now);
  await writeRegistryUnlocked(paths, registry, process.platform);
  return registry;
}

async function buildInitialRegistry(paths, now) {
  const legacyConfigured = await fileExists(paths.tunnelConfigPath);
  const createdAt = now();
  const connection = legacyConfigured ? {
    id: createConnectionId(), name: "default", storageKind: "legacy-global", source: "legacy",
    tunnelId: null, createdAt, updatedAt: createdAt, lastUsedAt: null,
  } : null;
  return validateRegistry({ schemaVersion: SCHEMA_VERSION, activeConnectionId: connection?.id ?? null, connections: connection ? [connection] : [] });
}

async function readRegistry(paths) {
  let raw;
  try { raw = await readFile(paths.connectionRegistryPath, "utf8"); }
  catch (error) { if (error?.code === "ENOENT") throw error; throw error; }
  try { return validateRegistry(JSON.parse(raw)); }
  catch (error) {
    if (error instanceof SyntaxError) throw registryError("CONNECTION_REGISTRY_INVALID", `Invalid connection registry: ${paths.connectionRegistryPath}`);
    throw error;
  }
}

async function writeRegistryUnlocked(paths, value, platform) {
  const registry = validateRegistry(value);
  const temp = `${paths.connectionRegistryPath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  const handle = await open(temp, "w", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(registry, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally { await handle.close(); }
  if (platform !== "win32") await chmod(temp, 0o600);
  await rename(temp, paths.connectionRegistryPath);
  if (platform !== "win32") await chmod(paths.connectionRegistryPath, 0o600);
  await fsyncParent(path.dirname(paths.connectionRegistryPath));
  return registry;
}

function validateRegistry(value) {
  if (!value || value.schemaVersion !== SCHEMA_VERSION || !Array.isArray(value.connections)) throw registryError("CONNECTION_REGISTRY_INVALID", "Unsupported connection registry schema.");
  const names = new Set(); const ids = new Set();
  for (const entry of value.connections) {
    if (!entry || typeof entry.id !== "string" || !/^connection_[0-9a-f]{24}$/.test(entry.id)) throw registryError("CONNECTION_REGISTRY_INVALID", "Connection registry contains an invalid id.");
    const name = validateConnectionName(entry.name); const lower = name.toLowerCase();
    if (names.has(lower) || ids.has(entry.id)) throw registryError("CONNECTION_REGISTRY_INVALID", "Connection registry contains duplicate connections.");
    if (!new Set(["legacy-global", "scoped-v1"]).has(entry.storageKind)) throw registryError("CONNECTION_REGISTRY_INVALID", "Connection registry contains an invalid storage kind.");
    if (entry.tunnelId !== null && entry.tunnelId !== undefined && !TUNNEL_ID_PATTERN.test(entry.tunnelId)) throw registryError("CONNECTION_REGISTRY_INVALID", "Connection registry contains an invalid tunnel id.");
    names.add(lower); ids.add(entry.id);
  }
  if (value.activeConnectionId !== null && value.activeConnectionId !== undefined && !ids.has(value.activeConnectionId)) throw registryError("CONNECTION_REGISTRY_INVALID", "Active connection does not exist in the registry.");
  return value;
}

async function withRegistryLock(paths, fn) {
  const lockPath = paths.connectionRegistryLockPath;
  let lock;
  try { lock = await open(lockPath, "wx", 0o600); }
  catch (error) {
    if (error?.code !== "EEXIST") throw error;
    let owner = null;
    try { owner = JSON.parse(await readFile(lockPath, "utf8")); } catch {}
    if (Number.isInteger(owner?.pid) && isProcessAlive(owner.pid)) throw registryError("CONNECTION_REGISTRY_BUSY", `Connection registry is being modified by pid ${owner.pid}.`);
    await unlink(lockPath).catch((unlinkError) => { if (unlinkError?.code !== "ENOENT") throw unlinkError; });
    try { lock = await open(lockPath, "wx", 0o600); }
    catch (retryError) { if (retryError?.code === "EEXIST") throw registryError("CONNECTION_REGISTRY_BUSY", "Connection registry is being modified by another process."); throw retryError; }
  }
  try {
    await lock.writeFile(`${JSON.stringify({ pid: process.pid, createdAt: Date.now() })}\n`);
    await lock.sync();
    return await fn();
  } finally {
    await lock.close().catch(() => {});
    await unlink(lockPath).catch((error) => { if (error?.code !== "ENOENT") throw error; });
  }
}

async function fsyncParent(dir) { try { const handle = await open(dir, "r"); try { await handle.sync(); } finally { await handle.close(); } } catch {} }
async function fileExists(target) { try { await readFile(target); return true; } catch (error) { if (error?.code === "ENOENT") return false; throw error; } }
function registryError(code, message) { const error = new Error(message); error.code = code; return error; }
