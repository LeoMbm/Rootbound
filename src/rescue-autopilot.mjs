import path from "node:path";
import { latestProjectEvent } from "./rescue-persistence.mjs";
import { publicFingerprint } from "./rescue-continuity.mjs";
import { selectContinuationThread } from "./rescue-tools.mjs";

const ARMED_EVENT = "rescue.autopilot.armed";
const DISARMED_EVENT = "rescue.autopilot.disarmed";
const ERROR_EVENT = "rescue.autopilot.error";

export function createRescueAutopilot({
  publicContext,
  store,
  rescueManager,
  authorityExecutor,
  defaultCwd,
  thresholdPercent = 85,
  intervalMs = 60_000,
  now = () => Date.now(),
} = {}) {
  if (!publicContext || !store || !rescueManager || !authorityExecutor || !defaultCwd) {
    throw new Error("rescue autopilot requires public context, state store, rescue manager, authority executor, and default cwd");
  }
  if (!Number.isInteger(thresholdPercent) || thresholdPercent < 50 || thresholdPercent > 100) throw new Error("autopilot threshold must be an integer from 50 to 100");
  if (!Number.isInteger(intervalMs) || intervalMs < 10_000) throw new Error("autopilot interval must be at least 10 seconds");

  let timer = null;
  let inFlight = false;
  let closed = false;
  let lastState = { status: "idle", evaluatedAt: null };

  async function evaluate(trigger = "poll") {
    if (closed || inFlight) return lastState;
    inFlight = true;
    try {
      const project = projectForCwd(store, defaultCwd);
      if (!project) return setState({ status: "no_project", evaluatedAt: now() });
      if (rescueManager.activeForProject?.(project.projectRef)) {
        return setState({ status: "rescue_active", projectRef: project.projectRef, evaluatedAt: now() });
      }

      const quota = await publicContext.quotaSnapshot();
      const usedPercent = highestUsedPercent(quota);
      const exhausted = quota?.codex?.availability === "exhausted" || quota?.codex?.exhausted === true;
      const shouldArm = exhausted || (Number.isFinite(usedPercent) && usedPercent >= thresholdPercent);
      if (!shouldArm) {
        const armed = latestProjectEvent(store, project.projectRef, ARMED_EVENT);
        const disarmed = latestProjectEvent(store, project.projectRef, DISARMED_EVENT);
        if (armed && (!disarmed || disarmed.eventId < armed.eventId)) {
          store.recordEvent({
            projectRef: project.projectRef,
            kind: DISARMED_EVENT,
            payload: { reason: "quota_below_threshold", usedPercent, thresholdPercent, observedAt: quota?.observedAt ?? null },
            createdAt: now(),
          });
        }
        return setState({ status: "below_threshold", projectRef: project.projectRef, usedPercent, thresholdPercent, evaluatedAt: now() });
      }

      const fingerprint = await rescueManager.captureFingerprint(project.root);
      const resetAt = quota?.codex?.resetsAt ?? null;
      const armKey = `${fingerprint.fingerprintHash}:${resetAt ?? "none"}`;
      const previous = latestProjectEvent(store, project.projectRef, ARMED_EVENT);
      const disarmed = latestProjectEvent(store, project.projectRef, DISARMED_EVENT);
      if (previous?.payload?.armKey === armKey && (!disarmed || disarmed.eventId < previous.eventId)) {
        return setState({ status: "armed", projectRef: project.projectRef, threadId: previous.payload.threadId ?? null, usedPercent, thresholdPercent, reused: true, evaluatedAt: now() });
      }

      const selection = await selectContinuationThread({ context: publicContext, authorityExecutor, project, fingerprint });
      if (selection.status !== "ready") {
        return setState({ status: selection.status, projectRef: project.projectRef, usedPercent, thresholdPercent, evaluatedAt: now() });
      }

      const payload = {
        schemaVersion: 1,
        armKey,
        trigger,
        threadId: selection.thread.id,
        match: selection.match,
        fingerprintHash: fingerprint.fingerprintHash,
        fingerprint: publicFingerprint(fingerprint),
        quota: compactQuota(quota, usedPercent),
        thresholdPercent,
      };
      store.recordEvent({ projectRef: project.projectRef, kind: ARMED_EVENT, payload, createdAt: now() });
      return setState({ status: "armed", projectRef: project.projectRef, threadId: selection.thread.id, usedPercent, thresholdPercent, reused: false, evaluatedAt: now() });
    } catch (error) {
      const project = projectForCwd(store, defaultCwd);
      const safeMessage = safeErrorMessage(error?.message ?? String(error));
      if (project && !closed) {
        store.recordEvent({
          projectRef: project.projectRef,
          kind: ERROR_EVENT,
          payload: { name: error?.name ?? "Error", message: safeMessage, trigger },
          createdAt: now(),
        });
      }
      return setState({ status: "error", error: safeMessage, evaluatedAt: now() });
    } finally {
      inFlight = false;
    }
  }

  function start() {
    if (closed || timer) return;
    timer = setInterval(() => { void evaluate("poll"); }, intervalMs);
    timer.unref?.();
    void evaluate("startup");
  }

  async function close() {
    closed = true;
    if (timer) clearInterval(timer);
    timer = null;
    while (inFlight) await new Promise((resolve) => setTimeout(resolve, 10));
  }

  function candidateFor({ projectRef, fingerprintHash } = {}) {
    const armed = latestProjectEvent(store, projectRef, ARMED_EVENT);
    const disarmed = latestProjectEvent(store, projectRef, DISARMED_EVENT);
    if (!armed?.payload?.threadId || !fingerprintHash) return null;
    if (disarmed && disarmed.eventId > armed.eventId) return null;
    if (armed.payload.fingerprintHash !== fingerprintHash) return null;
    return {
      threadId: armed.payload.threadId,
      match: armed.payload.match ?? null,
      armedAt: armed.createdAt,
      quota: armed.payload.quota ?? null,
      thresholdPercent: armed.payload.thresholdPercent ?? thresholdPercent,
    };
  }

  function status() { return { ...lastState }; }
  function setState(value) { lastState = value; return status(); }

  return { start, close, evaluate, candidateFor, status, thresholdPercent, intervalMs };
}

function projectForCwd(store, cwd) {
  const target = path.resolve(cwd);
  const candidates = store.listProjects().filter((project) => isWithin(project.root, target));
  candidates.sort((a, b) => b.root.length - a.root.length);
  return candidates[0] ?? null;
}

function highestUsedPercent(quota) {
  const windows = (quota?.codex?.limits ?? []).flatMap((limit) => Array.isArray(limit?.windows) ? limit.windows : []);
  const values = windows.map((window) => Number(window?.usedPercent)).filter(Number.isFinite);
  return values.length ? Math.max(...values) : null;
}

function compactQuota(quota, usedPercent) {
  return {
    observedAt: quota?.observedAt ?? null,
    availability: quota?.codex?.availability ?? "unknown",
    exhausted: quota?.codex?.exhausted === true,
    usedPercent,
    resetsAt: quota?.codex?.resetsAt ?? null,
  };
}

function isWithin(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function safeErrorMessage(value) {
  return bounded(value, 2_000)
    .replace(/\bBearer\s+[^\s]+/gi, "Bearer <redacted>")
    .replace(/([?&](?:token|key|api_key|apikey|auth|authorization|secret)=)[^&\s"']+/gi, "$1<redacted>");
}

function bounded(value, max) {
  const text = String(value ?? "");
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}
