import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const z = require("zod/v4");

const DEFAULT_PER_FILE_CHARS = 50_000;
const MAX_PER_FILE_CHARS = 200_000;
const DEFAULT_TOTAL_CHARS = 200_000;
const MAX_TOTAL_CHARS = 500_000;
const MAX_PRECISE_EDIT_CHARS = 64_000;
const bindingRefSchema = z.string().regex(/^binding_[0-9a-f-]{36}$/i).optional();
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

export function registerConstructionTools(server, { authorityExecutor, continuityState = null }) {
  if (!authorityExecutor) return;

  server.registerTool(
    "codex.read_many",
    {
      title: "Read Multiple Authorized Project Files",
      description: "Read several UTF-8 text files through official Codex command/exec under the resolved read-only permission profile. Paths are canonicalized and must remain inside the trusted Codex root. The actual file read occurs inside the Codex sandbox; no Codex model turn is started.",
      inputSchema: z.object({
        paths: z.array(z.string().min(1).max(32_768)).min(1).max(20),
        cwd: z.string().min(1).max(32_768).optional(),
        maxCharsPerFile: z.number().int().min(1_000).max(MAX_PER_FILE_CHARS).default(DEFAULT_PER_FILE_CHARS),
        maxTotalChars: z.number().int().min(1_000).max(MAX_TOTAL_CHARS).default(DEFAULT_TOTAL_CHARS),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input) => structured(() => readManyAuthorized({ authorityExecutor, ...input }))
  );

  server.registerTool(
    "codex.precise_edit",
    {
      title: "Guarded Precise Project Edit",
      description: "Apply one guarded exact-text edit through official Codex command/exec under the resolved write permission profile. Codexless canonicalizes the path, validates SHA-256 and exact occurrence count, revalidates both inside the sandbox immediately before writing, then verifies the resulting hash. ChatGPT supplies the edit; no Codex model turn is started.",
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
    },
    async ({ bindingRef, ...input }) => structured(async () => {
      const scoped = bindingRef && continuityState ? continuityState.assertCwd(bindingRef, input.cwd) : null;
      const result = await preciseEditAuthorized({ authorityExecutor, ...input, cwd: scoped?.targetCwd ?? input.cwd });
      if (bindingRef && continuityState && !result.previewOnly) {
        continuityState.record(bindingRef, { kind: "edit", path: result.path, cwd: result.cwd, status: "applied", changed: result.changed, previewOnly: false });
      }
      return bindingRef ? { ...result, continuityJournaled: !result.previewOnly } : result;
    })
  );
}

export async function readManyAuthorized({ authorityExecutor, paths, cwd, maxCharsPerFile = DEFAULT_PER_FILE_CHARS, maxTotalChars = DEFAULT_TOTAL_CHARS }) {
  const authority = await authorityExecutor.resolveAuthority({ cwd, access: "readOnly" });
  const root = await canonicalRoot(authority);
  let remaining = maxTotalChars;
  const files = [];
  for (const requestedPath of paths) {
    const target = await canonicalExistingFile({ requestedPath, cwd: authority.effectiveCwd, root });
    const read = await readTextViaSandbox({ authorityExecutor, target, cwd: authority.effectiveCwd, access: "readOnly" });
    const text = read.text;
    const allowed = Math.max(0, Math.min(maxCharsPerFile, remaining));
    const returnedText = text.slice(0, allowed);
    const buffer = Buffer.from(text, "utf8");
    files.push({ requestedPath, path: target, text: returnedText, chars: text.length, returnedChars: returnedText.length, truncated: returnedText.length < text.length, byteLength: buffer.length, sha256: sha256(buffer) });
    remaining -= returnedText.length;
  }
  return { status: "ok", cwd: authority.effectiveCwd, trustedAncestor: root, permissionProfile: ":read-only", count: files.length, returnedChars: maxTotalChars - remaining, totalCharsLimit: maxTotalChars, files, modelTurnStarted: false };
}

export async function preciseEditAuthorized({ authorityExecutor, path: requestedPath, expectedText, replacementText, expectedOccurrences = 1, expectedSha256, cwd, previewOnly = false }) {
  const authority = await authorityExecutor.resolveAuthority({ cwd, access: "inherit" });
  const root = await canonicalRoot(authority);
  const target = await canonicalExistingFile({ requestedPath, cwd: authority.effectiveCwd, root });
  assertWithinEffectiveCwd(authority.effectiveCwd, target);

  const initial = await readTextViaSandbox({ authorityExecutor, target, cwd: authority.effectiveCwd, access: "readOnly" });
  const initialBuffer = Buffer.from(initial.text, "utf8");
  const beforeSha256 = sha256(initialBuffer);
  if (expectedSha256 && beforeSha256.toLowerCase() !== expectedSha256.toLowerCase()) throw new Error(`precise edit refused: expectedSha256 does not match current file ${target}`);
  const occurrenceCount = countOccurrences(initial.text, expectedText);
  if (occurrenceCount !== expectedOccurrences) throw new Error(`precise edit refused: expectedText occurs ${occurrenceCount} times, expected exactly ${expectedOccurrences}`);
  const nextText = replaceExactOccurrences(initial.text, expectedText, replacementText, expectedOccurrences);
  const afterBuffer = Buffer.from(nextText, "utf8");
  const afterSha256 = sha256(afterBuffer);
  const preview = buildPreview(initial.text, nextText, expectedText);

  if (!previewOnly) {
    const edit = await authorityExecutor.exec({
      command: [
        process.execPath,
        "-e",
        PRECISE_EDIT_SCRIPT,
        target,
        beforeSha256,
        String(expectedOccurrences),
        Buffer.from(expectedText, "utf8").toString("base64"),
        Buffer.from(replacementText, "utf8").toString("base64"),
      ],
      cwd: authority.effectiveCwd,
      access: "inherit",
      timeoutMs: 15_000,
    });
    if (edit.exitCode !== 0) throw new Error(`precise edit sandbox write failed: ${edit.stderr || `exit ${edit.exitCode}`}`);
    const written = await readTextViaSandbox({ authorityExecutor, target, cwd: authority.effectiveCwd, access: "readOnly" });
    const writtenSha256 = sha256(Buffer.from(written.text, "utf8"));
    if (writtenSha256 !== afterSha256) throw new Error("precise edit verification failed: written file hash does not match intended output");
  }

  return { status: previewOnly ? "preview" : "applied", path: target, cwd: authority.effectiveCwd, trustedAncestor: root, permissionProfile: authority.permissionProfile, occurrenceCount, beforeSha256, afterSha256, beforeBytes: initialBuffer.length, afterBytes: afterBuffer.length, changed: beforeSha256 !== afterSha256, previewOnly, preview, modelTurnStarted: false };
}

async function readTextViaSandbox({ authorityExecutor, target, cwd, access }) {
  const result = await authorityExecutor.exec({ command: [process.execPath, "-e", READ_FILE_SCRIPT, target], cwd, access, timeoutMs: 10_000 });
  if (result.exitCode !== 0) throw new Error(`authorized file read failed: ${result.stderr || `exit ${result.exitCode}`}`);
  if (result.stdoutTruncated) throw new Error(`authorized file read exceeded command output cap: ${target}`);
  return { text: result.stdout };
}

async function canonicalRoot(authority) {
  const candidate = authority?.trustedAncestor ?? authority?.effectiveCwd;
  if (!candidate) throw new Error("authorized construction tool requires a trusted Codex root");
  return realpath(candidate);
}
async function canonicalExistingFile({ requestedPath, cwd, root }) {
  const resolved = path.resolve(cwd, requestedPath);
  const target = await realpath(resolved);
  const relative = path.relative(root, target);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`authorized construction tool refused path outside trusted root: ${target}`);
  const info = await stat(target);
  if (!info.isFile()) throw new Error(`target is not a regular file: ${target}`);
  return target;
}
function assertWithinEffectiveCwd(cwd, target) {
  const relative = path.relative(cwd, target);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`precise edit refused path outside effective cwd: ${target}`);
}
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function countOccurrences(text, needle) {
  let count = 0;
  let offset = 0;
  while (true) {
    const index = text.indexOf(needle, offset);
    if (index < 0) return count;
    count += 1;
    offset = index + needle.length;
  }
}
function replaceExactOccurrences(text, needle, replacement, count) {
  let output = "";
  let offset = 0;
  for (let i = 0; i < count; i += 1) {
    const index = text.indexOf(needle, offset);
    output += text.slice(offset, index) + replacement;
    offset = index + needle.length;
  }
  return output + text.slice(offset);
}
function buildPreview(before, after, needle) {
  const index = before.indexOf(needle);
  const radius = 240;
  const beforeStart = Math.max(0, index - radius);
  const beforeEnd = Math.min(before.length, index + needle.length + radius);
  const afterIndex = Math.max(0, Math.min(after.length, index));
  const afterEnd = Math.min(after.length, afterIndex + Math.max(needle.length, 1) + radius * 2);
  return { beforeExcerpt: before.slice(beforeStart, beforeEnd), afterExcerpt: after.slice(Math.max(0, afterIndex - radius), afterEnd) };
}
async function structured(task) {
  try {
    const payload = await task();
    return { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload, isError: false };
  } catch (error) {
    const payload = { error: error instanceof Error ? error.message : String(error) };
    if (typeof error?.code === "string") payload.errorCode = error.code;
    if (Array.isArray(error?.nextActions)) payload.nextActions = error.nextActions;
    return { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload, isError: true };
  }
}
