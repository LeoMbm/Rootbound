import { listActiveProjectRescues, replaceActiveProjectRescues } from "./rescue-persistence.mjs";
import { publicFingerprint } from "./rescue-continuity.mjs";
import { RootboundToolError } from "./tool-errors.mjs";

export function createDurableRescueManager({ base, store, now = () => Date.now() } = {}) {
  if (!base || !store) throw new Error("durable rescue manager requires base manager and state store");
  let startTail = Promise.resolve();

  async function withStartLock(fn) {
    const previous = startTail;
    let release;
    startTail = new Promise((resolve) => { release = resolve; });
    await previous;
    try { return await fn(); }
    finally { release(); }
  }

  async function startUnlocked(input) {
    const { sessionKey = null, project, thread } = input ?? {};
    const active = listActiveProjectRescues(store, project?.projectRef);
    if (active.length) {
      const current = await base.captureFingerprint(project.root);
      const primary = active[0];
      const expectedHash = primary.expectedFingerprint?.fingerprintHash ?? null;
      if (!expectedHash || expectedHash !== current.fingerprintHash) {
        throw new RootboundToolError("An existing Rootbound rescue for this project cannot be reattached because the worktree changed outside its last verified state.", {
          code: "DURABLE_RESCUE_DRIFT_DETECTED",
          category: "state",
          retryable: false,
          nextActions: ["Inspect git_status/git_diff and decide whether to hand off, roll back, or reconcile the existing rescue before starting another one."],
          details: {
            rescueRef: primary.rescueRef,
            expected: publicFingerprint(primary.expectedFingerprint),
            current: publicFingerprint(current),
          },
        });
      }
      if (primary.threadId !== thread?.id) {
        throw new RootboundToolError("An active Rootbound rescue already owns this project but targets a different Codex thread.", {
          code: "DURABLE_RESCUE_THREAD_CONFLICT",
          category: "state",
          retryable: false,
          nextActions: ["Finish or roll back the existing rescue before switching the project to another Codex thread."],
          details: { rescueRef: primary.rescueRef, activeThreadId: primary.threadId, requestedThreadId: thread?.id ?? null },
        });
      }

      replaceActiveProjectRescues(store, project.projectRef, { exceptRescueRef: primary.rescueRef, touchedAt: now() });
      const updated = store.upsertRescueSession({
        ...primary,
        sessionKey: sessionKey ?? primary.sessionKey,
        touchedAt: now(),
      });
      store.recordEvent({
        projectRef: project.projectRef,
        bindingRef: updated.bindingRef,
        kind: "rescue.reattached",
        payload: { rescueRef: updated.rescueRef, threadId: updated.threadId },
        createdAt: now(),
      });
      return { ...updated, reattached: true, baselineFingerprint: current };
    }

    replaceActiveProjectRescues(store, project?.projectRef, { touchedAt: now() });
    return base.start(input);
  }

  return {
    ...base,

    activeForProject(projectRef) {
      const rows = listActiveProjectRescues(store, projectRef);
      return rows.length ? rows[0] : null;
    },

    start(input) {
      return withStartLock(() => startUnlocked(input));
    },

    publicSession(session) {
      const value = base.publicSession(session);
      return value ? { ...value, reattached: session?.reattached === true } : value;
    },
  };
}
