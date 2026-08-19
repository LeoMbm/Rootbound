import { createHash } from "node:crypto";

export function encodeCursor(kind, signatureInput, state) {
  const payload = { v: 1, kind, sig: signature(signatureInput), state };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decodeCursor(cursor, kind, signatureInput) {
  if (!cursor) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")); }
  catch { throw cursorError("Cursor is not valid Rootbound pagination state."); }
  if (payload?.v !== 1 || payload?.kind !== kind || payload?.sig !== signature(signatureInput) || !payload?.state || typeof payload.state !== "object") {
    throw cursorError("Cursor does not match this request or is from an incompatible Rootbound pagination version.");
  }
  return payload.state;
}

function signature(value) {
  return createHash("sha256").update(stable(value)).digest("hex").slice(0, 24);
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function cursorError(message) {
  const error = new Error(message);
  error.code = "PAGINATION_CURSOR_INVALID";
  error.category = "input";
  error.retryable = false;
  error.nextActions = ["Restart the paginated operation without a cursor."];
  return error;
}
