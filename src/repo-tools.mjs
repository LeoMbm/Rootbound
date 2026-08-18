import { createRequire } from "node:module";
import { decodeCursor, encodeCursor } from "./pagination.mjs";
import { typedToolResponse } from "./tool-errors.mjs";

const require = createRequire(import.meta.url);
const z = require("zod/v4");
const bindingRefSchema = z.string().regex(/^binding_[0-9a-f-]{36}$/i).optional();
const cwdSchema = z.string().min(1).max(32_768).optional();
const DEFAULT_SECRET_EXCLUDES = ["!.env", "!.env.*", "!*.pem", "!*.key", "!*.p12", "!*.pfx", "!credentials*", "!secrets*"];
const SEARCH_PAGE_SCRIPT = `
const {spawn}=require('node:child_process');
const args=JSON.parse(Buffer.from(process.argv[1],'base64').toString('utf8'));
const offset=Number(process.argv[2]);
const limit=Number(process.argv[3]);
const child=spawn('rg',args,{stdio:['ignore','pipe','pipe'],windowsHide:true,shell:false});
child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
let buffer='',stderr='',seen=0,done=false;const lines=[];
function consume(line){if(done)return; if(seen>=offset){lines.push(line);if(lines.length>limit){done=true;try{child.kill();}catch{}}}seen++;}
child.stdout.on('data',(chunk)=>{buffer+=chunk;while(true){const i=buffer.indexOf('\\n');if(i<0)break;const line=buffer.slice(0,i);buffer=buffer.slice(i+1);if(line.length)consume(line);if(done)break;}});
child.stderr.on('data',(chunk)=>{stderr+=chunk;if(stderr.length>65536)stderr=stderr.slice(-65536);});
child.on('error',(error)=>{process.stdout.write(JSON.stringify({ok:false,error:error.message}));});
child.on('close',(code)=>{if(buffer&&!done)consume(buffer.replace(/\\r$/,''));const hasMore=lines.length>limit;const page=hasMore?lines.slice(0,limit):lines;process.stdout.write(JSON.stringify({ok:code===0||code===1||done,code,stderr,page,hasMore,scanned:seen}));});
`;

export function registerRepoTools(server, { authorityExecutor, continuityState = null }) {
  if (!authorityExecutor) return;

  server.registerTool(
    "codex.repo_search",
    {
      title: "Search Authorized Project",
      description: "Search text in an authorized project with globally paginated ripgrep results. Common secret-bearing files (.env, private keys, credentials/secrets) are excluded by default; set includeSensitive=true only for an intentional sensitive search. No Codex model turn is started.",
      inputSchema: z.object({
        query: z.string().min(1).max(8_192),
        cwd: cwdSchema,
        glob: z.string().min(1).max(4_096).optional(),
        maxResults: z.number().int().min(1).max(200).default(100),
        cursor: z.string().max(2_048).optional(),
        includeSensitive: z.boolean().default(false),
        bindingRef: bindingRefSchema,
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ query, cwd, glob, maxResults, cursor, includeSensitive, bindingRef }) => typedToolResponse(async () => {
      const scoped = bindingRef && continuityState ? continuityState.assertCwd(bindingRef, cwd) : null;
      return searchPageAuthorized({ authorityExecutor, query, cwd: scoped?.targetCwd ?? cwd, glob, maxResults, cursor, includeSensitive });
    }, { operation: "repo_search" })
  );

  server.registerTool("codex.git_status", {
    title: "Read Git Status",
    description: "Read git status for an authorized project via official Codex command/exec with read-only authority. Does not start a Codex model turn.",
    inputSchema: z.object({ cwd: cwdSchema, bindingRef: bindingRefSchema }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ cwd, bindingRef }) => typedToolResponse(async () => {
    const scoped = bindingRef && continuityState ? continuityState.assertCwd(bindingRef, cwd) : null;
    const result = await authorityExecutor.exec({ command: ["git", "status", "--short", "--branch"], cwd: scoped?.targetCwd ?? cwd, access: "readOnly", timeoutMs: 10_000 });
    return projectCommandResult(result);
  }, { operation: "git_status", isError: (payload) => payload?.status === "failed" }));

  server.registerTool("codex.git_diff", {
    title: "Read Git Diff",
    description: "Read the current git diff for an authorized project via official Codex command/exec with read-only authority. Can read staged or unstaged changes without starting a Codex model turn.",
    inputSchema: z.object({ cwd: cwdSchema, staged: z.boolean().default(false), pathspec: z.array(z.string().min(1).max(4_096)).max(50).default([]), bindingRef: bindingRefSchema }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ cwd, staged, pathspec, bindingRef }) => typedToolResponse(async () => {
    const scoped = bindingRef && continuityState ? continuityState.assertCwd(bindingRef, cwd) : null;
    const command = ["git", "diff"];
    if (staged) command.push("--cached");
    if (pathspec.length) command.push("--", ...pathspec);
    const result = await authorityExecutor.exec({ command, cwd: scoped?.targetCwd ?? cwd, access: "readOnly", timeoutMs: 15_000 });
    return projectCommandResult(result, { staged, pathspec });
  }, { operation: "git_diff", isError: (payload) => payload?.status === "failed" }));

  server.registerTool("codex.apply_patch", {
    title: "Apply Authorized Project Patch",
    description: "Apply an OpenAI apply_patch patch generated by ChatGPT through official Codex command/exec. The patch is executed under the locally resolved Codex permission profile and does not start a Codex model turn. Use this for coherent multi-file edits; use precise_edit for guarded exact-text replacements.",
    inputSchema: z.object({ patch: z.string().min(1).max(500_000), cwd: cwdSchema, bindingRef: bindingRefSchema }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, async ({ patch, cwd, bindingRef }) => typedToolResponse(async () => {
    if (!patch.startsWith("*** Begin Patch") || !patch.includes("*** End Patch")) throw inputError("apply_patch payload must use the *** Begin Patch / *** End Patch format");
    const scoped = bindingRef && continuityState ? continuityState.assertCwd(bindingRef, cwd) : null;
    const result = await authorityExecutor.exec({ command: ["apply_patch", patch], cwd: scoped?.targetCwd ?? cwd, access: "inherit", timeoutMs: 30_000 });
    if (bindingRef && continuityState) continuityState.record(bindingRef, { kind: "patch", cwd: result.effectiveCwd, status: result.exitCode === 0 ? "applied" : "failed", exitCode: result.exitCode });
    return projectCommandResult(result, { continuityJournaled: Boolean(bindingRef) });
  }, { operation: "apply_patch", isError: (payload) => payload?.status === "failed" }));
}

export async function searchPageAuthorized({ authorityExecutor, query, cwd, glob = null, maxResults = 100, cursor = null, includeSensitive = false }) {
  const authority = await authorityExecutor.resolveAuthority({ cwd, access: "readOnly", timeoutMs: 10_000 });
  const signatureInput = { query, glob, cwd: authority.effectiveCwd, includeSensitive };
  const state = decodeCursor(cursor, "repo_search", signatureInput) ?? { offset: 0 };
  if (!Number.isInteger(state.offset) || state.offset < 0) throw inputError("Pagination cursor contains an invalid search offset.", "PAGINATION_CURSOR_INVALID");
  const rgArgs = ["--line-number", "--column", "--no-heading", "--color", "never"];
  if (glob) rgArgs.push("--glob", glob);
  if (!includeSensitive) for (const excluded of DEFAULT_SECRET_EXCLUDES) rgArgs.push("--glob", excluded);
  rgArgs.push("--", query, ".");
  const result = await authorityExecutor.exec({
    command: [process.execPath, "-e", SEARCH_PAGE_SCRIPT, Buffer.from(JSON.stringify(rgArgs), "utf8").toString("base64"), String(state.offset), String(maxResults)],
    cwd: authority.effectiveCwd,
    access: "readOnly",
    timeoutMs: 20_000,
  });
  if (result.exitCode !== 0) throw runtimeError(`repo_search pager failed: ${result.stderr || `exit ${result.exitCode}`}`);
  let page;
  try { page = JSON.parse(result.stdout); } catch { throw runtimeError("repo_search pager returned invalid JSON"); }
  if (!page?.ok) throw runtimeError(`repo_search failed: ${page?.error ?? page?.stderr ?? "unknown ripgrep failure"}`);
  const lines = Array.isArray(page.page) ? page.page.map(String) : [];
  const nextOffset = state.offset + lines.length;
  const nextCursor = page.hasMore ? encodeCursor("repo_search", signatureInput, { offset: nextOffset }) : null;
  return {
    status: "ok", query, glob, includeSensitive, cwd: authority.effectiveCwd, trustedAncestor: authority.trustedAncestor ?? null,
    permissionProfile: ":read-only", offset: state.offset, count: lines.length, results: lines,
    stdout: lines.length ? `${lines.join("\n")}\n` : "", hasMore: Boolean(page.hasMore), nextCursor, modelTurnStarted: false,
  };
}

function projectCommandResult(result, extra = {}) {
  return {
    status: result.exitCode === 0 ? "ok" : "failed", exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr,
    stdoutTruncated: result.stdoutTruncated === true, stderrTruncated: result.stderrTruncated === true,
    cwd: result.effectiveCwd ?? null, permissionProfile: result.permissionProfile ?? null, permissionCeiling: result.permissionCeiling ?? null,
    authoritySource: result.authoritySource ?? null, trustedAncestor: result.trustedAncestor ?? null, modelTurnStarted: false, ...extra,
  };
}
function inputError(message, code = "INVALID_INPUT") { const error = new Error(message); error.code = code; error.category = "input"; error.retryable = false; return error; }
function runtimeError(message) { const error = new Error(message); error.code = "REPO_SEARCH_FAILED"; error.category = "runtime"; error.retryable = false; return error; }
