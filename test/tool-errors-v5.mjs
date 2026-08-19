import assert from "node:assert/strict";
import { RootboundToolError, normalizeToolError, typedToolResponse } from "../src/tool-errors.mjs";
import { PUBLIC_SURFACE_VERSION } from "../src/surface-contracts.mjs";

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
  surfaceVersion: PUBLIC_SURFACE_VERSION,
  operation: "workspace_open",
});

const compatibility = new RootboundToolError("stdin unavailable", {
  code: "COMMAND_STDIN_UNSUPPORTED",
  nextActions: ["Use non-interactive mode"],
});
const normalizedCompatibility = normalizeToolError(compatibility, { operation: "command_write" });
assert.equal(normalizedCompatibility.category, "compatibility");
assert.equal(normalizedCompatibility.retryable, false);
assert.equal(normalizedCompatibility.operation, "command_write");
assert.equal(normalizedCompatibility.surfaceVersion, PUBLIC_SURFACE_VERSION);

const inactive = new Error("session not active");
inactive.code = "COMMAND_SESSION_NOT_ACTIVE";
const normalizedInactive = normalizeToolError(inactive);
assert.equal(normalizedInactive.category, "state");
assert.equal(normalizedInactive.retryable, true);

const errorResponse = await typedToolResponse(async () => { throw permission; }, { operation: "command_start" });
assert.equal(errorResponse.isError, true);
assert.equal(errorResponse.structuredContent.errorCode, "PERMISSION_APPROVAL_REQUIRED");
assert.equal(errorResponse.structuredContent.category, "permission");
assert.equal(errorResponse.structuredContent.operation, "command_start");
assert.equal(errorResponse.structuredContent.surfaceVersion, PUBLIC_SURFACE_VERSION);

const successResponse = await typedToolResponse(async () => ({ status: "ok", answer: 42 }), { operation: "probe" });
assert.equal(successResponse.isError, false);
assert.equal(successResponse.structuredContent.answer, 42);
assert.equal(successResponse.structuredContent.surfaceVersion, PUBLIC_SURFACE_VERSION);

console.log("tool-errors-v5: ok");
