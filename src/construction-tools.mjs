import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { createEditMutationJournal } from "./edit-mutations.mjs";
import { decodeCursor, encodeCursor } from "./pagination.mjs";
import { projectRefForRoot } from "./project-registry.mjs";
import { isSensitivePath } from "./secret-boundaries.mjs";
import { typedToolResponse } from "./tool-errors.mjs";

const require = createRequire(import.meta.url);
const z = require("zod/v4");
const DEFAULT_PER_FILE_CHARS = 50_000;
const MAX_PER_FILE_CHARS = 200_000;
const DEFAULT_TOTAL_CHARS = 200_000;
const MAX_TOTAL_CHARS = 500_000;
const MAX_PRECISE_EDIT_CHARS = 64_000;
const bindingRefSchema = z.string().regex(/^binding_[0-9a-f-]{36}$/i).optional();
const mutationIdSchema = z.string().regex(/^mutation_[0-9a-f-]{36}$/i);
const READ_FILE_SCRIPT = "const fs=require('node:fs');process.stdout.write(fs.readFileSync(process.argv[1]));";
const PRECISE_EDIT_SCRIPT = `
const fs=require('node:fs');
const crypto=require('node:crypto');
const p=process.argv[1];
const expectedSha=process.argv[2];
const expectedCount=Number(process.argv[3]);
const oldText=Buffer.from(process.argv[4],'base64').toString('utf8');
const newText=Buffer.from(process.argv[5],'base64').toString('utf8');
const before=fs.readFileSync(p);
const beforeSha=crypto.createHash('sha256').update(before).digest('hex');
if(beforeSha!==expectedSha){console.error('precise edit refused: file changed after validation and before write');process.exit(12);}
const text=before.toString('utf8');
let count=0, offset=0;
while(true){const i=text.indexOf(oldText,offset);if(i<0)break;count++;offset=i+oldText.length;}
if(count!==expectedCount){console.error('precise edit refused: expectedText occurrence count changed before write');process.exit(13);}
const next=text.split(oldText).join(newText);
fs.writeFileSync(p,next,'utf8');
`;

export function registerConstructionTools(server, { authorityExecutor, continuityState = null, stateStore = null }) {
  if (!authorityExecutor) return;
  const mutationJournal = stateStore ? createEditMutationJournal({ store: stateStore, authorityExecutor }) : null;

  server.registerTool("codex.read_many", {
    title: "Read Multiple Authorized Project Files",
    description: "Read UTF-8 project files through the authorized Codex sandbox with request-bound pagination. Sensitive files such as .env/private keys/credentials require allowSensitive=true. If a page ends inside a file, nextCursor resumes at the exact character offset and refuses to continue if that file changed in between. No Codex model turn is started.",
    inputSchema: z.object({
      paths: z.array(z.string().min(1).max(32_768)).min(1).max(20),
      cwd: z.string().min(1).max(32_768).optional(),
      maxCharsPerFile: z.number().int().min(1_000).max(MAX_PER_FILE_CHARS).default(DEFAULT_PER_FILE_CHARS),
      maxTotalChars: z.number().int().min(1_000).max(MAX_TOTAL_CHARS).default(DEFAULT_TOTAL_CHARS),
      cursor: z.string().max(2_048).optional(),
      allowSensitive: z.boolean().default(false),
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => typedToolResponse(() => readManyAuthorized({ authorityExecutor, ...input }), { operation: "read_many" }));

  server.registerTool("codex.precise_edit", {
    title: "Guarded Precise Project Edit",
    description: "Apply one guarded exact-text edit through official Codex command/exec under the resolved write permission profile. Successful non-sensitive edits return a mutationId that can be safely undone/redone while hashes still match. Sensitive canonical paths such as .env/private keys are never snapshotted into the undo journal and do not return surrounding preview excerpts. No Codex model turn is started.",
    inputSchema: z.object({
      path: z.string().min(1).max(32_768),
      expectedText: z.string().min(1).max(MAX_PRECISE_EDIT_CHARS),
      replacementText: z.string().max(MAX_PRECISE_EDIT_CHARS),
      expectedOccurrences: z.number().int().min(1).max(100).default(1),
      expectedSha256: z.string().regex(/^[0-9a-fA-F]{64}$/).optional(),
      cwd: z.string().min(1).max(32_768).optional(),
      previewOnly: z.boolean().default(false),
      bindingRef: bindingRefSchema,
    }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, async ({ bindingRef, ...input }) => typedToolResponse(async () => {
    const scoped = bindingRef && continuityState ? continuityState.assertCwd(bindingRef, input.cwd) : null;
    const requestedSensitive = isSensitivePath(input.path);
    const result = await preciseEditAuthorized({
      authorityExecutor,
      ...input,
      cwd: scoped?.targetCwd ?? input.cwd,
      captureSnapshot: Boolean(mutationJournal && !input.previewOnly && !requestedSensitive),
    });
    const { mutationSnapshot, ...publicResult } = result;
    const sensitive = requestedSensitive || isSensitivePath(publicResult.path);
    let mutationId = null;
    if (mutationJournal && mutationSnapshot && publicResult.changed && !sensitive) {
      const root = publicResult.cwd;
      let project = stateStore.getProjectByRoot(root);
      if (!project) {
        const at = Date.now();
        project = stateStore.upsertProject({ projectRef: projectRefForRoot(root), root, gitRoot: null, name: path.basename(root), trusted: true, createdAt: at, updatedAt: at, lastConnectedAt: at });
      }
      const mutation = mutationJournal.record({ projectRef: project.projectRef, bindingRef, cwd: publicResult.cwd, path: publicResult.path, beforeSha256: publicResult.beforeSha256, afterSha256: publicResult.afterSha256, beforeText: mutationSnapshot.beforeText, afterText: mutationSnapshot.afterText });
      mutationId = mutation.mutationId;
      stateStore.recordEvent({ projectRef: project.projectRef, bindingRef, kind: "edit.recorded", payload: { mutationId, path: publicResult.path }, createdAt: Date.now() });
    }
    if (bindingRef && continuityState && !publicResult.previewOnly) continuityState.record(bindingRef, { kind: "edit", path: publicResult.path, cwd: publicResult.cwd, status: "applied", changed: publicResult.changed, previewOnly: false });
    return {
      ...publicResult,
      ...(mutationId ? { mutationId, undoAvailable: true } : {}),
      ...(!mutationId && sensitive && !publicResult.previewOnly ? { undoAvailable: false, undoUnavailableReason: "sensitive_path" } : {}),
      ...(bindingRef ? { continuityJournaled: !publicResult.previewOnly } : {}),
    };
  }, { operation: "precise_edit" }));

  if (mutationJournal) {
    server.registerTool("codex.edit_undo", {
      title: "Undo Guarded Precise Edit",
      description: "Undo one recorded precise_edit by mutationId. Codexless verifies the current file SHA still equals the recorded after-hash before restoring the exact previous UTF-8 content through the authorized sandbox. Refuses on conflicts; does not use git reset or start a model turn.",
      inputSchema: z.object({ mutationId: mutationIdSchema }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    }, async ({ mutationId }) => typedToolResponse(async () => publicMutation(await mutationJournal.undo(mutationId)), { operation: "edit_undo" }));
    server.registerTool("codex.edit_redo", {
      title: "Redo Guarded Precise Edit",
      description: "Redo one previously undone precise_edit by mutationId. Codexless verifies the current file SHA still equals the recorded before-hash before restoring the exact after-content through the authorized sandbox.",
      inputSchema: z.object({ mutationId: mutationIdSchema }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    }, async ({ mutationId }) => typedToolResponse(async () => publicMutation(await mutationJournal.redo(mutationId)), { operation: "edit_redo" }));
  }
}

export async function readManyAuthorized({ authorityExecutor, paths, cwd, maxCharsPerFile = DEFAULT_PER_FILE_CHARS, maxTotalChars = DEFAULT_TOTAL_CHARS, cursor = null, allowSensitive = false }) {
  const authority = await authorityExecutor.resolveAuthority({ cwd, access: "readOnly" });
  const root = await canonicalRoot(authority);
  const signatureInput = { paths, cwd: authority.effectiveCwd, maxCharsPerFile, allowSensitive };
  const state = decodeCursor(cursor, "read_many", signatureInput) ?? { pathIndex: 0, charOffset: 0, fileSha: null };
  if (!Number.isInteger(state.pathIndex) || state.pathIndex < 0 || state.pathIndex >= paths.length || !Number.isInteger(state.charOffset) || state.charOffset < 0) throw paginationError("Pagination cursor contains an invalid file position.", "PAGINATION_CURSOR_INVALID");

  let remaining = maxTotalChars;
  const files = [];
  let nextCursor = null;
  for (let index = state.pathIndex; index < paths.length && remaining > 0; index += 1) {
    const requestedPath = paths[index];
    if (!allowSensitive && isSensitivePath(requestedPath)) throw sensitiveReadError(requestedPath);
    const target = await canonicalExistingFile({ requestedPath, cwd: authority.effectiveCwd, root });
    if (!allowSensitive && isSensitivePath(target)) throw sensitiveReadError(target);
    const read = await readTextViaSandbox({ authorityExecutor, target, cwd: authority.effectiveCwd, access: "readOnly" });
    const text = read.text;
    const buffer = Buffer.from(text, "utf8");
    const fileSha = sha256(buffer);
    const start = index === state.pathIndex ? state.charOffset : 0;
    if (index === state.pathIndex && state.fileSha && state.fileSha !== fileSha) throw paginationError(`Cannot continue read_many because ${target} changed after the previous page.`, "PAGINATION_SOURCE_CHANGED");
    if (start > text.length) throw paginationError(`Pagination offset exceeds current file length: ${target}`, "PAGINATION_SOURCE_CHANGED");
    const allowed = Math.max(0, Math.min(maxCharsPerFile, remaining, text.length - start));
    const returnedText = text.slice(start, start + allowed);
    const nextOffset = start + returnedText.length;
    files.push({ requestedPath, path: target, text: returnedText, chars: text.length, offset: start, returnedChars: returnedText.length, truncated: nextOffset < text.length, byteLength: buffer.length, sha256: fileSha });
    remaining -= returnedText.length;
    if (nextOffset < text.length) { nextCursor = encodeCursor("read_many", signatureInput, { pathIndex: index, charOffset: nextOffset, fileSha }); break; }
    if (remaining === 0 && index + 1 < paths.length) { nextCursor = encodeCursor("read_many", signatureInput, { pathIndex: index + 1, charOffset: 0, fileSha: null }); break; }
  }
  return { status: "ok", cwd: authority.effectiveCwd, trustedAncestor: root, permissionProfile: ":read-only", allowSensitive, count: files.length, returnedChars: maxTotalChars - remaining, totalCharsLimit: maxTotalChars, files, hasMore: Boolean(nextCursor), nextCursor, modelTurnStarted: false };
}

export async function preciseEditAuthorized({ authorityExecutor, path: requestedPath, expectedText, replacementText, expectedOccurrences = 1, expectedSha256, cwd, previewOnly = false, captureSnapshot = false }) {
  const authority = await authorityExecutor.resolveAuthority({ cwd, access: "inherit" });
  const root = await canonicalRoot(authority);
  const target = await canonicalExistingFile({ requestedPath, cwd: authority.effectiveCwd, root });
  assertWithinEffectiveCwd(authority.effectiveCwd, target);
  const sensitiveTarget = isSensitivePath(target);
  const initial = await readTextViaSandbox({ authorityExecutor, target, cwd: authority.effectiveCwd, access: "readOnly" });
  const initialBuffer = Buffer.from(initial.text, "utf8");
  const beforeSha256 = sha256(initialBuffer);
  if (expectedSha256 && beforeSha256.toLowerCase() !== expectedSha256.toLowerCase()) throw new Error(`precise edit refused: expectedSha256 does not match current file ${target}`);
  const occurrenceCount = countOccurrences(initial.text, expectedText);
  if (occurrenceCount !== expectedOccurrences) throw new Error(`precise edit refused: expectedText occurs ${occurrenceCount} times, expected exactly ${expectedOccurrences}`);
  const nextText = replaceExactOccurrences(initial.text, expectedText, replacementText, expectedOccurrences);
  const afterBuffer = Buffer.from(nextText, "utf8");
  const afterSha256 = sha256(afterBuffer);
  const preview = sensitiveTarget ? { suppressed: true, reason: "sensitive_path" } : buildPreview(initial.text, nextText, expectedText);
  if (!previewOnly) {
    const edit = await authorityExecutor.exec({ command: [process.execPath, "-e", PRECISE_EDIT_SCRIPT, target, beforeSha256, String(expectedOccurrences), Buffer.from(expectedText, "utf8").toString("base64"), Buffer.from(replacementText, "utf8").toString("base64")], cwd: authority.effectiveCwd, access: "inherit", timeoutMs: 15_000 });
    if (edit.exitCode !== 0) throw new Error(`precise edit sandbox write failed: ${edit.stderr || `exit ${edit.exitCode}`}`);
    const written = await readTextViaSandbox({ authorityExecutor, target, cwd: authority.effectiveCwd, access: "readOnly" });
    const writtenSha256 = sha256(Buffer.from(written.text, "utf8"));
    if (writtenSha256 !== afterSha256) throw new Error("precise edit verification failed: written file hash does not match intended output");
  }
  const snapshotAllowed = captureSnapshot && !previewOnly && !sensitiveTarget;
  return { status: previewOnly ? "preview" : "applied", path: target, cwd: authority.effectiveCwd, trustedAncestor: root, permissionProfile: authority.permissionProfile, occurrenceCount, beforeSha256, afterSha256, beforeBytes: initialBuffer.length, afterBytes: afterBuffer.length, changed: beforeSha256 !== afterSha256, previewOnly, preview, modelTurnStarted: false, ...(snapshotAllowed ? { mutationSnapshot: { beforeText: initial.text, afterText: nextText } } : {}) };
}

function publicMutation(row) { return { mutationId: row.mutationId, projectRef: row.projectRef, bindingRef: row.bindingRef, path: row.path, cwd: row.cwd, beforeSha256: row.beforeSha256, afterSha256: row.afterSha256, status: row.status, action: row.action, modelTurnStarted: false }; }
async function readTextViaSandbox({ authorityExecutor, target, cwd, access }) {
  const result = await authorityExecutor.exec({ command: [process.execPath, "-e", READ_FILE_SCRIPT, target], cwd, access, timeoutMs: 10_000 });
  if (result.exitCode !== 0) throw new Error(`authorized file read failed: ${result.stderr || `exit ${result.exitCode}`}`);
  if (result.stdoutTruncated) throw new Error(`authorized file read exceeded command output cap: ${target}`);
  return { text: result.stdout };
}
async function canonicalRoot(authority) { const candidate = authority?.trustedAncestor ?? authority?.effectiveCwd; if (!candidate) throw new Error("authorized construction tool requires a trusted Codex root"); return realpath(candidate); }
async function canonicalExistingFile({ requestedPath, cwd, root }) { const resolved = path.resolve(cwd, requestedPath); const target = await realpath(resolved); const relative = path.relative(root, target); if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`authorized construction tool refused path outside trusted root: ${target}`); const info = await stat(target); if (!info.isFile()) throw new Error(`target is not a regular file: ${target}`); return target; }
function assertWithinEffectiveCwd(cwd, target) { const relative = path.relative(cwd, target); if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`precise edit refused path outside effective cwd: ${target}`); }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function countOccurrences(text, needle) { let count = 0; let offset = 0; while (true) { const index = text.indexOf(needle, offset); if (index < 0) return count; count += 1; offset = index + needle.length; } }
function replaceExactOccurrences(text, needle, replacement, count) { let output = ""; let offset = 0; for (let i = 0; i < count; i += 1) { const index = text.indexOf(needle, offset); output += text.slice(offset, index) + replacement; offset = index + needle.length; } return output + text.slice(offset); }
function buildPreview(before, after, needle) { const index = before.indexOf(needle); const radius = 240; const beforeStart = Math.max(0, index - radius); const beforeEnd = Math.min(before.length, index + needle.length + radius); const afterIndex = Math.max(0, Math.min(after.length, index)); const afterEnd = Math.min(after.length, afterIndex + Math.max(needle.length, 1) + radius * 2); return { beforeExcerpt: before.slice(beforeStart, beforeEnd), afterExcerpt: after.slice(Math.max(0, afterIndex - radius), afterEnd) }; }
function paginationError(message, code) { const error = new Error(message); error.code = code; error.category = "state"; error.retryable = false; error.nextActions = ["Restart read_many without a cursor to read the current file version."]; return error; }
function sensitiveReadError(target) { const error = new Error(`Reading sensitive file requires explicit allowSensitive=true: ${target}`); error.code = "SENSITIVE_READ_REQUIRES_OPT_IN"; error.category = "safety"; error.retryable = false; error.nextActions = ["Retry with allowSensitive=true only if the sensitive contents are intentionally needed in the ChatGPT context."]; return error; }
