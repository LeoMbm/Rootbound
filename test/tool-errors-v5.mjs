import assert from "node:assert/strict";
import { CodexlessToolError, normalizeToolError, typedToolResponse } from "../src/tool-errors.mjs";

const permission = new Error("trust required");
permission.code = "PERMISSION_APPROVAL_REQUIRED";
permission.nextActions = ["Trust exact root"];
assert.deepEqual(normalizeToolError(permission, { operation: "workspace_open" }), {
  status: "error",
  error: "trust required",
  errorCode: "PERMISSION_APPROVAL_REQUIRED",
  category: "permission",
  retryable: false,
  nextActions: ["Trust exact root"],
  operation: "workspace_open",
});

const compatibility = new CodexlessToolError("stdin unavailable", {
  code: "COMMAND_STDIN_UNSUPPORTED",
  nextActions: ["Use non-interactive mode"],
});
const normalizedCompatibility = normalizeToolError(compatibility, { operation: "command_write" });
assert.equal(normalizedCompatibility.category, "compatibility");
assert.equal(normalizedCompatibility.retryable, false);
assert.equal(normalizedCompatibility.operation, "command_write");

const inactive = new Error("session not active");
inactive.code = "COMMAND_SESSION_NOT_ACTIVE";
const normalizedInactive = normalizeToolError(inactive);
assert.equal(normalizedInactive.category, "state");
assert.equal(normalizedInactive.retryable, true);

const response = await typedToolResponse(async () => { throw permission; }, { operation: "command_start" });
assert.equal(response.isError, true);
assert.equal(response.structuredContent.errorCode, "PERMISSION_APPROVAL_REQUIRED");
assert.equal(response.structuredContent.category, "permission");
assert.equal(response.structuredContent.operation, "command_start");

console.log("tool-errors-v5: ok");
