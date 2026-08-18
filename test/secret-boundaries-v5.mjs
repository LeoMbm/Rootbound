import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readManyAuthorized } from "../src/construction-tools.mjs";
import { assertDurableCommandHasNoSecrets, inspectSensitiveArgv, isSensitivePath, redactArgv, summarizeRedactedArgv } from "../src/secret-boundaries.mjs";

const argv = ["curl", "--token", "super-secret-token-value", "https://example.test"];
const findings = inspectSensitiveArgv(argv);
assert.equal(findings.length, 1);
assert.equal(findings[0].index, 2);
const redacted = redactArgv(argv);
assert.equal(redacted[2], "<redacted>");
assert.equal(redacted.join(" ").includes("super-secret-token-value"), false);
assert.equal(summarizeRedactedArgv(argv).includes("super-secret-token-value"), false);
assert.throws(
  () => assertDurableCommandHasNoSecrets(argv),
  (error) => error?.code === "SECRET_PERSISTENCE_BLOCKED" && error?.category === "safety" && JSON.stringify(error?.details ?? {}).includes("super-secret-token-value") === false
);

assert.equal(isSensitivePath(".env"), true);
assert.equal(isSensitivePath(".env.production"), true);
assert.equal(isSensitivePath("config/credentials.json"), true);
assert.equal(isSensitivePath("keys/id_ed25519"), true);
assert.equal(isSensitivePath("certs/server.pem"), true);
assert.equal(isSensitivePath("src/app.js"), false);
assert.doesNotThrow(() => assertDurableCommandHasNoSecrets(["npm", "test"]));

const root = await mkdtemp(path.join(os.tmpdir(), "codexless-sensitive-read-"));
const envFile = path.join(root, ".env");
await writeFile(envFile, "API_KEY=very-secret\n", "utf8");
const authorityExecutor = {
  async resolveAuthority({ cwd }) { return { effectiveCwd: cwd, trustedAncestor: cwd, permissionProfile: ":read-only" }; },
  async exec({ command }) {
    return { exitCode: 0, stdout: await readFile(command[3], "utf8"), stderr: "", stdoutTruncated: false };
  },
};
await assert.rejects(
  () => readManyAuthorized({ authorityExecutor, paths: [".env"], cwd: root }),
  (error) => error?.code === "SENSITIVE_READ_REQUIRES_OPT_IN" && error?.category === "safety"
);
const sensitiveRead = await readManyAuthorized({ authorityExecutor, paths: [".env"], cwd: root, allowSensitive: true });
assert.equal(sensitiveRead.files[0].text, "API_KEY=very-secret\n");
assert.equal(sensitiveRead.allowSensitive, true);

console.log("secret-boundaries-v5: ok");
