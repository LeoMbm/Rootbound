import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { isSensitivePath } from "./secret-boundaries.mjs";
import { RootboundToolError } from "./tool-errors.mjs";

const FINGERPRINT_SCRIPT = String.raw`
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
const cwd=process.cwd();
const cap=500;
function git(args){
  const r=spawnSync('git',args,{cwd,encoding:'utf8',windowsHide:true,shell:false,maxBuffer:16*1024*1024});
  if(r.error||r.status!==0)return null;
  return String(r.stdout||'').replace(/\r?\n$/,'');
}
function fileState(rel){
  const abs=path.resolve(cwd,rel);
  try{
    const st=fs.lstatSync(abs);
    if(st.isSymbolicLink())return {path:rel,kind:'symlink',sha256:crypto.createHash('sha256').update(fs.readlinkSync(abs)).digest('hex'),index:git(['ls-files','-s','--',rel])};
    if(st.isFile())return {path:rel,kind:'file',sha256:crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex'),index:git(['ls-files','-s','--',rel])};
    return {path:rel,kind:'other',sha256:null,index:git(['ls-files','-s','--',rel])};
  }catch{return {path:rel,kind:'missing',sha256:null,index:git(['ls-files','-s','--',rel])};}
}
const root=git(['rev-parse','--show-toplevel']);
const head=git(['rev-parse','HEAD']);
const branch=git(['branch','--show-current']);
const origin=git(['remote','get-url','origin']);
const status=git(['status','--porcelain=v1','-z','--untracked-files=all'])||'';
const tokens=status.split('\0').filter(Boolean);
const paths=[];
for(let i=0;i<tokens.length;i++){
  const token=tokens[i];
  if(token.length>=3&&token[2]===' '){
    const code=token.slice(0,2); const rel=token.slice(3); if(rel)paths.push(rel);
    if(/[RC]/.test(code)&&tokens[i+1])paths.push(tokens[++i]);
  }
}
const unique=[...new Set(paths)].sort();
const degraded=unique.length>cap;
const files=unique.slice(0,cap).map(fileState);
const core={root,head,branch:branch||null,origin:origin||null,status,files,degraded,totalChangedPaths:unique.length};
core.fingerprintHash=crypto.createHash('sha256').update(JSON.stringify(core)).digest('hex');
core.dirty=Boolean(status);
core.changes=unique.slice(0,100);
process.stdout.write(JSON.stringify(core));
`;

const SNAPSHOT_SCRIPT = String.raw`
const fs=require('node:fs');
const crypto=require('node:crypto');
const p=process.argv[1];
try{
  const st=fs.lstatSync(p);
  if(!st.isFile()){process.stdout.write(JSON.stringify({exists:true,regular:false}));process.exit(0);}
  const data=fs.readFileSync(p);
  process.stdout.write(JSON.stringify({exists:true,regular:true,sha256:crypto.createHash('sha256').update(data).digest('hex'),bytes:data.length,textBase64:data.toString('base64')}));
}catch(error){
  if(error&&error.code==='ENOENT'){process.stdout.write(JSON.stringify({exists:false,regular:true,sha256:null,bytes:0,textBase64:null}));process.exit(0);}
  throw error;
}
`;

const RESTORE_SCRIPT = String.raw`
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const p=process.argv[1];
const expectedExists=process.argv[2]==='1';
const expectedSha=process.argv[3]||'';
const beforeExists=process.argv[4]==='1';
const beforeText=process.argv[5]?Buffer.from(process.argv[5],'base64'):null;
let currentExists=true,current=null;
try{current=fs.readFileSync(p);}catch(error){if(error&&error.code==='ENOENT')currentExists=false;else throw error;}
if(currentExists!==expectedExists){console.error('rescue rollback refused: file existence changed');process.exit(12);}
if(currentExists){const sha=crypto.createHash('sha256').update(current).digest('hex');if(sha!==expectedSha){console.error('rescue rollback refused: file hash changed');process.exit(13);}}
if(beforeExists){fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,beforeText);}else if(currentExists){fs.unlinkSync(p);}
`;

export function createRescueSessionManager({ store, authorityExecutor, continuityState, now = () => Date.now() } = {}) {
  if (!store || !authorityExecutor || !continuityState) throw new Error("rescue session manager requires store, authorityExecutor, and continuityState");

  function touch(session, patch = {}) {
    return store.upsertRescueSession({ ...session, ...patch, touchedAt: now() });
  }

  function projectForCwd(cwd) {
    if (typeof cwd !== "string" || !cwd.trim()) return null;
    const target = path.resolve(cwd);
    const candidates = store.listProjects().filter((project) => isPathWithin(project.root, target));
    candidates.sort((a, b) => b.root.length - a.root.length);
    return candidates[0] ?? null;
  }

  function activeForRequest({ sessionKey = null, cwd = null, rescueRef = null } = {}) {
    if (rescueRef) {
      const session = store.getRescueSession(rescueRef);
      return session?.status === "active" ? session : null;
    }
    if (!sessionKey) return null;
    if (cwd) {
      const project = projectForCwd(cwd);
      if (project) return store.getActiveRescueSessionForProject(sessionKey, project.projectRef);
    }
    const active = store.listActiveRescueSessionsBySessionKey(sessionKey);
    return active.length === 1 ? active[0] : null;
  }

  return {
    async captureFingerprint(cwd) { return captureWorktreeFingerprint({ authorityExecutor, cwd }); },

    async start({ sessionKey = null, project, thread, bindingRef, match, quota = null }) {
      if (!project?.projectRef || !project?.root) throw new Error("rescue start requires a registered project");
      if (!thread?.id) throw new Error("rescue start requires a Codex thread");
      const fingerprint = await captureWorktreeFingerprint({ authorityExecutor, cwd: project.root });
      const at = now();
      store.replaceActiveRescueSessionsByBinding(bindingRef, at);
      if (sessionKey) {
        for (const existing of store.listActiveRescueSessionsBySessionKey(sessionKey)) {
          if (existing.projectRef === project.projectRef) touch(existing, { status: "replaced" });
        }
      }
      const rollbackReasons = fingerprint.degraded ? ["worktree_fingerprint_degraded"] : [];
      const session = store.upsertRescueSession({
        rescueRef: `rescue_${randomUUID()}`,
        sessionKey,
        projectRef: project.projectRef,
        threadId: thread.id,
        bindingRef,
        status: "active",
        match,
        baselineGit: publicGit(fingerprint),
        baselineFingerprint: fingerprint,
        expectedFingerprint: fingerprint,
        quota,
        rollbackCoverage: fingerprint.degraded ? "partial" : "complete",
        rollbackReasons,
        startedAt: at,
        touchedAt: at,
        handedOffAt: null,
      });
      store.recordEvent({ projectRef: project.projectRef, bindingRef, kind: "rescue.started", payload: { rescueRef: session.rescueRef, threadId: thread.id, match: match?.confidence ?? null }, createdAt: at });
      return session;
    },

    activeForRequest,

    activeByBinding(bindingRef) {
      return store.getActiveRescueSessionByBinding(bindingRef);
    },

    resolveBinding({ sessionKey = null, cwd = null, explicitBindingRef = null, rescueRef = null } = {}) {
      if (explicitBindingRef && rescueRef) {
        const rescue = activeForRequest({ rescueRef });
        if (!rescue || rescue.bindingRef !== explicitBindingRef) throw stateError("RESCUE_BINDING_MISMATCH", "The supplied rescueRef and bindingRef do not identify the same active rescue session.");
        return { bindingRef: explicitBindingRef, rescue, implicit: false };
      }
      if (explicitBindingRef) return { bindingRef: explicitBindingRef, rescue: null, implicit: false };
      const rescue = activeForRequest({ sessionKey, cwd, rescueRef });
      if (rescueRef && !rescue) {
        throw stateError("RESCUE_SESSION_NOT_FOUND", "The supplied rescueRef is unknown, inactive, or was replaced by a newer rescue session.");
      }
      return rescue ? { bindingRef: rescue.bindingRef, rescue, implicit: true } : { bindingRef: null, rescue: null, implicit: false };
    },

    async assertNoDrift(session) {
      if (!session) return null;
      const project = store.getProject(session.projectRef);
      if (!project) throw stateError("RESCUE_PROJECT_MISSING", "The rescue project no longer exists in Rootbound state.");
      const current = await captureWorktreeFingerprint({ authorityExecutor, cwd: project.root });
      if (current.fingerprintHash !== session.expectedFingerprint?.fingerprintHash) {
        throw new RootboundToolError("The workspace changed outside Rootbound after this rescue session's last known state.", {
          code: "CONTINUITY_DRIFT_DETECTED",
          category: "state",
          retryable: false,
          nextActions: ["Inspect git_status/git_diff and the changed files, then call continuity_resume again if the new state should become authoritative."],
          details: {
            rescueRef: session.rescueRef,
            expected: publicFingerprint(session.expectedFingerprint),
            current: publicFingerprint(current),
          },
        });
      }
      return current;
    },

    async refreshExpected(session, { rollbackSafe = true, reason = null } = {}) {
      if (!session) return null;
      const project = store.getProject(session.projectRef);
      const fingerprint = await captureWorktreeFingerprint({ authorityExecutor, cwd: project.root });
      const reasons = [...new Set([...(session.rollbackReasons ?? []), ...(!rollbackSafe && reason ? [reason] : []), ...(fingerprint.degraded ? ["worktree_fingerprint_degraded"] : [])])];
      return touch(session, {
        expectedFingerprint: fingerprint,
        rollbackCoverage: session.rollbackCoverage === "partial" || !rollbackSafe || fingerprint.degraded ? "partial" : "complete",
        rollbackReasons: reasons,
      });
    },

    markRollbackPartial(session, reason) {
      if (!session) return null;
      return touch(session, { rollbackCoverage: "partial", rollbackReasons: [...new Set([...(session.rollbackReasons ?? []), reason])] });
    },

    async captureSnapshots(session, paths) {
      if (!session) return { snapshots: [], rollbackSafe: false, reasons: ["no_rescue_session"] };
      const project = store.getProject(session.projectRef);
      const snapshots = [];
      const reasons = [];
      for (const requested of [...new Set(paths.map(String))]) {
        const target = path.resolve(project.root, requested);
        if (!isPathWithin(project.root, target)) throw stateError("RESCUE_PATH_OUTSIDE_PROJECT", `Rescue snapshot refused path outside project: ${target}`);
        if (isSensitivePath(target)) { reasons.push(`sensitive_path:${path.relative(project.root, target)}`); continue; }
        try {
          const snapshot = await captureFileSnapshot({ authorityExecutor, cwd: project.root, target });
          if (!snapshot.regular || snapshot.bytes > 512 * 1024) { reasons.push(`snapshot_unsupported:${path.relative(project.root, target)}`); continue; }
          snapshots.push({ path: target, ...snapshot });
        } catch {
          reasons.push(`snapshot_failed:${path.relative(project.root, target)}`);
        }
      }
      return { snapshots, rollbackSafe: reasons.length === 0, reasons };
    },

    async recordSnapshotsAfter(session, { operation, before }) {
      if (!session) return null;
      const project = store.getProject(session.projectRef);
      let safe = true;
      const reasons = [];
      for (const prior of before.snapshots ?? []) {
        let after;
        try { after = await captureFileSnapshot({ authorityExecutor, cwd: project.root, target: prior.path }); }
        catch { safe = false; reasons.push(`after_snapshot_failed:${path.relative(project.root, prior.path)}`); continue; }
        if (!after.regular || after.bytes > 512 * 1024) { safe = false; reasons.push(`after_snapshot_unsupported:${path.relative(project.root, prior.path)}`); continue; }
        if (prior.exists === after.exists && prior.sha256 === after.sha256) continue;
        store.addRescueMutation({
          rescueRef: session.rescueRef,
          operation,
          path: prior.path,
          beforeExists: prior.exists,
          beforeSha256: prior.sha256,
          beforeText: prior.text,
          afterExists: after.exists,
          afterSha256: after.sha256,
          createdAt: now(),
        });
      }
      for (const reason of [...(before.reasons ?? []), ...reasons]) this.markRollbackPartial(session, reason);
      return this.refreshExpected(store.getRescueSession(session.rescueRef), { rollbackSafe: before.rollbackSafe && safe, reason: before.rollbackSafe && safe ? null : "mutation_snapshot_incomplete" });
    },

    async rollback(session) {
      if (!session) throw stateError("RESCUE_SESSION_NOT_FOUND", "No active rescue session is available for rollback.");
      await this.assertNoDrift(session);
      const currentSession = store.getRescueSession(session.rescueRef);
      if (currentSession.rollbackCoverage !== "complete") {
        throw new RootboundToolError("Rootbound cannot prove a complete safe rollback for this rescue session.", {
          code: "RESCUE_ROLLBACK_UNSAFE",
          category: "state",
          retryable: false,
          nextActions: ["Inspect the current diff and revert manually, or start a new rescue from the current authoritative worktree."],
          details: { rescueRef: currentSession.rescueRef, reasons: currentSession.rollbackReasons },
        });
      }
      const project = store.getProject(currentSession.projectRef);
      const mutations = store.listRescueMutations(currentSession.rescueRef, { reverse: true });
      for (const mutation of mutations) {
        const result = await authorityExecutor.exec({
          command: [process.execPath, "-e", RESTORE_SCRIPT, mutation.path, mutation.afterExists ? "1" : "0", mutation.afterSha256 ?? "", mutation.beforeExists ? "1" : "0", mutation.beforeText === null ? "" : Buffer.from(mutation.beforeText, "utf8").toString("base64")],
          cwd: project.root,
          access: "inherit",
          timeoutMs: 15_000,
        });
        if (result.exitCode !== 0) {
          throw new RootboundToolError(`Rescue rollback refused for ${mutation.path}: ${result.stderr || `exit ${result.exitCode}`}`, {
            code: "RESCUE_ROLLBACK_CONFLICT",
            category: "state",
            retryable: false,
            nextActions: ["Inspect the file that diverged; Rootbound will not overwrite external changes."],
          });
        }
      }
      const fingerprint = await captureWorktreeFingerprint({ authorityExecutor, cwd: project.root });
      if (fingerprint.fingerprintHash !== currentSession.baselineFingerprint?.fingerprintHash) {
        throw new RootboundToolError("Rescue rollback completed recorded restores, but the worktree does not equal the original rescue baseline.", {
          code: "RESCUE_ROLLBACK_BASELINE_MISMATCH",
          category: "state",
          retryable: false,
          nextActions: ["Inspect git_status/git_diff; Rootbound will not force-reset the repository."],
          details: { baseline: publicFingerprint(currentSession.baselineFingerprint), current: publicFingerprint(fingerprint) },
        });
      }
      store.deleteRescueMutations(currentSession.rescueRef);
      const ended = touch(currentSession, { status: "rolled_back", expectedFingerprint: fingerprint });
      store.recordEvent({ projectRef: project.projectRef, bindingRef: ended.bindingRef, kind: "rescue.rolled_back", payload: { rescueRef: ended.rescueRef, mutationCount: mutations.length }, createdAt: now() });
      return { status: "rolled_back", rescueRef: ended.rescueRef, restoredMutations: mutations.length, worktree: publicFingerprint(fingerprint), modelTurnStarted: false };
    },

    handoffComplete(session, quota = null) {
      if (!session) return null;
      return touch(session, { status: "handed_off", handedOffAt: now(), quota: quota ?? session.quota });
    },

    publicSession(session) {
      if (!session) return null;
      const project = store.getProject(session.projectRef);
      return {
        rescueRef: session.rescueRef,
        projectRef: session.projectRef,
        projectRoot: project?.root ?? null,
        threadId: session.threadId,
        status: session.status,
        match: session.match,
        baselineGit: session.baselineGit,
        rollbackCoverage: session.rollbackCoverage,
        rollbackReasons: session.rollbackReasons,
        startedAt: session.startedAt,
        touchedAt: session.touchedAt,
        handedOffAt: session.handedOffAt,
        implicitSessionAvailable: Boolean(session.sessionKey),
      };
    },
  };
}

export async function captureWorktreeFingerprint({ authorityExecutor, cwd }) {
  const authority = await authorityExecutor.resolveAuthority({ cwd, access: "readOnly", timeoutMs: 10_000 });
  const result = await authorityExecutor.exec({ command: [process.execPath, "-e", FINGERPRINT_SCRIPT], cwd: authority.effectiveCwd, access: "readOnly", timeoutMs: 20_000 });
  if (result.exitCode !== 0 || result.stdoutTruncated) throw stateError("WORKTREE_FINGERPRINT_FAILED", `Unable to capture worktree fingerprint: ${result.stderr || `exit ${result.exitCode}`}`);
  let parsed;
  try { parsed = JSON.parse(result.stdout); }
  catch { throw stateError("WORKTREE_FINGERPRINT_FAILED", "Worktree fingerprint returned invalid JSON."); }
  return parsed;
}

export function publicFingerprint(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    root: source.root ?? null,
    head: source.head ?? null,
    branch: source.branch ?? null,
    origin: source.origin ?? null,
    dirty: source.dirty === true,
    changes: Array.isArray(source.changes) ? source.changes.slice(0, 100) : [],
    degraded: source.degraded === true,
    totalChangedPaths: Number(source.totalChangedPaths ?? 0),
    fingerprintHash: source.fingerprintHash ?? null,
  };
}

export function publicGit(value) {
  return { head: value?.head ?? null, branch: value?.branch ?? null, origin: value?.origin ?? null };
}

async function captureFileSnapshot({ authorityExecutor, cwd, target }) {
  const result = await authorityExecutor.exec({ command: [process.execPath, "-e", SNAPSHOT_SCRIPT, target], cwd, access: "readOnly", timeoutMs: 15_000 });
  if (result.exitCode !== 0 || result.stdoutTruncated) throw new Error(`snapshot failed for ${target}`);
  const parsed = JSON.parse(result.stdout);
  return {
    exists: parsed.exists === true,
    regular: parsed.regular !== false,
    sha256: typeof parsed.sha256 === "string" ? parsed.sha256 : null,
    bytes: Number(parsed.bytes ?? 0),
    text: parsed.textBase64 ? Buffer.from(parsed.textBase64, "base64").toString("utf8") : null,
  };
}

function isPathWithin(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function stateError(code, message) {
  return new RootboundToolError(message, { code, category: "state", retryable: false });
}

export function hashJson(value) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
