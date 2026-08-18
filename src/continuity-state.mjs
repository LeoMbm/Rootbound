import { randomUUID } from "node:crypto";
import path from "node:path";

const DEFAULT_TTL_MS = 12 * 60 * 60_000;
const DEFAULT_MAX_BINDINGS = 100;
const DEFAULT_MAX_JOURNAL_ENTRIES = 200;

export function createContinuityState({
  ttlMs = DEFAULT_TTL_MS,
  maxBindings = DEFAULT_MAX_BINDINGS,
  maxJournalEntries = DEFAULT_MAX_JOURNAL_ENTRIES,
  now = () => Date.now(),
} = {}) {
  if (!Number.isInteger(ttlMs) || ttlMs < 60_000) throw new Error("continuity ttlMs must be at least 60000");
  if (!Number.isInteger(maxBindings) || maxBindings < 1 || maxBindings > 10_000) throw new Error("continuity maxBindings must be 1..10000");
  if (!Number.isInteger(maxJournalEntries) || maxJournalEntries < 10 || maxJournalEntries > 10_000) throw new Error("continuity maxJournalEntries must be 10..10000");

  const bindings = new Map();
  let nextSeq = 1;

  function cleanup() {
    const cutoff = now() - ttlMs;
    for (const [ref, binding] of bindings) {
      if (binding.touchedAt < cutoff) bindings.delete(ref);
    }
    if (bindings.size <= maxBindings) return;
    const oldest = [...bindings.entries()].sort((a, b) => a[1].touchedAt - b[1].touchedAt);
    for (let i = 0; i < oldest.length - maxBindings; i += 1) bindings.delete(oldest[i][0]);
  }

  function getRequired(bindingRef, { touch = true } = {}) {
    cleanup();
    if (typeof bindingRef !== "string" || !bindingRef.startsWith("binding_")) {
      throw new Error("invalid continuity bindingRef");
    }
    const binding = bindings.get(bindingRef);
    if (!binding) throw new Error("continuity binding is unknown or expired; bind the Codex thread again");
    if (touch) binding.touchedAt = now();
    return binding;
  }

  return {
    bind({ threadId, cwd, threadPreview = null }) {
      if (typeof threadId !== "string" || !threadId) throw new Error("continuity bind requires threadId");
      if (typeof cwd !== "string" || !cwd) throw new Error("continuity bind requires cwd");
      cleanup();
      const bindingRef = `binding_${randomUUID()}`;
      const at = now();
      bindings.set(bindingRef, {
        bindingRef,
        threadId,
        cwd: path.resolve(cwd),
        threadPreview,
        createdAt: at,
        touchedAt: at,
        checkpointCount: 0,
        lastCheckpointAt: null,
        lastAckSeq: 0,
        journal: [],
      });
      cleanup();
      return this.status(bindingRef);
    },

    status(bindingRef) {
      return publicBinding(getRequired(bindingRef));
    },

    resolve(bindingRef) {
      const binding = getRequired(bindingRef);
      return {
        bindingRef: binding.bindingRef,
        threadId: binding.threadId,
        cwd: binding.cwd,
        threadPreview: binding.threadPreview,
      };
    },

    assertCwd(bindingRef, candidateCwd = null) {
      const binding = getRequired(bindingRef);
      const target = path.resolve(candidateCwd ?? binding.cwd);
      if (!isPathWithin(binding.cwd, target)) {
        throw new Error(`continuity binding is scoped to ${binding.cwd}; refused action cwd ${target}`);
      }
      return { bindingRef: binding.bindingRef, threadId: binding.threadId, cwd: binding.cwd, targetCwd: target };
    },

    record(bindingRef, event) {
      if (!bindingRef) return null;
      const binding = getRequired(bindingRef);
      const entry = { seq: nextSeq++, at: now(), ...sanitizeJournalEvent(event) };
      binding.journal.push(entry);
      if (binding.journal.length > maxJournalEntries) binding.journal.splice(0, binding.journal.length - maxJournalEntries);
      binding.touchedAt = now();
      return structuredClone(entry);
    },

    prepareCheckpoint(bindingRef) {
      const binding = getRequired(bindingRef);
      const journal = binding.journal.filter((entry) => entry.seq > binding.lastAckSeq);
      const throughSeq = journal.length ? journal[journal.length - 1].seq : binding.lastAckSeq;
      return {
        binding: publicBinding(binding),
        threadId: binding.threadId,
        cwd: binding.cwd,
        journal: structuredClone(journal),
        throughSeq,
      };
    },

    acknowledgeCheckpoint(bindingRef, throughSeq) {
      const binding = getRequired(bindingRef);
      if (!Number.isInteger(throughSeq) || throughSeq < binding.lastAckSeq) throw new Error("invalid continuity checkpoint sequence");
      binding.lastAckSeq = throughSeq;
      binding.checkpointCount += 1;
      binding.lastCheckpointAt = now();
      binding.touchedAt = now();
      if (binding.journal.length > maxJournalEntries / 2) binding.journal = binding.journal.filter((entry) => entry.seq > binding.lastAckSeq);
      return publicBinding(binding);
    },

    unbind(bindingRef) {
      cleanup();
      const binding = bindings.get(bindingRef);
      if (!binding) return { status: "not_found", bindingRef };
      bindings.delete(bindingRef);
      return { status: "unbound", bindingRef, threadId: binding.threadId };
    },
  };
}

function isPathWithin(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function publicBinding(binding) {
  const pending = binding.journal.filter((entry) => entry.seq > binding.lastAckSeq);
  return {
    bindingRef: binding.bindingRef,
    threadId: binding.threadId,
    cwd: binding.cwd,
    threadPreview: binding.threadPreview,
    createdAt: binding.createdAt,
    touchedAt: binding.touchedAt,
    checkpointCount: binding.checkpointCount,
    lastCheckpointAt: binding.lastCheckpointAt,
    pendingJournalEntries: pending.length,
  };
}

function sanitizeJournalEvent(event) {
  const value = event && typeof event === "object" ? event : {};
  const kind = typeof value.kind === "string" ? value.kind.slice(0, 64) : "activity";
  const output = { kind };
  for (const key of ["label", "path", "cwd", "status", "exitCode", "changed", "previewOnly"]) {
    const child = value[key];
    if (child === undefined || child === null) continue;
    if (typeof child === "string") output[key] = child.slice(0, 4_096);
    else if (typeof child === "number" || typeof child === "boolean") output[key] = child;
  }
  return output;
}
