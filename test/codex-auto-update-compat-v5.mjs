import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { canCapabilityProbeUnknownCodex, parseCodexVersion } from "../src/codex-compatibility.mjs";

const root = path.resolve(import.meta.dirname, "..");

assert.equal(parseCodexVersion("codex-cli 0.150.0-alpha.3"), "0.150.0-alpha.3");
assert.equal(parseCodexVersion("noise\ncodex-cli 0.149.0-alpha.4\n"), "0.149.0-alpha.4");
assert.equal(parseCodexVersion("not-codex"), null);

assert.equal(canCapabilityProbeUnknownCodex({ platform: "darwin", arch: "arm64" }), true);
assert.equal(canCapabilityProbeUnknownCodex({ platform: "darwin", arch: "x64" }), false);
assert.equal(canCapabilityProbeUnknownCodex({ platform: "win32", arch: "x64" }), false);
assert.equal(canCapabilityProbeUnknownCodex({ platform: "linux", arch: "x64" }), false);

const publicRuntime = await readFile(path.join(root, "src", "public-runtime.mjs"), "utf8");
const doctor = await readFile(path.join(root, "scripts", "doctor.mjs"), "utf8");
const resolver = await readFile(path.join(root, "scripts", "resolve-codex.mjs"), "utf8");
const compatibility = await readFile(path.join(root, "src", "codex-compatibility.mjs"), "utf8");

assert.match(publicRuntime, /resolveCompatibleCodexRuntime/);
assert.match(doctor, /resolveCompatibleCodexRuntime/);
assert.match(resolver, /acceptedVersions:\s*null/);
assert.match(compatibility, /acceptedVersions:\s*null/);
assert.match(compatibility, /runtime-capability-probe/);
assert.match(compatibility, /permissionProfile !== ":read-only"/);
assert.match(compatibility, /authority\.trustedAncestor/);
assert.match(compatibility, /access:\s*"readOnly"/);
assert.doesNotMatch(compatibility, /writeFile|appendFile|rename|unlink/);

console.log("codex-auto-update-compat-v5: ok");
