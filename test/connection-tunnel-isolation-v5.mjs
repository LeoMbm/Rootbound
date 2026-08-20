import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { addConnection, setActiveConnection } from "../src/connection-registry.mjs";
import { resolveConnectionPaths } from "../src/connection-paths.mjs";
import { resolveRootboundPaths } from "../src/state-paths.mjs";
import { clearTunnelConfig, saveTunnelConfig, tunnelConfigStatus } from "../src/tunnel-config.mjs";

const root = await mkdtemp(path.join(os.tmpdir(), "rootbound-connection-isolation-"));
const paths = resolveRootboundPaths({ env: { ROOTBOUND_HOME: path.join(root, "state") } });

const a = await addConnection({ paths, name: "alpha", tunnelId: "tunnel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", makeActive: true });
const b = await addConnection({ paths, name: "beta", tunnelId: "tunnel_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" });
const aPaths = resolveConnectionPaths({ paths, connection: a.connection });
const bPaths = resolveConnectionPaths({ paths, connection: b.connection });

await saveTunnelConfig({ argv: ["alpha-client", "--stdio"], paths: aPaths });
await saveTunnelConfig({ argv: ["beta-client", "--stdio"], paths: bPaths });

let status = tunnelConfigStatus({ paths, env: {} });
assert.equal(status.connectionId, a.connection.id);
assert.equal(status.argv[0], "alpha-client");

await setActiveConnection({ paths, selector: b.connection.id });
status = tunnelConfigStatus({ paths, env: {} });
assert.equal(status.connectionId, b.connection.id);
assert.equal(status.argv[0], "beta-client");

await clearTunnelConfig({ paths: bPaths });
assert.equal(tunnelConfigStatus({ paths: bPaths, env: {} }).configured, false);
assert.equal(tunnelConfigStatus({ paths: aPaths, env: {} }).configured, true, "clearing beta must not clear alpha");

console.log("connection-tunnel-isolation-v5: ok");
