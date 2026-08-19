import path from "node:path";
import { CodexAppServerClient } from "./codex-app-server-client.mjs";
import { readCodexQuotaSnapshot } from "./codex-quota-snapshot.mjs";

const CHROME_SKILL_NAME = "chrome:control-chrome";
const NODE_REPL_SERVER = "node_repl";
const NODE_REPL_TOOL = "js";

function decodeBase64(value) {
  return Buffer.from(value ?? "", "base64").toString("utf8");
}

export class CodexPublicContextExecutor {
  #client;
  #codexBin;
  #defaultCwd;
  #configOverrides;
  #generation = 0;
  #startPromise = null;
  #threadsByCwd = new Map();
  #lastRateLimitUpdateAt = null;

  constructor({ codexBin, defaultCwd, configOverrides = [], clientFactory = null }) {
    if (!codexBin) throw new Error("CodexPublicContextExecutor requires codexBin");
    if (!defaultCwd) throw new Error("CodexPublicContextExecutor requires defaultCwd");
    if (!Array.isArray(configOverrides) || !configOverrides.every((value) => typeof value === "string" && value.trim())) {
      throw new Error("configOverrides must be an array of non-empty strings");
    }

    this.#codexBin = codexBin;
    this.#defaultCwd = path.resolve(defaultCwd);
    this.#configOverrides = [...configOverrides];
    const options = {
      cwd: this.#defaultCwd,
      launch: () => ({
        command: this.#codexBin,
        args: [
          ...this.#configOverrides.flatMap((value) => ["-c", value]),
          "app-server",
          "--stdio",
        ],
        options: { cwd: this.#defaultCwd },
      }),
      requestTimeoutMs: 30_000,
      initializeCapabilities: { experimentalApi: true },
      clientInfo: {
        name: "rootbound_public_preview",
        title: "Rootbound Public Preview",
        version: "0.1.0",
      },
    };
    this.#client = clientFactory ? clientFactory(options) : new CodexAppServerClient(options);
    this.#client.onNotification?.((message) => {
      if (message?.method === "account/rateLimits/updated" && message.params && typeof message.params === "object") {
        this.#lastRateLimitUpdateAt = new Date().toISOString();
      }
    });
  }

  get generation() { return this.#generation; }
  get running() { return this.#client.running; }
  async start() { return this.#ensureStarted(); }

  async close() {
    this.#threadsByCwd.clear();
    await this.#client.close();
  }

  async projectContext({ cwd = this.#defaultCwd } = {}) {
    const effectiveCwd = path.resolve(cwd);
    const started = await this.#request("thread/start", { cwd: effectiveCwd, ephemeral: true, permissions: ":read-only" });
    return {
      threadId: started?.thread?.id ?? null,
      cwd: started?.cwd ?? started?.thread?.cwd ?? effectiveCwd,
      activePermissionProfile: started?.activePermissionProfile ?? null,
      runtimeWorkspaceRoots: started?.runtimeWorkspaceRoots ?? [],
      instructionSources: started?.instructionSources ?? [],
      approvalPolicy: started?.approvalPolicy ?? null,
      approvalsReviewer: started?.approvalsReviewer ?? null,
      sandbox: started?.sandbox ?? null,
      cliVersion: started?.thread?.cliVersion ?? null,
      modelTurnStarted: false,
      requestedPermissionProfile: ":read-only",
    };
  }

  async skillList({ cwd = this.#defaultCwd, query = "" } = {}) {
    const effectiveCwd = path.resolve(cwd);
    const result = await this.#request("skills/list", { cwds: [effectiveCwd], forceReload: false });
    const skills = (result?.data ?? []).flatMap((row) => row?.skills ?? []);
    const needle = query.trim().toLowerCase();
    return {
      cwd: effectiveCwd,
      count: skills.length,
      skills: needle
        ? skills.filter((skill) => `${skill.name} ${skill.description ?? ""}`.toLowerCase().includes(needle))
        : skills,
    };
  }

  async skillRead({ name, cwd = this.#defaultCwd }) {
    const effectiveCwd = path.resolve(cwd);
    const result = await this.#request("skills/list", { cwds: [effectiveCwd], forceReload: false });
    const skills = (result?.data ?? []).flatMap((row) => row?.skills ?? []);
    const exact = skills.find((skill) => skill.name === name);
    const matches = exact ? [exact] : skills.filter((skill) => skill.name.toLowerCase().includes(name.toLowerCase()));
    if (matches.length !== 1) {
      return { status: matches.length ? "ambiguous" : "not_found", matches: matches.map((skill) => ({ name: skill.name, path: skill.path })) };
    }
    const skill = matches[0];
    const read = await this.#request("fs/readFile", { path: skill.path });
    return {
      status: "ok",
      name: skill.name,
      description: skill.description ?? null,
      path: skill.path,
      text: decodeBase64(read?.dataBase64),
    };
  }

  async threadList({ cwd = this.#defaultCwd, omitCwd = false, cursor, limit = 20, sortKey = "updated_at", sortDirection = "desc", archived = false, searchTerm } = {}) {
    const params = { limit, sortKey, sortDirection, archived };
    if (!omitCwd) params.cwd = path.resolve(cwd);
    if (cursor) params.cursor = cursor;
    if (searchTerm) params.searchTerm = searchTerm;
    return sanitizeHistoryPayload(await this.#request("thread/list", params));
  }

  async threadMetadata({ threadId }) {
    const result = await this.#request("thread/read", { threadId, includeTurns: false });
    const sanitized = sanitizeHistoryPayload(result);
    const thread = sanitized?.thread ?? null;
    if (!thread?.id) throw new Error(`Codex thread not found or unreadable: ${threadId}`);
    return { thread };
  }

  async threadRead({ threadId, cursor, limit = 12, sortDirection = "desc", metadata = null }) {
    const threadMetadata = metadata ?? await this.threadMetadata({ threadId });
    const params = { threadId, limit, sortDirection };
    if (cursor) params.cursor = cursor;
    return { thread: threadMetadata.thread, turns: sanitizeHistoryPayload(await this.#request("thread/turns/list", params)) };
  }

  async threadItems({ threadId, turnId, cursor, limit = 50, sortDirection = "asc", metadata = null }) {
    const threadMetadata = metadata ?? await this.threadMetadata({ threadId });
    const params = { threadId, limit, sortDirection };
    if (turnId) params.turnId = turnId;
    if (cursor) params.cursor = cursor;
    return { thread: threadMetadata.thread, items: sanitizeHistoryPayload(await this.#request("thread/items/list", params)) };
  }

  async threadSearchOccurrences({ threadId, query, cursor, limit = 20 }) {
    const params = { threadId, searchTerm: query, pageSize: limit };
    if (cursor) params.cursor = cursor;
    return sanitizeHistoryPayload(await this.#request("thread/searchOccurrences", params));
  }

  async quotaSnapshot() {
    await this.#ensureStarted();
    const snapshot = await readCodexQuotaSnapshot({ client: this.#client });
    return projectQuotaSnapshot(snapshot, this.#lastRateLimitUpdateAt);
  }

  async injectContinuity({ threadId, text }) {
    if (typeof text !== "string" || !text.trim()) throw new Error("continuity text must be non-empty");
    await this.#request("thread/resume", { threadId, excludeTurns: true });
    await this.#request("thread/inject_items", {
      threadId,
      items: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }],
    });
    return { status: "injected", threadId, modelTurnStarted: false };
  }

  async browserPrerequisites({ cwd = this.#defaultCwd } = {}) {
    const effectiveCwd = path.resolve(cwd);
    const skillsResult = await this.#request("skills/list", { cwds: [effectiveCwd], forceReload: false });
    const skills = (skillsResult?.data ?? []).flatMap((row) => row?.skills ?? []);
    const chromeSkill = skills.find((skill) => skill?.name === CHROME_SKILL_NAME && skill?.enabled !== false);
    if (!chromeSkill?.path) return { status: "unavailable", reason: "chrome_skill_unavailable", chromeSkillPath: null, nodeRepl: false };

    const mcp = await this.#request("mcpServerStatus/list", { detail: "toolsAndAuthOnly", limit: 50 });
    const nodeRepl = (mcp?.data ?? []).find((server) => server?.name === NODE_REPL_SERVER);
    const tools = nodeRepl?.tools && typeof nodeRepl.tools === "object" ? Object.values(nodeRepl.tools) : [];
    const js = tools.find((tool) => tool?.name === NODE_REPL_TOOL);
    if (!js || nodeRepl?.error) {
      return { status: "unavailable", reason: "node_repl_unavailable", chromeSkillPath: chromeSkill.path, nodeRepl: false, nodeReplError: nodeRepl?.error ?? null };
    }
    return { status: "ok", chromeSkillPath: chromeSkill.path, nodeRepl: true };
  }

  async nodeReplCall({ cwd = this.#defaultCwd, arguments: args = {}, meta = null, expectedGeneration = null }) {
    const effectiveCwd = path.resolve(cwd);
    const threadId = await this.#ensureThread(effectiveCwd, expectedGeneration);
    const params = { server: NODE_REPL_SERVER, tool: NODE_REPL_TOOL, threadId, arguments: args };
    if (meta && typeof meta === "object") params._meta = meta;
    const result = await this.#request("mcpServer/tool/call", params, { timeoutMs: 60_000, expectedGeneration });
    const contentItems = Array.isArray(result?.content) ? structuredClone(result.content) : [];
    const textParts = contentItems.filter((item) => item?.type === "text" && typeof item.text === "string").map((item) => item.text);
    return {
      isError: result?.isError === true,
      text: textParts.length ? textParts.join("\n") : null,
      contentItems,
      data: result?.structuredContent === undefined ? null : structuredClone(result.structuredContent),
    };
  }

  async #ensureStarted() {
    if (this.#client.running) return this.#client.initializedResult ?? null;
    if (this.#startPromise) return this.#startPromise;
    const restarting = this.#generation > 0;
    this.#startPromise = (async () => {
      if (restarting) this.#threadsByCwd.clear();
      const initialized = await this.#client.start();
      this.#generation += 1;
      return initialized;
    })();
    try { return await this.#startPromise; }
    finally { this.#startPromise = null; }
  }

  async #request(method, params, { expectedGeneration = null, ...options } = {}) {
    await this.#ensureStarted();
    if (expectedGeneration !== null && expectedGeneration !== this.#generation) {
      throw new Error(`PUBLIC_CONTEXT_GENERATION_STALE: expected=${expectedGeneration} current=${this.#generation}; the Codex app-server restarted before this request was dispatched`);
    }
    return this.#client.request(method, params, options);
  }

  async #ensureThread(cwd, expectedGeneration = null) {
    await this.#ensureStarted();
    if (expectedGeneration !== null && expectedGeneration !== this.#generation) {
      throw new Error(`PUBLIC_CONTEXT_GENERATION_STALE: expected=${expectedGeneration} current=${this.#generation}; the Codex app-server restarted before this request was dispatched`);
    }
    const existing = this.#threadsByCwd.get(cwd);
    if (existing) return existing;
    const started = await this.#request("thread/start", { cwd, ephemeral: true, permissions: ":read-only" }, { expectedGeneration });
    const threadId = started?.thread?.id;
    if (!threadId) throw new Error("thread/start returned no thread id for public runtime context");
    this.#threadsByCwd.set(cwd, threadId);
    return threadId;
  }
}

export function sanitizeHistoryPayload(value) {
  if (Array.isArray(value)) return value.map(sanitizeHistoryPayload);
  if (!value || typeof value !== "object") return value;

  const type = typeof value.type === "string" ? value.type.toLowerCase() : "";
  if (type === "reasoning") {
    const reasoning = {};
    for (const key of ["id", "type", "summary", "phase", "status"]) {
      if (value[key] !== undefined) reasoning[key] = sanitizeHistoryPayload(value[key]);
    }
    return reasoning;
  }

  const output = {};
  for (const [key, child] of Object.entries(value)) {
    const lower = key.toLowerCase();
    if (lower === "path" && typeof value.id === "string" && typeof value.cwd === "string") continue;
    if (lower === "encryptedcontent" || lower === "encrypted_content") continue;
    if (lower === "rawreasoning" || lower === "raw_reasoning" || lower === "rawcontent" || lower === "raw_content") continue;
    output[key] = sanitizeHistoryPayload(child);
  }
  return output;
}

export function projectQuotaSnapshot(snapshot, latestUpdateObservedAt = null) {
  const projectedRateLimits = snapshot?.rateLimits?.status === "ok"
    ? {
        status: "ok",
        method: snapshot.rateLimits.method,
        limits: Array.isArray(snapshot.rateLimits.value?.limits)
          ? snapshot.rateLimits.value.limits.map((limit) => ({
              key: limit.key ?? null,
              limitId: limit.limitId ?? null,
              limitName: limit.limitName ?? null,
              planType: limit.planType ?? null,
              rateLimitReachedType: limit.rateLimitReachedType ?? null,
              spendControlReached: limit.spendControlReached ?? null,
              windows: Array.isArray(limit.windows) ? limit.windows.map((window) => ({
                kind: window.kind,
                usedPercent: window.usedPercent,
                resetsAt: window.resetsAt,
                windowDurationMins: window.windowDurationMins,
              })) : [],
            }))
          : [],
      }
    : { status: snapshot?.rateLimits?.status ?? "unavailable", method: snapshot?.rateLimits?.method ?? "account/rateLimits/read", error: snapshot?.rateLimits?.error ?? null };
  const limits = projectedRateLimits.status === "ok" ? projectedRateLimits.limits : [];
  const exactCodex = limits.filter((limit) => [limit.key, limit.limitId].some((value) => typeof value === "string" && value.toLowerCase() === "codex"));
  const relevant = exactCodex.length ? exactCodex : limits.filter((limit) => /codex/i.test(`${limit.key ?? ""} ${limit.limitId ?? ""} ${limit.limitName ?? ""}`));
  const considered = relevant.length ? relevant : limits;
  const exhausted = considered.some((limit) => limit.spendControlReached === true || Boolean(limit.rateLimitReachedType) || limit.windows.some((window) => Number(window.usedPercent) >= 100));
  const resetCandidates = considered.flatMap((limit) => limit.windows.map((window) => window.resetsAt)).filter(Number.isInteger);
  return {
    status: snapshot?.status ?? "unavailable",
    observedAt: snapshot?.observedAt ?? null,
    codex: {
      availability: !considered.length ? "unknown" : exhausted ? "exhausted" : "available",
      exhausted,
      resetsAt: resetCandidates.length ? Math.min(...resetCandidates) : null,
      limits: considered,
    },
    rateLimits: projectedRateLimits,
    latestUpdateObserved: latestUpdateObservedAt !== null,
    latestUpdateObservedAt,
  };
}
