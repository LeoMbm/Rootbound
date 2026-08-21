import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { acceptedCodexVersionsFor } from "../src/codex-authority-executor.mjs";

const mac = acceptedCodexVersionsFor({ platform: "darwin", arch: "arm64" });
assert.equal(mac.includes("0.149.0-alpha.4"), true, "the locally capability-probed ChatGPT bundled build must be accepted on Apple Silicon macOS");
assert.equal(mac.includes("0.148.0-alpha.15"), true);
assert.equal(mac.includes("0.148.0-alpha.9"), true);
assert.equal(mac.some((version) => version.startsWith("0.150.")), false, "unprobed future Codex builds must remain fail-closed");

const registry = JSON.parse(await readFile(path.resolve(import.meta.dirname, "../config/toolbox-method-registry.json"), "utf8"));
assert.equal(registry.verifiedCodexVersion, "0.149.0-alpha.4");
assert.equal(registry.verifiedAt, "2026-08-21");
assert.deepEqual(registry.additionalAcceptedCodexVersions, ["0.148.0-alpha.15", "0.148.0-alpha.9"]);
assert.equal(registry.defaultAction, "deny");

console.log("codex-version-policy-v5: ok");
