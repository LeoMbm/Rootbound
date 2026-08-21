import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { addConnection, getActiveConnection, getConnection, loadConnectionRegistry, setActiveConnection, validateConnectionName } from "../src/connection-registry.mjs";
import { resolveConnectionPaths } from "../src/connection-paths.mjs";
import { resolveRootboundPaths } from "../src/state-paths.mjs";

const root = await mkdtemp(path.join(os.tmpdir(), "rootbound-connections-"));
const paths = resolveRootboundPaths({ env: { ROOTBOUND_HOME: path.join(root, "state") } });
await mkdir(paths.stateDir, { recursive: true });
await writeFile(paths.tunnelConfigPath, `${JSON.stringify({ schemaVersion: 1, argv: ["tunnel-client", "run"] })}\n`, "utf8");

const legacy = await loadConnectionRegistry({ paths, now: () => 10 });
assert.equal(legacy.connections.length, 1);
assert.equal(legacy.connections[0].name, "default");
assert.equal(legacy.connections[0].storageKind, "legacy-global");
assert.equal(getActiveConnection(legacy)?.id, legacy.connections[0].id);

const defaultPaths = resolveConnectionPaths({ paths, connection: legacy.connections[0] });
assert.equal(defaultPaths.tunnelConfigPath, paths.tunnelConfigPath);
assert.equal(defaultPaths.tunnelSecretPath, paths.tunnelSecretPath);

const added = await addConnection({ paths, name: "Work", now: () => 20 });
assert.equal(added.connection.storageKind, "scoped-v1");
assert.equal(added.registry.activeConnectionId, legacy.activeConnectionId, "adding a second connection must not silently switch active connection");
assert.equal(getConnection(added.registry, "work")?.id, added.connection.id);
await assert.rejects(() => addConnection({ paths, name: "WORK" }), (error) => error?.code === "CONNECTION_NAME_CONFLICT");

const scoped = resolveConnectionPaths({ paths, connection: added.connection });
assert.notEqual(scoped.tunnelConfigPath, paths.tunnelConfigPath);
assert.match(scoped.tunnelConfigPath, new RegExp(added.connection.id));

const switched = await setActiveConnection({ paths, selector: "work", now: () => 30 });
assert.equal(switched.registry.activeConnectionId, added.connection.id);
assert.equal(switched.connection.lastUsedAt, 30);

assert.equal(validateConnectionName(" client "), "client");
assert.throws(() => validateConnectionName("\n"), (error) => error?.code === "CONNECTION_NAME_INVALID");
assert.throws(() => validateConnectionName("x".repeat(49)), (error) => error?.code === "CONNECTION_NAME_INVALID");

const persisted = JSON.parse(await readFile(paths.connectionRegistryPath, "utf8"));
assert.equal(persisted.connections.length, 2);
assert.equal(JSON.stringify(persisted).includes("api_key"), false);

const lateRoot = await mkdtemp(path.join(os.tmpdir(), "rootbound-connections-late-"));
const latePaths = resolveRootboundPaths({ env: { ROOTBOUND_HOME: path.join(lateRoot, "state") } });
const empty = await loadConnectionRegistry({ paths: latePaths, now: () => 40 });
assert.equal(empty.connections.length, 0, "listing connections before first connect may create an empty registry");
await writeFile(latePaths.tunnelConfigPath, `${JSON.stringify({ schemaVersion: 1, argv: ["tunnel-client", "run"] })}\n`, "utf8");
const reconciled = await loadConnectionRegistry({ paths: latePaths, now: () => 50 });
assert.equal(reconciled.connections.length, 1, "later legacy tunnel creation must be reconciled into the registry");
assert.equal(reconciled.connections[0].name, "default");
assert.equal(reconciled.activeConnectionId, reconciled.connections[0].id);

console.log("connection-registry-v5: ok");
