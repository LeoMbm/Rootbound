import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { preciseEditAuthorized, readManyAuthorized } from "../src/construction-tools.mjs";
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

for (const sensitiveArgv of [
  ["env", "API_KEY=assignment-secret", "node", "build.mjs"],
  ["curl", "https://user:password-secret@example.test/private"],
  ["curl", "https://example.test/?token=query-secret"],
  ["curl", "-H", "Authorization: Bearer bearer-secret"],
]) {
  const sensitiveFindings = inspectSensitiveArgv(sensitiveArgv);
  assert.ok(sensitiveFindings.length > 0, `expected secret detection for ${JSON.stringify(sensitiveArgv)}`);
  const safe = redactArgv(sensitiveArgv).join(" ");
  for (const secret of ["assignment-secret", "password-secret", "query-secret", "bearer-secret"]) assert.equal(safe.includes(secret), false);
  assert.throws(() => assertDurableCommandHasNoSecrets(sensitiveArgv), (error) => error?.code === "SECRET_PERSISTENCE_BLOCKED");
}

assert.equal(isSensitivePath(".env"), true);
assert.equal(isSensitivePath(".env.production"), true);
assert.equal(isSensitivePath("config/credentials.json"), true);
assert.equal(isSensitivePath("keys/id_ed25519"), true);
assert.equal(isSensitivePath("certs/server.pem"), true);
assert.equal(isSensitivePath("src/app.js"), false);
assert.doesNotThrow(() => assertDurableCommandHasNoSecrets(["npm", "test"]));

const root = await mkdtemp(path.join(os.tmpdir(), "rootbound-sensitive-read-"));
const envFile = path.join(root, ".env");
await writeFile(envFile, "API_KEY=very-secret\n", "utf8");
const authorityExecutor = {
  async resolveAuthority({ cwd, access }) {
    return { effectiveCwd: cwd, trustedAncestor: cwd, permissionProfile: access === "readOnly" ? ":read-only" : ":workspace", permissionCeiling: ":workspace" };
  },
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

const sensitivePreview = await preciseEditAuthorized({
  authorityExecutor,
  path: ".env",
  expectedText: "very-secret",
  replacementText: "rotated-secret",
  cwd: root,
  previewOnly: true,
  captureSnapshot: true,
});
assert.deepEqual(sensitivePreview.preview, { suppressed: true, reason: "sensitive_path" });
assert.equal(Object.hasOwn(sensitivePreview, "mutationSnapshot"), false);
assert.equal((await readFile(envFile, "utf8")), "API_KEY=very-secret\n");

console.log("secret-boundaries-v5: ok");
