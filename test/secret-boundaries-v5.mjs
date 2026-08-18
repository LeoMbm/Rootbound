import assert from "node:assert/strict";
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

console.log("secret-boundaries-v5: ok");
