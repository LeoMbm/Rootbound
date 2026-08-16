import { createRequire } from "node:module";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);
const z = require("zod/v4");
import { MeteredConsentGate } from "./metered-consent.mjs";
import { AGENT_TASK_CARD_URI, registerAgentTaskCardResource } from "./agent-card-ui.mjs";

const EVENT_KEYS = new Set(["seq", "type", "at", "turnId", "status", "requestId"]);
const PENDING_APPROVAL_KEYS = new Set(["requestId", "method", "itemId", "receivedAt", "reason", "details"]);

function publicEvent(event) {
  if (!event || typeof event !== "object") return null;
  return Object.fromEntries(Object.entries(event).filter(([key]) => EVENT_KEYS.has(key)));
}

function publicPendingApproval(pendingApproval) {
  if (!pendingApproval || typeof pendingApproval !== "object") return null;
  const projected = Object.fromEntries(Object.entries(pendingApproval).filter(([key]) => PENDING_APPROVAL_KEYS.has(key)));
  if (projected.requestId !== undefined && projected.requestId !== null) projected.requestId = String(projected.requestId);
  return projected;
}

function quotaWindows(quota) {
  const limits = quota?.rateLimits?.limits ?? [];
  const windows = [];
  for (const limit of limits) {
    for (const window of Array.isArray(limit?.windows) ? limit.windows : []) {
      windows.push({
        limitKey: typeof limit?.key === "string" ? limit.key : null,
        limitName: typeof limit?.limitName === "string" ? limit.limitName : null,
        kind: typeof window?.kind === "string" ? window.kind : null,
        remainingPercent: Number.isInteger(window?.remainingPercent) ? window.remainingPercent : null,
        resetsAt: Number.isInteger(window?.resetsAt) ? window.resetsAt : null,
        windowDurationMins: Number.isInteger(window?.windowDurationMins) ? window.windowDurationMins : null,
      });
    }
  }
  return windows;
}

function quotaWindowDurationLabel(window) {
  const mins = window?.windowDurationMins;
  if (!Number.isInteger(mins) || mins <= 0) return null;
  if (mins % 10_080 === 0) return `${mins / 10_080}w`;
  if (mins % 1_440 === 0) return `${mins / 1_440}d`;
  if (mins % 60 === 0) return `${mins / 60}h`;
  return `${mins}m`;
}

function quotaWindowLabel(window, index) {
  const duration = quotaWindowDurationLabel(window);
  const rawName = window?.limitName;
  const namedLimit = rawName && rawName.toLowerCase() !== "codex"
    ? rawName
    : (window?.limitKey && window.limitKey !== "codex" ? window.limitKey : null);
  if (namedLimit && duration) return `${namedLimit} · ${duration}`;
  return namedLimit || duration || window?.kind || `window ${index + 1}`;
}

function compactOneLine(value, max = 320) {
  const clean = String(value ?? "").replace(/\s+/g, " ").trim();
  return clean.length > max ? clean.slice(0, Math.max(1, max - 3)) + "..." : clean;
}

function approvalOneLine(pendingApproval) {
  if (!pendingApproval) return "Approval required";
  return compactOneLine(
    pendingApproval.reason
      ?? pendingApproval.details?.reason
      ?? pendingApproval.details?.command
      ?? pendingApproval.details?.path
      ?? pendingApproval.details?.changes?.[0]?.path
      ?? pendingApproval.method
      ?? "Approval required"
  );
}

function quotaFallbackText(window, index) {
  const label = quotaWindowLabel(window, index);
  const remaining = Number.isInteger(window?.remainingPercent) ? `${window.remainingPercent}% left` : "remaining unknown";
  const reset = Number.isInteger(window?.resetsAt) ? ` · reset ${new Date(window.resetsAt * 1000).toISOString()}` : "";
  return `${label}: ${remaining}${reset}`;
}

function manualFallback(payload) {
  const status = payload?.status ?? "unknown";
  const quota = payload?.meteredConsent?.quota ?? payload?.taskCard?.quota ?? payload?.resourceReceipt?.accountQuota ?? null;
  const windows = quotaWindows(quota);
  const quotaLines = windows.length ? windows.map((window, index) => quotaFallbackText(window, index)) : ["Codex quota: unavailable"];

  if (status === "consent_required") {
    const summary = compactOneLine(payload?.taskCard?.summary ?? "Codex task");
    return {
      kind: "task_card_required",
      choices: [],
      summary,
      quota: { windows },
      requiresTaskCard: true,
      nextAction: "codex.agent_card_render",
      lines: [
        "Codex approval required",
        `Task: ${summary}`,
        "Codex quota",
        ...quotaLines,
        "Open or re-render the Codex Task Card to approve or decline.",
        "No Codex turn has started. A chat reply alone cannot authorize this task.",
      ],
    };
  }

  if (status === "awaitingApproval" && payload?.pendingApproval) {
    const summary = approvalOneLine(payload.pendingApproval);
    return {
      kind: "confirm_approval",
      choices: ["Yes", "No"],
      summary,
      quota: { windows },
      lines: ["Codex approval", `Request: ${summary}`, ...quotaLines, "Yes / No"],
    };
  }

  const terminal = isTerminalStatus(status);
  if (terminal) {
    const label = terminalLabel(status);
    const task = compactOneLine(payload?.taskCard?.summary ?? "Codex task");
    const detail = label === "DONE" ? null : compactOneLine(payload?.latestError ?? payload?.finalResult ?? label, 240);
    const turnTokens = payload?.resourceReceipt?.tokenUsage?.turn?.totalTokens ?? null;
    const tokenLine = Number.isInteger(turnTokens) ? `This turn: ${turnTokens.toLocaleString("en-US")} tokens` : "This turn: tokens unavailable";
    const lines = [`Codex · ${label}`, `Task: ${task}`];
    if (detail) lines.push(`Detail: ${detail}`);
    lines.push(tokenLine, "Codex quota", ...quotaLines);
    return {
      kind: "completion",
      status: label.toLowerCase(),
      task,
      result: detail,
      turnTokens: Number.isInteger(turnTokens) ? turnTokens : null,
      quota: { windows },
      lines,
    };
  }

  return null;
}

function publicAgentSnapshot(snapshot, taskCard = null) {
  const payload = {
    agentRef: snapshot?.agentRef ?? null,
    turnId: snapshot?.turnId ?? null,
    status: snapshot?.status ?? "unknown",
    canSend: snapshot?.canSend === true,
    pendingApproval: publicPendingApproval(snapshot?.pendingApproval),
    finalResult: snapshot?.finalResult ?? null,
    resourceReceipt: snapshot?.resourceReceipt ?? null,
    timing: snapshot?.timing ?? { startedAt: null, endedAt: null, durationMs: null },
    execution: snapshot?.execution ?? { requestedModel: null, resolvedModel: null, modelProvider: null, serviceTier: null, reasoningEffort: null },
    latestError: snapshot?.latestError ?? null,
    events: Array.isArray(snapshot?.events) ? snapshot.events.map(publicEvent).filter(Boolean) : [],
    nextSeq: Number.isInteger(snapshot?.nextSeq) ? snapshot.nextSeq : 0,
  };
  if (taskCard) payload.taskCard = taskCard;
  if (typeof snapshot?.duplicate === "boolean") payload.duplicate = snapshot.duplicate;
  if (typeof snapshot?.controlAcceptance === "string") payload.controlAcceptance = snapshot.controlAcceptance;
  const fallback = manualFallback(payload);
  if (fallback) payload.manualFallback = fallback;
  return payload;
}

function consentRequiredSnapshot({ agentRef = null, consent, taskCard = null }) {
  const payload = {
    agentRef,
    status: "consent_required",
    canSend: false,
    pendingApproval: null,
    meteredConsent: consent,
    taskCard,
    finalResult: null,
    resourceReceipt: null,
    latestError: null,
    events: [],
    nextSeq: 0,
  };
  payload.manualFallback = manualFallback(payload);
  return payload;
}

const TASK_STORE_VERSION = 1;
const DEFAULT_TASK_STORE_TTL_MS = 14 * 24 * 60 * 60_000;
const DEFAULT_TASK_STORE_MAX_ENTRIES = 2_000;

function createTaskPersistence({ filePath = null, ttlMs = DEFAULT_TASK_STORE_TTL_MS, maxEntries = DEFAULT_TASK_STORE_MAX_ENTRIES } = {}) {
  if (!filePath) return null;
  if (!Number.isInteger(ttlMs) || ttlMs < 60_000) throw new Error("agent task-state ttlMs must be at least 60000");
  if (!Number.isInteger(maxEntries) || maxEntries < 10 || maxEntries > 100_000) throw new Error("agent task-state maxEntries must be 10..100000");
  const resolvedPath = path.resolve(filePath);
  const records = new Map();
  let blockedError = null;

  if (existsSync(resolvedPath)) {
    try {
      const parsed = JSON.parse(readFileSync(resolvedPath, "utf8"));
      if (parsed?.version !== TASK_STORE_VERSION || !Array.isArray(parsed.records)) {
        throw new Error(`unsupported task-state schema version ${String(parsed?.version ?? "missing")}`);
      }
      for (const entry of parsed.records) {
        if (!entry || typeof entry !== "object" || typeof entry.taskRef !== "string") continue;
        records.set(entry.taskRef, entry);
      }
    } catch (error) {
      blockedError = `agent task-state file is unreadable or corrupt: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  function assertAvailable() {
    if (blockedError) throw new Error(blockedError);
  }

  function trim(now = Date.now()) {
    for (const [key, entry] of records) {
      const updatedAt = Number.isFinite(entry?.updatedAt) ? entry.updatedAt : 0;
      if (!updatedAt || now - updatedAt > ttlMs) records.delete(key);
    }
    if (records.size <= maxEntries) return;
    const oldest = [...records.entries()].sort((a, b) => (a[1]?.updatedAt ?? 0) - (b[1]?.updatedAt ?? 0));
    for (let index = 0; index < oldest.length - maxEntries; index += 1) records.delete(oldest[index][0]);
  }

  function flush() {
    assertAvailable();
    trim();
    mkdirSync(path.dirname(resolvedPath), { recursive: true });
    const tmp = `${resolvedPath}.tmp-${randomUUID()}`;
    writeFileSync(tmp, JSON.stringify({ version: TASK_STORE_VERSION, records: [...records.values()] }), { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, resolvedPath);
  }

  trim();
  return {
    filePath: resolvedPath,
    get(taskRef) {
      assertAvailable();
      trim();
      const entry = records.get(taskRef);
      return entry ? structuredClone(entry) : null;
    },
    findByRequest({ requestId, action, agentRef = null }) {
      assertAvailable();
      trim();
      let found = null;
      for (const entry of records.values()) {
        if (entry?.requestId !== requestId || entry?.action !== action) continue;
        if ((entry?.subjectRef ?? null) !== agentRef) continue;
        if (!found || (entry.updatedAt ?? 0) > (found.updatedAt ?? 0)) found = entry;
      }
      return found ? structuredClone(found) : null;
    },
    put(entry) {
      assertAvailable();
      if (!entry || typeof entry.taskRef !== "string" || !entry.taskRef) throw new Error("persisted agent task entry requires taskRef");
      records.set(entry.taskRef, { ...structuredClone(entry), updatedAt: Date.now() });
      flush();
    },
  };
}

export function createAgentPreviewState({
  meteredConsentMode = "off",
  meteredQuotaProvider = null,
  taskStateFile = null,
  taskStateTtlMs = DEFAULT_TASK_STORE_TTL_MS,
  taskStateMaxEntries = DEFAULT_TASK_STORE_MAX_ENTRIES,
} = {}) {
  return {
    meteredConsent: new MeteredConsentGate({ mode: meteredConsentMode, quotaProvider: meteredQuotaProvider }),
    preparedMetered: new Map(),
    agentCards: new Map(),
    taskRecords: new Map(),
    taskPersistence: createTaskPersistence({ filePath: taskStateFile, ttlMs: taskStateTtlMs, maxEntries: taskStateMaxEntries }),
  };
}

function isTerminalStatus(status) {
  return new Set(["idle", "completed", "failed", "interrupted", "rejected", "lost"]).has(status);
}

function terminalLabel(status) {
  if (status === "failed") return "FAILED";
  if (status === "interrupted") return "STOPPED";
  if (status === "rejected") return "REJECTED";
  if (status === "lost") return "UNCERTAIN";
  return "DONE";
}

export function registerAgentPreviewTools(server, {
  agentExecutor,
  authorityExecutor,
  meteredConsentMode = "off",
  meteredQuotaProvider = null,
  agentPreviewState = null,
}) {
  if (!agentExecutor || !authorityExecutor) {
    throw new Error("Agent preview requires both agentExecutor and authorityExecutor");
  }
  const state = agentPreviewState ?? createAgentPreviewState({ meteredConsentMode, meteredQuotaProvider });
  const { meteredConsent, preparedMetered, agentCards, taskRecords, taskPersistence } = state;
  registerAgentTaskCardResource(server);

  function summaryFor(action, payload) {
    const text = action === "start" ? payload.prompt : payload.message;
    const clean = String(text ?? "").replace(/\s+/g, " ").trim();
    return clean.length > 120 ? clean.slice(0, 117) + "..." : clean;
  }

  function titleFor(action, payload) {
    const text = action === "start" ? payload.prompt : payload.message;
    const firstLine = String(text ?? "").split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "Codex task";
    return firstLine.length > 72 ? firstLine.slice(0, 69) + "..." : firstLine;
  }

  function taskPayloadHash(action, payload, agentRef = null) {
    const stable = JSON.stringify({
      action,
      agentRef,
      prompt: action === "start" ? payload?.prompt ?? null : null,
      message: action === "send" ? payload?.message ?? null : null,
      cwd: action === "start" ? payload?.cwd ?? null : null,
      permissionProfile: action === "start" ? payload?.permissionProfile ?? null : null,
      model: payload?.model ?? null,
    });
    return createHash("sha256").update(stable, "utf8").digest("hex");
  }

  function taskCardFor({ taskRef, requestId, action, payload, cwd = null, permissionProfile = null, quota = null }) {
    return {
      kind: "codex_task",
      taskRef,
      taskId: taskRef,
      requestId,
      action,
      title: titleFor(action, payload),
      summary: summaryFor(action, payload),
      requestedModel: typeof payload?.model === "string" ? payload.model : null,
      cwd,
      permissionProfile,
      quota,
    };
  }

  function persistableSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== "object") return null;
    const resultSummary = compactOneLine(snapshot.resultSummary ?? snapshot.finalResult ?? snapshot.latestError ?? "", 800);
    return {
      taskRef: snapshot.taskRef ?? snapshot.taskId ?? snapshot.taskCard?.taskRef ?? null,
      taskId: snapshot.taskRef ?? snapshot.taskId ?? snapshot.taskCard?.taskRef ?? null,
      agentRef: snapshot.agentRef ?? null,
      turnId: snapshot.turnId ?? null,
      status: snapshot.status ?? "lost",
      canSend: false,
      pendingApproval: null,
      taskCard: snapshot.taskCard ? structuredClone(snapshot.taskCard) : null,
      meteredConsent: snapshot.meteredConsent ? structuredClone(snapshot.meteredConsent) : null,
      finalResult: resultSummary || null,
      resultSummary: resultSummary || null,
      resourceReceipt: snapshot.resourceReceipt ? structuredClone(snapshot.resourceReceipt) : null,
      timing: snapshot.timing ? structuredClone(snapshot.timing) : { startedAt: null, endedAt: null, durationMs: null },
      execution: snapshot.execution ? structuredClone(snapshot.execution) : { requestedModel: null, resolvedModel: null, modelProvider: null, serviceTier: null, reasoningEffort: null },
      latestError: snapshot.latestError ? compactOneLine(snapshot.latestError, 800) : null,
      terminal: snapshot.terminal === true,
      terminalAt: Number.isFinite(snapshot.terminalAt) ? snapshot.terminalAt : null,
      events: [],
      nextSeq: 0,
    };
  }

  function persistRecord(record, snapshot = null, phase = null) {
    if (!taskPersistence || !record?.taskRef) return true;
    try {
      taskPersistence.put({
        taskRef: record.taskRef,
        consentRef: record.consent?.consentRef ?? null,
        requestId: record.consent?.requestId ?? record.taskCard?.requestId ?? null,
        action: record.action,
        payloadHash: record.payloadHash ?? null,
        taskCard: structuredClone(record.taskCard),
        subjectRef: record.subjectRef ?? null,
        agentRef: record.agentRef ?? null,
        turnId: record.turnId ?? null,
        phase: phase ?? (record.terminalSnapshot ? "terminal" : record.authorized ? "active" : "pending"),
        terminalSnapshot: snapshot ? persistableSnapshot(snapshot) : record.terminalSnapshot ? persistableSnapshot(record.terminalSnapshot) : null,
      });
      record.persistenceWarning = null;
      return true;
    } catch (error) {
      record.persistenceWarning = `Task-card persistence unavailable: ${error instanceof Error ? error.message : String(error)}`;
      return false;
    }
  }

  function recoveredTaskState(taskRef) {
    if (!taskPersistence || typeof taskRef !== "string" || !taskRef) return null;
    const persisted = taskPersistence.get(taskRef);
    if (!persisted) return null;
    if (persisted.terminalSnapshot) return structuredClone(persisted.terminalSnapshot);
    const now = Date.now();
    const lost = {
      taskRef,
      taskId: taskRef,
      agentRef: persisted.agentRef ?? null,
      turnId: persisted.turnId ?? null,
      status: "lost",
      canSend: false,
      pendingApproval: null,
      taskCard: persisted.taskCard ? structuredClone(persisted.taskCard) : null,
      meteredConsent: { status: "unavailable", quota: persisted.taskCard?.quota ?? null },
      finalResult: null,
      resourceReceipt: null,
      timing: { startedAt: null, endedAt: now, durationMs: null },
      execution: { requestedModel: persisted.taskCard?.requestedModel ?? null, resolvedModel: null, modelProvider: null, serviceTier: null, reasoningEffort: null },
      latestError: "Task control state was lost across Codexless restart. The original task will not be replayed.",
      terminal: true,
      terminalAt: now,
      resultSummary: "Task control state was lost across Codexless restart. The original task will not be replayed.",
      events: [],
      nextSeq: 0,
    };
    try {
      taskPersistence.put({ ...persisted, phase: "terminal", terminalSnapshot: persistableSnapshot(lost) });
    } catch {}
    return lost;
  }

  async function existingRequestState({ requestId, action, payload, agentRef = null }) {
    if (!taskPersistence) return null;
    const persisted = taskPersistence.findByRequest({ requestId, action, agentRef });
    if (!persisted) return null;
    const payloadHash = taskPayloadHash(action, payload, agentRef);
    if (persisted.payloadHash && persisted.payloadHash !== payloadHash) {
      throw new Error(`requestId ${requestId} was already used for a different Codex task payload`);
    }
    const live = taskRecords.get(persisted.taskRef);
    if (live) return preparedCardState(live);
    return recoveredTaskState(persisted.taskRef);
  }

  function rememberPrepared({ consent, action, payload, cwd = null, permissionProfile = null, agentRef = null }) {
    const existing = preparedMetered.get(consent.consentRef);
    if (existing) return existing;
    const taskRef = `task_${randomUUID()}`;
    const record = {
      taskRef,
      taskId: taskRef,
      consent,
      action,
      payload,
      payloadHash: taskPayloadHash(action, payload, agentRef),
      cwd,
      permissionProfile,
      subjectRef: agentRef,
      agentRef,
      authorized: false,
      commitToken: `commit_${randomUUID()}`,
      turnId: null,
      terminalSnapshot: null,
      declinedAt: null,
      taskCard: taskCardFor({ taskRef, requestId: consent.requestId, action, payload, cwd, permissionProfile, quota: consent.quota }),
    };
    preparedMetered.set(consent.consentRef, record);
    taskRecords.set(taskRef, record);
    persistRecord(record, null, "pending");
    return record;
  }

  function directRecord({ action, payload, cwd = null, permissionProfile = null, agentRef = null, requestId }) {
    const taskRef = `task_${randomUUID()}`;
    const consent = { consentRef: null, requestId, quota: null };
    const record = {
      taskRef,
      taskId: taskRef,
      consent,
      action,
      payload,
      payloadHash: taskPayloadHash(action, payload, agentRef),
      cwd,
      permissionProfile,
      subjectRef: agentRef,
      agentRef,
      authorized: true,
      commitToken: null,
      turnId: null,
      terminalSnapshot: null,
      declinedAt: null,
      taskCard: taskCardFor({ taskRef, requestId, action, payload, cwd, permissionProfile, quota: null }),
    };
    taskRecords.set(taskRef, record);
    persistRecord(record, null, "pending");
    return record;
  }

  function cardForAgent(agentRef) {
    return agentRef ? agentCards.get(agentRef) ?? null : null;
  }

  function freezeRecord(record, payload) {
    if (record.terminalSnapshot) return structuredClone(record.terminalSnapshot);
    const frozen = {
      ...structuredClone(payload),
      taskRef: record.taskRef,
      taskId: record.taskRef,
      taskCard: structuredClone(record.taskCard),
      canSend: false,
      terminal: true,
      terminalAt: Date.now(),
    };
    frozen.resultSummary = compactOneLine(frozen.finalResult ?? frozen.latestError ?? terminalLabel(frozen.status), 600);
    record.terminalSnapshot = frozen;
    persistRecord(record, frozen, "terminal");
    return structuredClone(frozen);
  }

  function lostRecord(record) {
    return freezeRecord(record, {
      agentRef: record.agentRef,
      turnId: record.turnId,
      status: "lost",
      pendingApproval: null,
      finalResult: null,
      resourceReceipt: null,
      timing: { startedAt: null, endedAt: Date.now(), durationMs: null },
      execution: {
        requestedModel: typeof record.payload?.model === "string" ? record.payload.model : null,
        resolvedModel: null,
        modelProvider: null,
        serviceTier: null,
        reasoningEffort: null,
      },
      latestError: "Task-specific terminal state was not observed before this agent advanced. The original task will not be replayed.",
      events: [],
      nextSeq: 0,
      meteredConsent: { status: "approved", quota: record.consent.quota },
    });
  }

  async function freezeCurrentTaskForAgent(agentRef) {
    if (!agentRef) return;
    const snapshot = await agentExecutor.show({ agentRef, afterSeq: 0 });
    if (!isTerminalStatus(snapshot?.status)) return;
    for (const record of taskRecords.values()) {
      if (record.agentRef !== agentRef || record.terminalSnapshot) continue;
      if (!record.turnId && cardForAgent(agentRef)?.taskRef === record.taskRef) record.turnId = snapshot.turnId ?? null;
      if (!record.turnId || snapshot.turnId !== record.turnId) continue;
      freezeRecord(record, {
        ...publicAgentSnapshot(snapshot, record.taskCard),
        taskRef: record.taskRef,
        taskId: record.taskRef,
        meteredConsent: { status: "approved", quota: record.consent.quota },
      });
    }
  }

  async function preparedCardState(record) {
    if (record.terminalSnapshot) return structuredClone(record.terminalSnapshot);
    if (!record.authorized) {
      const pending = consentRequiredSnapshot({ agentRef: record.agentRef, consent: record.consent, taskCard: record.taskCard });
      pending.taskRef = record.taskRef;
      pending.taskId = record.taskRef;
      pending.turnId = null;
      pending.timing = { startedAt: null, endedAt: null, durationMs: null };
      pending.execution = {
        requestedModel: typeof record.payload?.model === "string" ? record.payload.model : null,
        resolvedModel: null,
        modelProvider: null,
        serviceTier: null,
        reasoningEffort: null,
      };
      return pending;
    }
    if (!record.agentRef) throw new Error("prepared Codex task is authorized but its agentRef is not available yet");
    const snapshot = await agentExecutor.show({ agentRef: record.agentRef, afterSeq: 0 });
    if (!record.turnId && snapshot.turnId) record.turnId = snapshot.turnId;
    if (record.turnId && snapshot.turnId !== record.turnId) return lostRecord(record);
    const payload = {
      ...publicAgentSnapshot(snapshot, record.taskCard),
      taskRef: record.taskRef,
      taskId: record.taskRef,
      meteredConsent: { status: "approved", quota: record.consent.quota },
    };
    if (isTerminalStatus(payload.status)) return freezeRecord(record, payload);
    return payload;
  }

  async function dispatchPrepared(record) {
    if (record.terminalSnapshot) return { ...structuredClone(record.terminalSnapshot), duplicate: true };
    if (record.declinedAt) return structuredClone(record.terminalSnapshot ?? lostRecord(record));
    if (taskPersistence && !persistRecord(record, null, record.authorized ? "active" : "pending")) {
      throw new Error("Codex task was not started because durable Task Card state could not be recorded safely");
    }
    if (record.action === "start") {
      const currentAuthority = await authorityExecutor.resolveAuthority({ cwd: record.cwd, access: "inherit" });
      if (currentAuthority.effectiveCwd !== record.cwd || currentAuthority.permissionProfile !== record.permissionProfile) {
        throw new Error("prepared Codex task authority changed; prepare and approve a new task card");
      }
    } else if (record.payload?.parentTurnId) {
      const current = await agentExecutor.show({ agentRef: record.agentRef, afterSeq: 0 });
      if (current.turnId !== record.payload.parentTurnId || current.status !== "idle" || current.canSend !== true) {
        throw new Error("prepared Codex follow-up is stale because the agent advanced; prepare a new task card for the current turn");
      }
    }
    if (!record.authorized) {
      throw new Error("Codex task is still pending user approval; dispatch is blocked until the prepared task is explicitly committed");
    }

    if (record.action === "start") {
      const snapshot = await agentExecutor.start({
        cwd: record.cwd,
        task: record.payload.prompt,
        clientRequestId: record.consent.requestId,
        permissionProfile: record.permissionProfile,
        model: record.payload.model ?? null,
      });
      if (snapshot?.agentRef) {
        record.agentRef = snapshot.agentRef;
        record.turnId = snapshot.turnId ?? null;
        agentCards.set(snapshot.agentRef, record.taskCard);
      }
      const payload = {
        ...publicAgentSnapshot(snapshot, record.taskCard),
        taskRef: record.taskRef,
        taskId: record.taskRef,
        meteredConsent: { status: "approved", quota: record.consent.quota },
      };
      if (isTerminalStatus(payload.status)) return freezeRecord(record, payload);
      persistRecord(record, payload, "active");
      return payload;
    }

    await freezeCurrentTaskForAgent(record.agentRef);
    const snapshot = await agentExecutor.send({
      agentRef: record.agentRef,
      message: record.payload.message,
      clientRequestId: record.consent.requestId,
      model: record.payload.model ?? null,
    });
    record.turnId = snapshot.turnId ?? null;
    if (record.agentRef) agentCards.set(record.agentRef, record.taskCard);
    const payload = {
      ...publicAgentSnapshot(snapshot, record.taskCard),
      taskRef: record.taskRef,
      taskId: record.taskRef,
      meteredConsent: { status: "approved", quota: record.consent.quota },
    };
    if (isTerminalStatus(payload.status)) return freezeRecord(record, payload);
    persistRecord(record, payload, "active");
    return payload;
  }

  server.registerTool(
    "codex.model_list",
    {
      title: "List Codex Models",
      description:
        "Model-free read of the current Codex App Server model catalog. Use it when a user explicitly cares which model to run. The catalog reports current model ids/capabilities/defaults but does not provide price data, so Codexless must not infer cheapest from names alone.",
      inputSchema: z.object({
        cursor: z.string().min(1).max(2048).optional(),
        limit: z.number().int().min(1).max(200).optional(),
        includeHidden: z.boolean().optional(),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ cursor, limit, includeHidden }) => structured(async () => agentExecutor.listModels({
      cursor: cursor ?? null,
      limit: limit ?? null,
      includeHidden: includeHidden === true,
    }))
  );

  server.registerTool(
    "codex.agent_start",
    {
      title: "Start Codex Agent",
      description:
        `Experimental Preview. Prepare one formal Codex agent thread/turn under Codexless's locally resolved Codex authority. Local metered consent mode is ${meteredConsent.mode}; when set to always, every unapproved logical start returns consent_required and quota context without starting a turn. requestId is a caller-stable idempotency key and MUST be reused if the same start is retried after an uncertain response. A returned consentRef identifies the prepared task but is never proof of approval: replaying it through this public tool cannot start Codex work. Only the server-side Task Card commit path may approve and dispatch the prepared task. model is optional; omit it to preserve Codex's current default routing. The caller cannot choose permission profile, sandbox, approval policy, roots, or network authority.`,
      inputSchema: z.object({
        prompt: z.string().min(1).max(200_000),
        requestId: z.string().min(1).max(512)
          .describe("Stable caller-generated idempotency key. Reuse this exact value for retries of the same logical start."),
        cwd: z.string().min(1).max(32_768).optional()
          .describe("Optional execution-directory context. Codexless resolves authority locally for this cwd; cwd is not a permission selector."),
        model: z.string().min(1).max(512).optional()
          .describe("Optional exact model id from codex.model_list. Omit to use Codex's current default model routing."),
        consentRef: z.string().min(1).max(512).optional()
          .describe("Legacy compatibility field. It identifies an already prepared task only; supplying or replaying it never authorizes metered Codex work. Approval must occur through the server-side Task Card commit path."),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
      _meta: {
        "openai/toolInvocation/invoking": "Preparing Codex task…",
        "openai/toolInvocation/invoked": "Codex task ready.",
      },
    },
    async ({ prompt, requestId, cwd, model, consentRef }) => structuredCard(async () => {
      const authority = await authorityExecutor.resolveAuthority({ cwd: cwd ?? null, access: "inherit" });
      const payload = {
        prompt,
        cwd: authority.effectiveCwd,
        model: model ?? null,
        permissionProfile: authority.permissionProfile,
      };
      const prior = await existingRequestState({ requestId, action: "start", payload, agentRef: null });
      if (prior) return { ...prior, duplicate: true };
      if (consentRef) throw new Error("consentRef cannot authorize a Codex start through the public agent_start tool; render/approve the prepared Task Card instead");
      const consent = await meteredConsent.authorize({ action: "start", requestId, payload });
      if (!consent.authorized) {
        const record = rememberPrepared({
          consent: consent.consent,
          action: "start",
          payload,
          cwd: authority.effectiveCwd,
          permissionProfile: authority.permissionProfile,
        });
        if (record.terminalSnapshot) return structuredClone(record.terminalSnapshot);
        const pending = consentRequiredSnapshot({ consent: consent.consent, taskCard: record.taskCard });
        pending.taskRef = record.taskRef;
        pending.taskId = record.taskRef;
        pending.turnId = null;
        pending.timing = { startedAt: null, endedAt: null, durationMs: null };
        pending.execution = { requestedModel: model ?? null, resolvedModel: null, modelProvider: null, serviceTier: null, reasoningEffort: null };
        return pending;
      }
      const record = directRecord({
        action: "start",
        payload,
        cwd: authority.effectiveCwd,
        permissionProfile: authority.permissionProfile,
        requestId,
      });
      return dispatchPrepared(record);
    })
  );

  server.registerTool(
    "codex.agent_card_render",
    {
      title: "Render Prepared Codex Task Card",
      description:
        "Read-only render step for a prepared metered Codex start/send. Call this only after codex.agent_start or codex.agent_send returns consent_required. It does not start or continue Codex work; it re-reads the server-bound prepared record and renders the confirmation card. The card itself calls app-only commit/show/approve/reject/cancel tools so later state updates do not remount the template.",
      inputSchema: z.object({ consentRef: z.string().min(1).max(512) }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      _meta: {
        ui: { resourceUri: AGENT_TASK_CARD_URI },
        "openai/outputTemplate": AGENT_TASK_CARD_URI,
        "openai/toolInvocation/invoking": "Opening Codex confirmation…",
        "openai/toolInvocation/invoked": "Codex confirmation ready.",
      },
    },
    async ({ consentRef }) => structuredCard(
      async () => {
        const record = preparedMetered.get(consentRef);
        if (!record) throw new Error("unknown or stale prepared metered consentRef");
        return preparedCardState(record);
      },
      () => {
        const record = preparedMetered.get(consentRef);
        return record?.commitToken ? { codexlessCommitToken: record.commitToken } : {};
      }
    )
  );

  server.registerTool(
    "codex.agent_card_state",
    {
      title: "Read Codex Task Card State",
      description:
        "App-only read-only state endpoint for one already mounted Codex Task Card. New cards use opaque taskRef so state remains task-specific even without a metered consentRef; consentRef remains a legacy in-runtime fallback. Persisted terminal snapshots survive Codexless restarts. Persisted non-terminal tasks recover as LOST/uncertain and are never replayed.",
      inputSchema: z.object({
        taskRef: z.string().min(1).max(512).optional(),
        consentRef: z.string().min(1).max(512).optional(),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({ taskRef, consentRef }) => structuredCard(
      async () => {
        if (!taskRef && !consentRef) throw new Error("taskRef or consentRef is required");
        if (taskRef) {
          const live = taskRecords.get(taskRef);
          if (live) return preparedCardState(live);
          const recovered = recoveredTaskState(taskRef);
          if (recovered) return recovered;
        }
        if (consentRef) {
          const legacy = preparedMetered.get(consentRef);
          if (legacy) return preparedCardState(legacy);
        }
        throw new Error("unknown or stale Codex task card reference");
      },
      () => {
        const live = taskRef ? taskRecords.get(taskRef) : consentRef ? preparedMetered.get(consentRef) : null;
        return live?.commitToken ? { codexlessCommitToken: live.commitToken } : {};
      }
    )
  );

  server.registerTool(
    "codex.agent_show",
    {
      title: "Show Codex Agent",
      description:
        "Experimental Preview. Read the bounded operational state of one Codexless-owned Codex agent by opaque agentRef. Returns status, sendability, minimal pending-approval summary, final result, and a bounded event tail; it does not duplicate the Codex transcript.",
      inputSchema: z.object({
        agentRef: z.string().min(1).max(512),
        afterSeq: z.number().int().min(0).optional(),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ agentRef, afterSeq }) => structured(async () => {
      const snapshot = await agentExecutor.show({ agentRef, afterSeq: afterSeq ?? 0 });
      return publicAgentSnapshot(snapshot, cardForAgent(agentRef));
    })
  );

  server.registerTool(
    "codex.agent_send",
    {
      title: "Continue Codex Agent",
      description:
        `Experimental Preview. Prepare one exact Codexless-owned Codex agent follow-up by opaque agentRef. The caller must deliberately choose the target agentRef; Codexless has no implicit "most recent agent" routing. Local metered consent mode is ${meteredConsent.mode}; when set to always, every unapproved logical send returns consent_required and quota context without starting a turn. requestId is a caller-stable idempotency key and MUST be reused if the same send is retried after an uncertain response. A returned consentRef identifies the prepared follow-up but is never proof of approval: replaying it through this public tool cannot start Codex work. Only the server-side Task Card commit path may approve and dispatch the prepared follow-up. model is optional and may override the model for this turn and subsequent turns. Active turns, stale parent turns, and pending approvals fail visibly; Codexless never auto-replays an accepted or uncertain send.`,
      inputSchema: z.object({
        agentRef: z.string().min(1).max(512),
        message: z.string().min(1).max(200_000),
        requestId: z.string().min(1).max(512)
          .describe("Stable caller-generated idempotency key. Reuse this exact value for retries of the same logical send."),
        model: z.string().min(1).max(512).optional()
          .describe("Optional exact model id from codex.model_list. Omit to keep the current Codex thread model."),
        consentRef: z.string().min(1).max(512).optional()
          .describe("Legacy compatibility field. It identifies an already prepared follow-up only; supplying or replaying it never authorizes metered Codex work. Approval must occur through the server-side Task Card commit path."),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
      _meta: {
        "openai/toolInvocation/invoking": "Preparing Codex follow-up…",
        "openai/toolInvocation/invoked": "Codex follow-up ready.",
      },
    },
    async ({ agentRef, message, requestId, model, consentRef }) => structuredCard(async () => {
      const prior = await existingRequestState({
        requestId,
        action: "send",
        payload: { message, model: model ?? null },
        agentRef,
      });
      if (prior) return { ...prior, duplicate: true };
      if (consentRef) throw new Error("consentRef cannot authorize a Codex follow-up through the public agent_send tool; render/approve the prepared Task Card instead");
      if (meteredConsent.mode === "off") {
        const parentCard = cardForAgent(agentRef);
        return dispatchPrepared(directRecord({
          action: "send",
          payload: { message, model: model ?? null, parentTurnId: null, permissionProfile: parentCard?.permissionProfile ?? null },
          cwd: parentCard?.cwd ?? null,
          permissionProfile: parentCard?.permissionProfile ?? null,
          agentRef,
          requestId,
        }));
      }
      const current = await agentExecutor.show({ agentRef, afterSeq: 0 });
      if (current.status !== "idle" || current.canSend !== true || !current.turnId) {
        throw new Error(`agent ${agentRef} is not ready for a follow-up: ${current.status}`);
      }
      const parentCard = cardForAgent(agentRef);
      const payload = {
        message,
        model: model ?? null,
        parentTurnId: current.turnId,
        permissionProfile: parentCard?.permissionProfile ?? null,
      };
      const consent = await meteredConsent.authorize({ action: "send", requestId, subjectRef: agentRef, payload });
      if (!consent.authorized) {
        const record = rememberPrepared({
          consent: consent.consent,
          action: "send",
          payload,
          cwd: parentCard?.cwd ?? null,
          permissionProfile: parentCard?.permissionProfile ?? null,
          agentRef,
        });
        if (record.terminalSnapshot) return structuredClone(record.terminalSnapshot);
        const pending = consentRequiredSnapshot({ agentRef, consent: consent.consent, taskCard: record.taskCard });
        pending.taskRef = record.taskRef;
        pending.taskId = record.taskRef;
        pending.turnId = null;
        pending.timing = { startedAt: null, endedAt: null, durationMs: null };
        pending.execution = { requestedModel: model ?? null, resolvedModel: current.execution?.resolvedModel ?? null, modelProvider: current.execution?.modelProvider ?? null, serviceTier: current.execution?.serviceTier ?? null, reasoningEffort: current.execution?.reasoningEffort ?? null };
        return pending;
      }
      const record = directRecord({
        action: "send",
        payload,
        cwd: parentCard?.cwd ?? null,
        permissionProfile: parentCard?.permissionProfile ?? null,
        agentRef,
        requestId,
      });
      return dispatchPrepared(record);
    })
  );

  server.registerTool(
    "codex.agent_decline",
    {
      title: "Decline Prepared Metered Codex Task",
      description:
        "App-only terminal decline for one prepared Codex task card. It never starts Codex work. After decline the same consentRef is sealed; a cached Yes/commit cannot revive this task. A rerun requires a new requestId and a new task card.",
      inputSchema: z.object({ consentRef: z.string().min(1).max(512) }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({ consentRef }) => structured(async () => {
      const record = preparedMetered.get(consentRef);
      if (!record) throw new Error("unknown or stale prepared metered consentRef");
      if (record.terminalSnapshot) return structuredClone(record.terminalSnapshot);
      if (record.authorized) throw new Error("prepared Codex task already started and cannot be declined as a pre-call task");
      record.declinedAt = Date.now();
      return freezeRecord(record, {
        agentRef: record.agentRef,
        turnId: null,
        status: "rejected",
        pendingApproval: null,
        finalResult: null,
        resourceReceipt: null,
        timing: { startedAt: null, endedAt: record.declinedAt, durationMs: 0 },
        execution: { requestedModel: record.payload?.model ?? null, resolvedModel: null, modelProvider: null, serviceTier: null, reasoningEffort: null },
        latestError: null,
        events: [],
        nextSeq: 0,
        meteredConsent: { status: "rejected", quota: record.consent.quota },
      });
    })
  );

  server.registerTool(
    "codex.agent_commit",
    {
      title: "Commit Prepared Metered Codex Task",
      description:
        "App-only exact commit for a previously prepared metered Codex start/send. The Task Card must supply both the opaque consentRef and its separate card-only commit capability; Codexless retrieves the bound action, requestId, prompt/message, cwd and subject from server memory and cannot accept replacements at commit time. Repeated exact commits reuse the same idempotency key and never create a second logical turn.",
      inputSchema: z.object({
        consentRef: z.string().min(1).max(512),
        commitToken: z.string().min(1).max(512)
          .describe("Task-Card-only capability token delivered outside model-visible structured content. It must match the exact prepared task."),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({ consentRef, commitToken }) => structured(async () => {
      const record = preparedMetered.get(consentRef);
      if (!record) throw new Error("unknown or stale prepared metered consentRef");
      if (record.terminalSnapshot) return { ...structuredClone(record.terminalSnapshot), duplicate: true };
      if (record.declinedAt) return { ...structuredClone(record.terminalSnapshot ?? lostRecord(record)), duplicate: true };
      if (!record.commitToken || commitToken !== record.commitToken) {
        throw new Error("Codex Task Card commit capability is missing or does not match this prepared task");
      }
      const approval = meteredConsent.approve({
        action: record.action,
        requestId: record.consent.requestId,
        subjectRef: record.action === "send" ? record.agentRef : null,
        payload: record.payload,
        consentRef,
      });
      if (!approval.authorized) throw new Error("prepared Codex task approval did not authorize dispatch");
      record.authorized = true;
      return dispatchPrepared(record);
    })
  );

  server.registerTool(
    "codex.agent_approve",
    {
      title: "Approve Pending Codex Agent Action",
      description:
        "Experimental Preview. Resolve exactly the currently pending Codex approval identified by approvalRequestId using the narrow one-turn approval response defined by Codex. Call only after the user explicitly approves that exact pending request. requestId is a caller-stable idempotency key and must be reused for retries of the same logical approval. Codexless never grants permissions beyond the permission subset requested by Codex.",
      inputSchema: z.object({
        agentRef: z.string().min(1).max(512),
        approvalRequestId: z.string().min(1).max(512)
          .describe("Exact pendingApproval.requestId from codex.agent_show/start/send."),
        requestId: z.string().min(1).max(512)
          .describe("Stable caller-generated idempotency key for this logical approval."),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ agentRef, approvalRequestId, requestId }) => structured(async () => {
      const snapshot = await agentExecutor.resolveApproval({
        agentRef,
        approvalRequestId,
        clientRequestId: requestId,
        decision: "approve",
      });
      return publicAgentSnapshot(snapshot, cardForAgent(snapshot?.agentRef));
    })
  );

  server.registerTool(
    "codex.agent_reject",
    {
      title: "Reject Pending Codex Agent Action",
      description:
        "Experimental Preview. Reject exactly the currently pending Codex approval identified by approvalRequestId without widening permissions. Command/file approvals use Codex's decline response; permission requests grant an empty permission subset for the current turn. requestId is a caller-stable idempotency key and must be reused for retries of the same logical rejection.",
      inputSchema: z.object({
        agentRef: z.string().min(1).max(512),
        approvalRequestId: z.string().min(1).max(512)
          .describe("Exact pendingApproval.requestId from codex.agent_show/start/send."),
        requestId: z.string().min(1).max(512)
          .describe("Stable caller-generated idempotency key for this logical rejection."),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ agentRef, approvalRequestId, requestId }) => structured(async () => {
      const snapshot = await agentExecutor.resolveApproval({
        agentRef,
        approvalRequestId,
        clientRequestId: requestId,
        decision: "reject",
      });
      return publicAgentSnapshot(snapshot, cardForAgent(snapshot?.agentRef));
    })
  );

  server.registerTool(
    "codex.agent_cancel",
    {
      title: "Cancel Active Codex Agent Turn",
      description:
        "Experimental Preview. Interrupt the currently active formal Codex turn through official turn/interrupt. This does not delete the thread or replay work. requestId is a caller-stable idempotency key and must be reused for retries of the same logical cancel.",
      inputSchema: z.object({
        agentRef: z.string().min(1).max(512),
        expectedTurnId: z.string().min(1).max(512).optional()
          .describe("Optional task-bound turn id. When supplied, cancel fails closed if the agent has advanced to another turn."),
        requestId: z.string().min(1).max(512)
          .describe("Stable caller-generated idempotency key for this logical cancel."),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ agentRef, expectedTurnId, requestId }) => structured(async () => {
      const snapshot = await agentExecutor.cancel({ agentRef, expectedTurnId: expectedTurnId ?? null, clientRequestId: requestId });
      return publicAgentSnapshot(snapshot, cardForAgent(snapshot?.agentRef));
    })
  );
}

async function structuredCard(task, extraMeta = null) {
  try {
    const payload = await task();
    const projectedMeta = typeof extraMeta === "function" ? await extraMeta(payload) : extraMeta;
    return {
      content: [{ type: "text", text: JSON.stringify(payload) }],
      structuredContent: payload,
      _meta: { toolwireAgentState: payload, ...(projectedMeta && typeof projectedMeta === "object" ? projectedMeta : {}) },
      isError: false,
    };
  } catch (error) {
    const payload = { error: error instanceof Error ? error.message : String(error) };
    return {
      content: [{ type: "text", text: JSON.stringify(payload) }],
      structuredContent: payload,
      _meta: { toolwireAgentState: payload },
      isError: true,
    };
  }
}

async function structured(task) {
  try {
    const payload = await task();
    return {
      content: [{ type: "text", text: JSON.stringify(payload) }],
      structuredContent: payload,
      isError: false,
    };
  } catch (error) {
    const payload = { error: error instanceof Error ? error.message : String(error) };
    return {
      content: [{ type: "text", text: JSON.stringify(payload) }],
      structuredContent: payload,
      isError: true,
    };
  }
}
