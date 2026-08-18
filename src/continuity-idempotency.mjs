import { createHash } from "node:crypto";
import { CodexlessToolError } from "./tool-errors.mjs";

export function createContinuityIdempotency({ store, now = () => Date.now() } = {}) {
  if (!store) throw new Error("continuity idempotency requires a state store");
  ensureSchema(store.db);

  return {
    begin({ operation, key, request, bindingRef = null }) {
      if (!key) return { mode: "disabled", requestHash: null };
      validateKey(key);
      const requestHash = hashRequest(request);
      const existing = getRow(store.db, operation, key);
      if (existing) {
        if (existing.requestHash !== requestHash) {
          throw new CodexlessToolError("This idempotencyKey was already used with different continuity input.", {
            code: "IDEMPOTENCY_KEY_REUSED",
            category: "input",
            retryable: false,
            nextActions: ["Use a new idempotencyKey for a different bind/checkpoint payload."],
          });
        }
        if (existing.status === "completed") {
          return { mode: "replay", requestHash, result: existing.result, bindingRef: existing.bindingRef };
        }
        throw new CodexlessToolError("A previous continuity request with this idempotencyKey may already have reached Codex, but completion was not confirmed locally.", {
          code: "IDEMPOTENCY_IN_DOUBT",
          category: "state",
          retryable: false,
          nextActions: [
            "Inspect continuity status and the target Codex thread before retrying.",
            "Use a new idempotencyKey only after deciding whether another checkpoint is appropriate.",
          ],
          details: { operation, bindingRef: existing.bindingRef },
        });
      }
      const at = now();
      store.db.prepare(`INSERT INTO continuity_idempotency(operation, idempotency_key, request_hash, status, binding_ref, result_json, created_at, updated_at)
        VALUES(?, ?, ?, 'pending', ?, NULL, ?, ?)`).run(operation, key, requestHash, bindingRef, at, at);
      return { mode: "started", requestHash };
    },

    complete({ operation, key, requestHash, bindingRef = null, result }) {
      if (!key) return result;
      const at = now();
      const updated = store.db.prepare(`UPDATE continuity_idempotency
        SET status='completed', binding_ref=?, result_json=?, updated_at=?
        WHERE operation=? AND idempotency_key=? AND request_hash=? AND status='pending'`)
        .run(bindingRef, JSON.stringify(result), at, operation, key, requestHash);
      if (updated.changes !== 1) {
        throw new CodexlessToolError("Could not finalize continuity idempotency state after the operation completed.", {
          code: "IDEMPOTENCY_FINALIZE_FAILED",
          category: "state",
          retryable: false,
          nextActions: ["Inspect the target thread before retrying; the external continuity write may already exist."],
        });
      }
      return result;
    },

    cancelPending({ operation, key, requestHash }) {
      if (!key) return false;
      return store.db.prepare("DELETE FROM continuity_idempotency WHERE operation=? AND idempotency_key=? AND request_hash=? AND status='pending'")
        .run(operation, key, requestHash).changes > 0;
    },

    get(operation, key) {
      return getRow(store.db, operation, key);
    },
  };
}

function ensureSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS continuity_idempotency (
    operation TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    status TEXT NOT NULL,
    binding_ref TEXT,
    result_json TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(operation, idempotency_key)
  );`);
}

function getRow(db, operation, key) {
  const row = db.prepare("SELECT * FROM continuity_idempotency WHERE operation=? AND idempotency_key=?").get(operation, key);
  if (!row) return null;
  let result = null;
  try { result = row.result_json ? JSON.parse(row.result_json) : null; } catch {}
  return {
    operation: row.operation,
    key: row.idempotency_key,
    requestHash: row.request_hash,
    status: row.status,
    bindingRef: row.binding_ref,
    result,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function hashRequest(request) {
  return createHash("sha256").update(JSON.stringify(request)).digest("hex");
}

function validateKey(key) {
  if (typeof key !== "string" || key.length < 8 || key.length > 256 || !/^[A-Za-z0-9._:-]+$/.test(key)) {
    throw new CodexlessToolError("idempotencyKey must be 8..256 characters using letters, digits, dot, underscore, colon, or dash.", {
      code: "IDEMPOTENCY_KEY_INVALID",
      category: "input",
      retryable: false,
    });
  }
}
