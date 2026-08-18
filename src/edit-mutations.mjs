import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { CodexlessToolError } from "./tool-errors.mjs";

const READ_SCRIPT = "const fs=require('node:fs');process.stdout.write(fs.readFileSync(process.argv[1]));";
const WRITE_SCRIPT = `
const fs=require('node:fs');
const crypto=require('node:crypto');
const p=process.argv[1];
const expected=process.argv[2];
const next=Buffer.from(process.argv[3],'base64');
const before=fs.readFileSync(p);
const actual=crypto.createHash('sha256').update(before).digest('hex');
if(actual!==expected){console.error('mutation restore refused: file hash changed');process.exit(12);}
fs.writeFileSync(p,next);
`;

export function createEditMutationJournal({ store, authorityExecutor }) {
  if (!store || !authorityExecutor) throw new Error("edit mutation journal requires store and authorityExecutor");
  ensureSchema(store.db);

  return {
    record({ projectRef, bindingRef = null, cwd, path: targetPath, beforeSha256, afterSha256, beforeText, afterText, createdAt = Date.now() }) {
      const canonicalCwd = canonicalPath(cwd);
      const canonicalTarget = canonicalPath(targetPath);
      assertWithin(canonicalCwd, canonicalTarget);
      const mutationId = `mutation_${randomUUID()}`;
      store.db.prepare(`INSERT INTO edit_mutations(mutation_id, project_ref, binding_ref, cwd, path, before_sha256, after_sha256, before_text, after_text, status, created_at, updated_at)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, 'applied', ?, ?)`).run(
        mutationId, projectRef, bindingRef, canonicalCwd, canonicalTarget, beforeSha256, afterSha256,
        Buffer.from(beforeText, "utf8"), Buffer.from(afterText, "utf8"), createdAt, createdAt
      );
      return this.get(mutationId);
    },
    get(mutationId) { return normalize(store.db.prepare("SELECT * FROM edit_mutations WHERE mutation_id=?").get(mutationId)); },
    async undo(mutationId) {
      const row = requireMutation(this.get(mutationId));
      if (row.status !== "applied") throw conflict(`Mutation ${mutationId} is ${row.status}; only applied mutations can be undone.`);
      await restore({ authorityExecutor, mutation: row, expectedSha256: row.afterSha256, text: row.beforeText, targetSha256: row.beforeSha256 });
      const at = Date.now();
      store.db.prepare("UPDATE edit_mutations SET status='undone', updated_at=? WHERE mutation_id=?").run(at, mutationId);
      store.recordEvent({ projectRef: row.projectRef, bindingRef: row.bindingRef, kind: "edit.undo", payload: { mutationId, path: row.path }, createdAt: at });
      return { ...this.get(mutationId), action: "undone", modelTurnStarted: false };
    },
    async redo(mutationId) {
      const row = requireMutation(this.get(mutationId));
      if (row.status !== "undone") throw conflict(`Mutation ${mutationId} is ${row.status}; only undone mutations can be redone.`);
      await restore({ authorityExecutor, mutation: row, expectedSha256: row.beforeSha256, text: row.afterText, targetSha256: row.afterSha256 });
      const at = Date.now();
      store.db.prepare("UPDATE edit_mutations SET status='applied', updated_at=? WHERE mutation_id=?").run(at, mutationId);
      store.recordEvent({ projectRef: row.projectRef, bindingRef: row.bindingRef, kind: "edit.redo", payload: { mutationId, path: row.path }, createdAt: at });
      return { ...this.get(mutationId), action: "redone", modelTurnStarted: false };
    },
  };
}

async function restore({ authorityExecutor, mutation, expectedSha256, text, targetSha256 }) {
  const authority = await authorityExecutor.resolveAuthority({ cwd: mutation.cwd, access: "inherit", timeoutMs: 10_000 });
  const effectiveCwd = canonicalPath(authority.effectiveCwd);
  const target = await realpath(mutation.path);
  assertWithin(effectiveCwd, target);
  const read = await authorityExecutor.exec({ command: [process.execPath, "-e", READ_SCRIPT, target], cwd: effectiveCwd, access: "readOnly", timeoutMs: 10_000 });
  if (read.exitCode !== 0 || read.stdoutTruncated) throw conflict(`Cannot verify current file before mutation restore: ${target}`);
  const currentSha = sha256(Buffer.from(read.stdout, "utf8"));
  if (currentSha !== expectedSha256) throw conflict(`Undo/redo refused because ${target} changed after the recorded mutation.`, { expectedSha256, currentSha256: currentSha });
  const write = await authorityExecutor.exec({ command: [process.execPath, "-e", WRITE_SCRIPT, target, expectedSha256, Buffer.from(text, "utf8").toString("base64")], cwd: effectiveCwd, access: "inherit", timeoutMs: 15_000 });
  if (write.exitCode !== 0) throw conflict(`Undo/redo write failed for ${target}: ${write.stderr || `exit ${write.exitCode}`}`);
  const verify = await authorityExecutor.exec({ command: [process.execPath, "-e", READ_SCRIPT, target], cwd: effectiveCwd, access: "readOnly", timeoutMs: 10_000 });
  if (verify.exitCode !== 0 || verify.stdoutTruncated || sha256(Buffer.from(verify.stdout, "utf8")) !== targetSha256) throw conflict(`Undo/redo verification failed for ${target}`);
}

function ensureSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS edit_mutations (
    mutation_id TEXT PRIMARY KEY,
    project_ref TEXT NOT NULL,
    binding_ref TEXT,
    cwd TEXT NOT NULL,
    path TEXT NOT NULL,
    before_sha256 TEXT NOT NULL,
    after_sha256 TEXT NOT NULL,
    before_text BLOB NOT NULL,
    after_text BLOB NOT NULL,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_edit_mutations_project ON edit_mutations(project_ref, updated_at DESC);`);
}

function normalize(row) {
  if (!row) return null;
  return {
    mutationId: row.mutation_id,
    projectRef: row.project_ref,
    bindingRef: row.binding_ref,
    cwd: row.cwd,
    path: row.path,
    beforeSha256: row.before_sha256,
    afterSha256: row.after_sha256,
    beforeText: Buffer.from(row.before_text).toString("utf8"),
    afterText: Buffer.from(row.after_text).toString("utf8"),
    status: row.status,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function requireMutation(row) {
  if (!row) throw new CodexlessToolError("Unknown edit mutation.", { code: "MUTATION_NOT_FOUND", category: "state", nextActions: ["Use the mutationId returned by a successful precise_edit."] });
  return row;
}
function conflict(message, details = null) {
  return new CodexlessToolError(message, { code: "UNDO_CONFLICT", category: "state", retryable: false, nextActions: ["Inspect the current file/diff before deciding whether to apply a new edit."], details });
}
function assertWithin(root, target) {
  const canonicalRoot = canonicalPath(root);
  const canonicalTarget = canonicalPath(target);
  const relative = path.relative(canonicalRoot, canonicalTarget);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw conflict(`Undo/redo refused path outside effective cwd: ${canonicalTarget}`);
}
function canonicalPath(value) {
  const resolved = path.resolve(value);
  try { return realpathSync.native(resolved); }
  catch { return resolved; }
}
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
