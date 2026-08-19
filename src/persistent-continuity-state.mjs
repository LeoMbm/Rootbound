import { randomUUID } from "node:crypto";
import path from "node:path";
import { projectRefForRoot } from "./project-registry.mjs";

const DEFAULT_TTL_MS = 12 * 60 * 60_000;
const DEFAULT_MAX_BINDINGS = 100;
const DEFAULT_MAX_JOURNAL_ENTRIES = 200;

export function createPersistentContinuityState({ store, ttlMs = DEFAULT_TTL_MS, maxBindings = DEFAULT_MAX_BINDINGS, maxJournalEntries = DEFAULT_MAX_JOURNAL_ENTRIES, now = () => Date.now() } = {}) {
  if (!store) throw new Error("persistent continuity requires a state store");
  if (!Number.isInteger(ttlMs) || ttlMs < 60_000) throw new Error("continuity ttlMs must be at least 60000");
  if (!Number.isInteger(maxBindings) || maxBindings < 1 || maxBindings > 10_000) throw new Error("continuity maxBindings must be 1..10000");
  if (!Number.isInteger(maxJournalEntries) || maxJournalEntries < 10 || maxJournalEntries > 10_000) throw new Error("continuity maxJournalEntries must be 10..10000");

  function cleanup() {
    store.deleteBindingsTouchedBefore(now() - ttlMs);
    const bindings = store.listBindings();
    for (const binding of bindings.slice(maxBindings)) store.deleteBinding(binding.bindingRef);
  }
  function getRequired(bindingRef, { touch = true } = {}) {
    cleanup();
    if (typeof bindingRef !== "string" || !bindingRef.startsWith("binding_")) throw new Error("invalid continuity bindingRef");
    const binding = store.getBinding(bindingRef);
    if (!binding) throw new Error("continuity binding is unknown or expired; bind the Codex thread again");
    if (touch) { binding.touchedAt = now(); store.upsertBinding(binding); }
    return binding;
  }
  function ensureProject(cwd) {
    const root = path.resolve(cwd);
    let project = store.getProjectByRoot(root);
    if (!project) {
      const at = now();
      project = store.upsertProject({ projectRef: projectRefForRoot(root), root, gitRoot: null, name: path.basename(root), trusted: false, createdAt: at, updatedAt: at, lastConnectedAt: null });
    }
    return project;
  }

  return {
    bind({ threadId, cwd, threadPreview = null }) {
      if (typeof threadId !== "string" || !threadId) throw new Error("continuity bind requires threadId");
      if (typeof cwd !== "string" || !cwd) throw new Error("continuity bind requires cwd");
      cleanup();
      const project = ensureProject(cwd);
      const at = now();
      const binding = store.upsertBinding({ bindingRef: `binding_${randomUUID()}`, projectRef: project.projectRef, threadId, threadPreview, createdAt: at, touchedAt: at, checkpointCount: 0, lastCheckpointAt: null, lastAckSeq: 0 });
      return publicBinding(binding, store);
    },
    bindOrReuse({ threadId, cwd, threadPreview = null }) {
      if (typeof threadId !== "string" || !threadId) throw new Error("continuity bind requires threadId");
      if (typeof cwd !== "string" || !cwd) throw new Error("continuity bind requires cwd");
      cleanup();
      const project = ensureProject(cwd);
      const existing = store.getBindingByProjectThread(project.projectRef, threadId);
      if (!existing) return { ...this.bind({ threadId, cwd, threadPreview }), reused: false };
      existing.touchedAt = now();
      if (threadPreview !== null && threadPreview !== undefined) existing.threadPreview = threadPreview;
      store.upsertBinding(existing);
      return { ...publicBinding(existing, store), reused: true };
    },
    status(bindingRef) { return publicBinding(getRequired(bindingRef), store); },
    resolve(bindingRef) {
      const binding = getRequired(bindingRef);
      const project = store.getProject(binding.projectRef);
      if (!project) throw new Error("continuity project is missing");
      return { bindingRef: binding.bindingRef, threadId: binding.threadId, cwd: project.root, threadPreview: binding.threadPreview };
    },
    assertCwd(bindingRef, candidateCwd = null) {
      const binding = getRequired(bindingRef);
      const project = store.getProject(binding.projectRef);
      if (!project) throw new Error("continuity project is missing");
      const target = candidateCwd === null ? project.root : path.isAbsolute(candidateCwd) ? path.resolve(candidateCwd) : path.resolve(project.root, candidateCwd);
      if (!isPathWithin(project.root, target)) throw new Error(`continuity binding is scoped to ${project.root}; refused action cwd ${target}`);
      return { bindingRef: binding.bindingRef, threadId: binding.threadId, cwd: project.root, targetCwd: target };
    },
    record(bindingRef, event) {
      if (!bindingRef) return null;
      const binding = getRequired(bindingRef);
      const payload = sanitizeJournalEvent(event);
      const at = now();
      const seq = store.recordEvent({ projectRef: binding.projectRef, bindingRef, kind: payload.kind, payload: withoutKind(payload), createdAt: at });
      const rows = store.listBindingEventsAfter(bindingRef, binding.lastAckSeq, maxJournalEntries + 1);
      if (rows.length > maxJournalEntries) store.deleteBindingEventsThrough(bindingRef, rows[rows.length - maxJournalEntries - 1].seq);
      return { seq, at, ...payload };
    },
    prepareCheckpoint(bindingRef) {
      const binding = getRequired(bindingRef);
      const project = store.getProject(binding.projectRef);
      const journal = store.listBindingEventsAfter(bindingRef, binding.lastAckSeq, maxJournalEntries);
      const throughSeq = journal.length ? journal[journal.length - 1].seq : binding.lastAckSeq;
      return { binding: publicBinding(binding, store), threadId: binding.threadId, cwd: project.root, journal, throughSeq };
    },
    acknowledgeCheckpoint(bindingRef, throughSeq) {
      const binding = getRequired(bindingRef);
      if (!Number.isInteger(throughSeq) || throughSeq < binding.lastAckSeq) throw new Error("invalid continuity checkpoint sequence");
      binding.lastAckSeq = throughSeq;
      binding.checkpointCount += 1;
      binding.lastCheckpointAt = now();
      binding.touchedAt = now();
      store.upsertBinding(binding);
      store.addCheckpoint({ checkpointId: `checkpoint_${randomUUID()}`, projectRef: binding.projectRef, bindingRef, throughSeq, createdAt: binding.lastCheckpointAt, payload: { threadId: binding.threadId } });
      const pending = store.listBindingEventsAfter(bindingRef, throughSeq, maxJournalEntries);
      if (pending.length < maxJournalEntries / 2) store.deleteBindingEventsThrough(bindingRef, throughSeq);
      return publicBinding(binding, store);
    },
    unbind(bindingRef) {
      cleanup();
      const binding = store.getBinding(bindingRef);
      if (!binding) return { status: "not_found", bindingRef };
      store.deleteBindingEventsThrough(bindingRef, Number.MAX_SAFE_INTEGER);
      store.deleteBinding(bindingRef);
      return { status: "unbound", bindingRef, threadId: binding.threadId };
    },
  };
}

function publicBinding(binding, store) {
  const pending = store.listBindingEventsAfter(binding.bindingRef, binding.lastAckSeq, 10_000);
  return { bindingRef: binding.bindingRef, threadId: binding.threadId, projectRef: binding.projectRef, threadPreview: binding.threadPreview,
    createdAt: binding.createdAt, touchedAt: binding.touchedAt, checkpointCount: binding.checkpointCount, lastCheckpointAt: binding.lastCheckpointAt, pendingJournalEntries: pending.length };
}
function isPathWithin(root, target) { const relative = path.relative(path.resolve(root), path.resolve(target)); return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)); }
function sanitizeJournalEvent(event) {
  const value = event && typeof event === "object" ? event : {}; const kind = typeof value.kind === "string" ? value.kind.slice(0, 64) : "activity"; const output = { kind };
  for (const key of ["label", "path", "cwd", "status", "exitCode", "changed", "previewOnly"]) { const child = value[key]; if (child === undefined || child === null) continue; if (typeof child === "string") output[key] = child.slice(0, 4096); else if (typeof child === "number" || typeof child === "boolean") output[key] = child; }
  return output;
}
function withoutKind(value) { const { kind, ...rest } = value; return rest; }
