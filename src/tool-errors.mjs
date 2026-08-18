import { PUBLIC_SURFACE_VERSION } from "./surface-contracts.mjs";

const CATEGORY_BY_CODE = new Map([
  ["PERMISSION_APPROVAL_REQUIRED", "permission"],
  ["CODEX_MODEL_LANE_DISABLED", "policy"],
  ["COMMAND_STREAMING_UNSUPPORTED", "compatibility"],
  ["COMMAND_STDIN_UNSUPPORTED", "compatibility"],
  ["COMMAND_SESSION_NOT_ACTIVE", "state"],
  ["CODEX_MODEL_SIDE_EFFECT_DETECTED", "safety"],
]);

const RETRYABLE_CODES = new Set(["COMMAND_SESSION_NOT_ACTIVE"]);

export class CodexlessToolError extends Error {
  constructor(message, { code = "CODEXLESS_ERROR", category = null, retryable = false, nextActions = [], details = null } = {}) {
    super(message);
    this.name = "CodexlessToolError";
    this.code = code;
    this.category = category ?? CATEGORY_BY_CODE.get(code) ?? "runtime";
    this.retryable = Boolean(retryable);
    this.nextActions = Array.isArray(nextActions) ? nextActions.filter((value) => typeof value === "string") : [];
    this.details = details && typeof details === "object" ? details : null;
  }
}

export function normalizeToolError(error, { operation = null } = {}) {
  const message = error instanceof Error ? error.message : String(error);
  const code = typeof error?.code === "string" && error.code ? error.code : "CODEXLESS_ERROR";
  const category = typeof error?.category === "string" && error.category
    ? error.category
    : CATEGORY_BY_CODE.get(code) ?? inferCategory(message);
  const retryable = typeof error?.retryable === "boolean" ? error.retryable : RETRYABLE_CODES.has(code);
  const nextActions = Array.isArray(error?.nextActions) ? error.nextActions.filter((value) => typeof value === "string") : [];
  const payload = {
    status: "error",
    error: message,
    errorCode: code,
    category,
    retryable,
    nextActions,
    surfaceVersion: PUBLIC_SURFACE_VERSION,
  };
  if (operation) payload.operation = operation;
  if (error?.details && typeof error.details === "object") payload.details = structuredClone(error.details);
  return payload;
}

export async function typedToolResponse(task, { operation = null, isError = null } = {}) {
  try {
    const value = await task();
    const payload = value && typeof value === "object" && !Array.isArray(value)
      ? { ...value, surfaceVersion: PUBLIC_SURFACE_VERSION }
      : { value, surfaceVersion: PUBLIC_SURFACE_VERSION };
    const failed = typeof isError === "function" ? Boolean(isError(payload)) : payload?.status === "failed" || payload?.status === "error";
    return {
      content: [{ type: "text", text: JSON.stringify(payload) }],
      structuredContent: payload,
      isError: failed,
    };
  } catch (error) {
    const payload = normalizeToolError(error, { operation });
    return {
      content: [{ type: "text", text: JSON.stringify(payload) }],
      structuredContent: payload,
      isError: true,
    };
  }
}

function inferCategory(message) {
  if (/permission|trust|authorized|approval/i.test(message)) return "permission";
  if (/unsupported|version|platform|compat/i.test(message)) return "compatibility";
  if (/not found|unknown|expired|not active|missing/i.test(message)) return "state";
  if (/timeout|timed out|temporar|busy|concurr/i.test(message)) return "transient";
  return "runtime";
}
