import { createRequire } from "node:module";
import path from "node:path";
import { decodeCursor, encodeCursor } from "./pagination.mjs";
import { typedToolResponse } from "./tool-errors.mjs";

const require = createRequire(import.meta.url);
const z = require("zod/v4");
const bindingRefSchema = z.string().regex(/^binding_[0-9a-f-]{36}$/i).optional();
const rescueRefSchema = z.string().regex(/^rescue_[0-9a-f-]{36}$/i).optional();
const cwdSchema = z.string().min(1).max(32_768).optional();
const SEARCH_PAGE_SCRIPT = String.raw`
const fs=require('node:fs');
const path=require('node:path');
const readline=require('node:readline');
const {spawnSync}=require('node:child_process');
const options=JSON.parse(Buffer.from(process.argv[1],'base64').toString('utf8'));
const offset=Number(process.argv[2]);
const limit=Number(process.argv[3]);
const root=process.cwd();
const OUTPUT_BUDGET=20*1024;
const MAX_RESULT_CHARS=1200;
const ALWAYS_SKIP_DIRS=new Set(['.git','.hg','.svn','node_modules']);
let pattern=String(options.query||'');
let flags='';
if(pattern.startsWith('(?i)')){pattern=pattern.slice(4);flags='i';}
let regex;
let regexError=null;
try{regex=new RegExp(pattern,flags);}catch(error){regexError='invalid search pattern: '+error.message;}

function finish(value){process.stdout.write(JSON.stringify(value));}
function normalizeRelative(value){return String(value).split(path.sep).join('/').replace(/^\.\//,'');}
function isHidden(rel){return normalizeRelative(rel).split('/').some((part)=>part.startsWith('.')&&part!=='.'&&part!=='..');}
function isSensitive(rel){
  const base=path.basename(rel).toLowerCase();
  return base==='.env'||base.startsWith('.env.')||/\.(?:pem|key|p12|pfx)$/.test(base)||base.startsWith('credentials')||base.startsWith('secrets');
}
function matchesGlob(rel,rawPattern){
  if(!rawPattern)return true;
  const normalized=normalizeRelative(rel);
  const negated=rawPattern.startsWith('!');
  const glob=negated?rawPattern.slice(1):rawPattern;
  let matched=false;
  if(typeof path.matchesGlob==='function'){
    try{
      matched=path.matchesGlob(normalized,glob)||(!glob.includes('/')&&path.matchesGlob(path.basename(normalized),glob));
    }catch{return false;}
  }else{
    const escaped=glob.replace(/[-/\\^$*+?.()|[\]{}]/g,'\\$&').replace(/\\\*\\\*/g,'__DOUBLE_STAR__').replace(/\\\*/g,'[^/]*').replace(/\\\?/g,'[^/]').replace(/__DOUBLE_STAR__/g,'.*');
    try{matched=new RegExp('^'+escaped+'$').test(normalized)||(!glob.includes('/')&&new RegExp('^'+escaped+'$').test(path.basename(normalized)));}catch{return false;}
  }
  return negated?!matched:matched;
}
function eligible(rel){
  const normalized=normalizeRelative(rel);
  if(!normalized)return false;
  const parts=normalized.split('/');
  if(parts.some((part)=>ALWAYS_SKIP_DIRS.has(part)))return false;
  if(!options.includeSensitive&&isHidden(normalized))return false;
  if(!options.includeSensitive&&isSensitive(normalized))return false;
  return matchesGlob(normalized,options.glob||null);
}
function gitCandidates(){
  try{
    const result=spawnSync('git',['ls-files','-co','--exclude-standard','-z'],{cwd:root,windowsHide:true,shell:false,maxBuffer:64*1024*1024});
    if(!result.error&&result.status===0){
      return Buffer.from(result.stdout||[]).toString('utf8').split('\0').filter(Boolean).map(normalizeRelative).sort();
    }
  }catch{}
  return null;
}
function walkCandidates(){
  const rows=[];
  function visit(abs,rel){
    let entries;
    try{entries=fs.readdirSync(abs,{withFileTypes:true});}catch{return;}
    entries.sort((a,b)=>a.name.localeCompare(b.name));
    for(const entry of entries){
      const childRel=rel?rel+'/'+entry.name:entry.name;
      if(entry.isSymbolicLink())continue;
      if(entry.isDirectory()){
        if(ALWAYS_SKIP_DIRS.has(entry.name))continue;
        if(!options.includeSensitive&&entry.name.startsWith('.'))continue;
        visit(path.join(abs,entry.name),childRel);
      }else if(entry.isFile())rows.push(childRel);
    }
  }
  visit(root,'');
  return rows;
}
function isBinary(abs){
  let fd;
  try{
    fd=fs.openSync(abs,'r');
    const sample=Buffer.allocUnsafe(8192);
    const read=fs.readSync(fd,sample,0,sample.length,0);
    return sample.subarray(0,read).includes(0);
  }catch{return true;}finally{if(fd!==undefined){try{fs.closeSync(fd);}catch{}}}
}
function formatResult(rel,lineNumber,column,line){
  let value=normalizeRelative(rel)+':'+lineNumber+':'+column+':'+line;
  if(value.length>MAX_RESULT_CHARS)value=value.slice(0,MAX_RESULT_CHARS-1)+'…';
  return value;
}

(async()=>{
  if(regexError){finish({ok:false,error:regexError});return;}
  const candidates=(options.includeSensitive?walkCandidates():(gitCandidates()||walkCandidates())).filter(eligible);
  const page=[];
  let seen=0;
  let outputBytes=256;
  let hasMore=false;
  outer: for(const rel of candidates){
    const abs=path.resolve(root,rel);
    let info;
    try{info=fs.lstatSync(abs);}catch{continue;}
    if(!info.isFile()||info.isSymbolicLink()||isBinary(abs))continue;
    let stream;
    try{
      stream=fs.createReadStream(abs,{encoding:'utf8'});
      const lines=readline.createInterface({input:stream,crlfDelay:Infinity});
      let lineNumber=0;
      for await(const line of lines){
        lineNumber++;
        const match=regex.exec(line);
        if(!match)continue;
        seen++;
        if(seen<=offset)continue;
        if(page.length>=limit){hasMore=true;lines.close();stream.destroy();break outer;}
        const column=Buffer.byteLength(line.slice(0,match.index),'utf8')+1;
        const result=formatResult(rel,lineNumber,column,line);
        const resultBytes=Buffer.byteLength(JSON.stringify(result),'utf8')+1;
        if(page.length&&outputBytes+resultBytes>OUTPUT_BUDGET){hasMore=true;lines.close();stream.destroy();break outer;}
        page.push(result);
        outputBytes+=resultBytes;
      }
    }catch{try{stream?.destroy();}catch{}}
  }
  finish({ok:true,page,hasMore,scanned:seen,engine:'node'});
})().catch((error)=>finish({ok:false,error:error&&error.message?error.message:String(error)}));
`;

export function registerRepoTools(server, { authorityExecutor, continuityState = null, rescueManager = null, getSessionKey = null }) {
  if (!authorityExecutor) return;

  server.registerTool(
    "codex.repo_search",
    {
      title: "Search Authorized Project",
      description: "Search text in an authorized project with globally paginated results. Common secret-bearing files (.env, private keys, credentials/secrets) are excluded by default; set includeSensitive=true only for an intentional sensitive search. No Codex model turn is started.",
      inputSchema: z.object({
        query: z.string().min(1).max(8_192),
        cwd: cwdSchema,
        glob: z.string().min(1).max(4_096).optional(),
        maxResults: z.number().int().min(1).max(200).default(100),
        cursor: z.string().max(2_048).optional(),
        includeSensitive: z.boolean().default(false),
        rescueRef: rescueRefSchema,
        bindingRef: bindingRefSchema,
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ query, cwd, glob, maxResults, cursor, includeSensitive, rescueRef, bindingRef }, ctx) => typedToolResponse(async () => {
      const resolved = rescueManager && getSessionKey ? rescueManager.resolveBinding({ sessionKey: getSessionKey(ctx), cwd, explicitBindingRef: bindingRef, rescueRef }) : { bindingRef: bindingRef ?? null };
      const scoped = resolved.bindingRef && continuityState ? continuityState.assertCwd(resolved.bindingRef, cwd) : null;
      return searchPageAuthorized({ authorityExecutor, query, cwd: scoped?.targetCwd ?? cwd, glob, maxResults, cursor, includeSensitive });
    }, { operation: "repo_search" })
  );

  server.registerTool("codex.git_status", {
    title: "Read Git Status",
    description: "Read git status for an authorized project via official Codex command/exec with read-only authority. Does not start a Codex model turn.",
    inputSchema: z.object({ cwd: cwdSchema, rescueRef: rescueRefSchema, bindingRef: bindingRefSchema }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ cwd, rescueRef, bindingRef }, ctx) => typedToolResponse(async () => {
    const resolved = rescueManager && getSessionKey ? rescueManager.resolveBinding({ sessionKey: getSessionKey(ctx), cwd, explicitBindingRef: bindingRef, rescueRef }) : { bindingRef: bindingRef ?? null };
    const scoped = resolved.bindingRef && continuityState ? continuityState.assertCwd(resolved.bindingRef, cwd) : null;
    const result = await authorityExecutor.exec({ command: ["git", "status", "--short", "--branch"], cwd: scoped?.targetCwd ?? cwd, access: "readOnly", timeoutMs: 10_000 });
    return projectCommandResult(result);
  }, { operation: "git_status", isError: (payload) => payload?.status === "failed" }));

  server.registerTool("codex.git_diff", {
    title: "Read Git Diff",
    description: "Read the current git diff for an authorized project via official Codex command/exec with read-only authority. Can read staged or unstaged changes without starting a Codex model turn.",
    inputSchema: z.object({ cwd: cwdSchema, staged: z.boolean().default(false), pathspec: z.array(z.string().min(1).max(4_096)).max(50).default([]), rescueRef: rescueRefSchema, bindingRef: bindingRefSchema }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ cwd, staged, pathspec, rescueRef, bindingRef }, ctx) => typedToolResponse(async () => {
    const resolved = rescueManager && getSessionKey ? rescueManager.resolveBinding({ sessionKey: getSessionKey(ctx), cwd, explicitBindingRef: bindingRef, rescueRef }) : { bindingRef: bindingRef ?? null };
    const scoped = resolved.bindingRef && continuityState ? continuityState.assertCwd(resolved.bindingRef, cwd) : null;
    const command = ["git", "diff"];
    if (staged) command.push("--cached");
    if (pathspec.length) command.push("--", ...pathspec);
    const result = await authorityExecutor.exec({ command, cwd: scoped?.targetCwd ?? cwd, access: "readOnly", timeoutMs: 15_000 });
    return projectCommandResult(result, { staged, pathspec });
  }, { operation: "git_diff", isError: (payload) => payload?.status === "failed" }));

  server.registerTool("codex.apply_patch", {
    title: "Apply Authorized Project Patch",
    description: "Apply an OpenAI apply_patch patch generated by ChatGPT through official Codex command/exec. The patch is executed under the locally resolved Codex permission profile and does not start a Codex model turn. Use this for coherent multi-file edits; use precise_edit for guarded exact-text replacements.",
    inputSchema: z.object({ patch: z.string().min(1).max(500_000), cwd: cwdSchema, rescueRef: rescueRefSchema, bindingRef: bindingRefSchema }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, async ({ patch, cwd, rescueRef, bindingRef }, ctx) => typedToolResponse(async () => {
    if (!patch.startsWith("*** Begin Patch") || !patch.includes("*** End Patch")) throw inputError("apply_patch payload must use the *** Begin Patch / *** End Patch format");
    const resolved = rescueManager && getSessionKey ? rescueManager.resolveBinding({ sessionKey: getSessionKey(ctx), cwd, explicitBindingRef: bindingRef, rescueRef }) : { bindingRef: bindingRef ?? null, rescue: null, implicit: false };
    const effectiveBindingRef = resolved.bindingRef;
    if (resolved.rescue) await rescueManager.assertNoDrift(resolved.rescue);
    const scoped = effectiveBindingRef && continuityState ? continuityState.assertCwd(effectiveBindingRef, cwd) : null;
    const effectiveCwd = scoped?.targetCwd ?? cwd ?? resolved.rescue?.projectRoot;
    const patchPaths = resolved.rescue ? pathsFromApplyPatch(patch).map((value) => path.resolve(effectiveCwd ?? resolved.rescue.projectRoot, value)) : [];
    const rescueBefore = resolved.rescue ? await rescueManager.captureSnapshots(resolved.rescue, patchPaths) : null;
    const result = await authorityExecutor.exec({ command: ["apply_patch", patch], cwd: scoped?.targetCwd ?? cwd, access: "inherit", timeoutMs: 30_000 });
    if (effectiveBindingRef && continuityState) continuityState.record(effectiveBindingRef, { kind: "patch", cwd: result.effectiveCwd, status: result.exitCode === 0 ? "applied" : "failed", exitCode: result.exitCode });
    const updatedRescue = resolved.rescue
      ? await rescueManager.recordSnapshotsAfter(resolved.rescue, { operation: "apply_patch", before: rescueBefore })
      : resolved.rescue;
    return projectCommandResult(result, { continuityJournaled: Boolean(effectiveBindingRef), ...(resolved.implicit && updatedRescue ? { rescueSession: rescueManager.publicSession(updatedRescue) } : {}) });
  }, { operation: "apply_patch", isError: (payload) => payload?.status === "failed" }));
}

export function pathsFromApplyPatch(patch) {
  const paths = [];
  for (const line of String(patch).split(/\r?\n/)) {
    const match = line.match(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/) ?? line.match(/^\*\*\* Move to: (.+)$/);
    if (match?.[1]) paths.push(match[1].trim());
  }
  return [...new Set(paths)];
}

export async function searchPageAuthorized({ authorityExecutor, query, cwd, glob = null, maxResults = 100, cursor = null, includeSensitive = false }) {
  const authority = await authorityExecutor.resolveAuthority({ cwd, access: "readOnly", timeoutMs: 10_000 });
  const signatureInput = { query, glob, cwd: authority.effectiveCwd, includeSensitive };
  const state = decodeCursor(cursor, "repo_search", signatureInput) ?? { offset: 0 };
  if (!Number.isInteger(state.offset) || state.offset < 0) throw inputError("Pagination cursor contains an invalid search offset.", "PAGINATION_CURSOR_INVALID");
  const pagerOptions = { query, glob, includeSensitive };
  const result = await authorityExecutor.exec({
    command: [process.execPath, "-e", SEARCH_PAGE_SCRIPT, Buffer.from(JSON.stringify(pagerOptions), "utf8").toString("base64"), String(state.offset), String(maxResults)],
    cwd: authority.effectiveCwd,
    access: "readOnly",
    timeoutMs: 20_000,
  });
  if (result.exitCode !== 0) throw runtimeError(`repo_search pager failed: ${result.stderr || `exit ${result.exitCode}`}`);
  let page;
  try { page = JSON.parse(result.stdout); } catch { throw runtimeError("repo_search pager returned invalid JSON"); }
  if (!page?.ok) throw runtimeError(`repo_search failed: ${page?.error ?? page?.stderr ?? "unknown search failure"}`);
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
