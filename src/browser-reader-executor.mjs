import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

const DEFAULT_MAX_SNAPSHOT_CHARS = 80_000;
const MAX_SNAPSHOT_CHARS = 200_000;

export class BrowserReaderError extends Error {
  constructor(code, message, nextActions = []) {
    super(message);
    this.name = "BrowserReaderError";
    this.code = code;
    this.nextActions = nextActions;
  }
}

export class CodexBrowserReaderExecutor {
  #context;
  #defaultCwd;
  #sessionId;
  #browserClientUrl = null;
  #tabs = new Map();
  #providerToRef = new Map();
  #contextGeneration = 0;

  constructor({ context, defaultCwd }) {
    if (!context) throw new Error("CodexBrowserReaderExecutor requires public context executor");
    if (!defaultCwd) throw new Error("CodexBrowserReaderExecutor requires defaultCwd");
    this.#context = context;
    this.#defaultCwd = path.resolve(defaultCwd);
    const sessionSeed = process.env.CODEXLESS_BROWSER_SESSION_KEY?.trim() || this.#defaultCwd;
    const sessionSuffix = createHash("sha256").update(sessionSeed).digest("hex").slice(0, 20);
    this.#sessionId = `codexless-browser-${sessionSuffix}`;
    this.#contextGeneration = this.#currentGeneration();
  }

  async status({ cwd = this.#defaultCwd } = {}) {
    const effectiveCwd = path.resolve(cwd);
    const dependency = await this.#dependencyStatus(effectiveCwd);
    if (dependency.status !== "ok") return dependency;
    try {
      const backends = await this.#listBackends(effectiveCwd);
      const chrome = backends.find((backend) => backend.family === "chrome");
      if (!chrome) {
        return {
          status: "unavailable",
          reason: "chrome_not_connected",
          chromeSkill: "ok",
          nodeRepl: "ok",
          connectedBrowsers: backends,
          nextActions: [
            "Open Chrome with the supported Codex Chrome extension/runtime enabled, then call codex.browser_status again.",
            "Browser Reader does not fall back to Computer Use.",
          ],
        };
      }
      return {
        status: "ok",
        chromeSkill: "ok",
        nodeRepl: "ok",
        chrome: sanitizeBackend(chrome),
        connectedBrowsers: backends.map(sanitizeBackend),
        authState: "site_specific_unknown",
        note: "Browser connectivity is healthy. Website login state is site-specific and is verified by reading the actual tab URL/page; Codexless does not infer authentication from extension connectivity alone.",
      };
    } catch (error) {
      return browserUnavailable(error);
    }
  }

  async listTabs({ cwd = this.#defaultCwd } = {}) {
    const effectiveCwd = path.resolve(cwd);
    await this.#requireReady(effectiveCwd);
    const rawTabs = await this.#runJson(effectiveCwd, `
const __cxBrowser = await globalThis.__codexlessBrowserAgent.browsers.get("chrome");
const __cxTabs = await __cxBrowser.user.openTabs();
nodeRepl.write(JSON.stringify(__cxTabs.map((tab) => ({
  providerTabId: tab.providerTabId,
  title: tab.title ?? null,
  url: tab.url ?? null,
  lastOpened: tab.lastOpened ?? null,
}))));
`, "List current Chrome tabs");

    if (!Array.isArray(rawTabs)) {
      throw new BrowserReaderError("BROWSER_PROTOCOL_ERROR", "Chrome openTabs returned a non-array result");
    }

    const currentProviders = new Set();
    const tabs = [];
    for (const raw of rawTabs) {
      const providerTabId = typeof raw?.providerTabId === "string" ? raw.providerTabId : null;
      if (!providerTabId) continue;
      currentProviders.add(providerTabId);
      let tabRef = this.#providerToRef.get(providerTabId);
      if (!tabRef) {
        tabRef = `browser_tab_${randomUUID()}`;
        this.#providerToRef.set(providerTabId, tabRef);
      }
      const state = {
        tabRef,
        providerTabId,
        contextGeneration: this.#contextGeneration,
        title: stringOrNull(raw.title),
        url: stringOrNull(raw.url),
        lastOpened: stringOrNull(raw.lastOpened),
        seenAt: Date.now(),
      };
      this.#tabs.set(tabRef, state);
      tabs.push(publicTab(state));
    }

    for (const [providerTabId, tabRef] of this.#providerToRef.entries()) {
      if (!currentProviders.has(providerTabId)) {
        this.#providerToRef.delete(providerTabId);
        this.#tabs.delete(tabRef);
      }
    }

    return {
      status: "ok",
      browser: "chrome",
      count: tabs.length,
      tabs,
      note: "tabRef values are opaque and valid only while this local runtime can still match the same open Chrome tab. Call codex.browser_tabs again after a backend restart or when a tab closes/moves unexpectedly.",
    };
  }

  async readTab({ tabRef, cwd = this.#defaultCwd, maxChars = DEFAULT_MAX_SNAPSHOT_CHARS }) {
    const effectiveCwd = path.resolve(cwd);
    if (typeof tabRef !== "string" || !tabRef) {
      throw new BrowserReaderError("BROWSER_TAB_REF_REQUIRED", "tabRef is required; call codex.browser_tabs first");
    }
    if (!Number.isInteger(maxChars) || maxChars < 1_000 || maxChars > MAX_SNAPSHOT_CHARS) {
      throw new BrowserReaderError("BROWSER_MAX_CHARS_INVALID", `maxChars must be an integer between 1000 and ${MAX_SNAPSHOT_CHARS}`);
    }
    await this.#requireReady(effectiveCwd);
    const state = this.#tabs.get(tabRef);
    if (!state) {
      throw new BrowserReaderError(
        "BROWSER_TAB_REF_UNKNOWN",
        `unknown or expired browser tabRef: ${tabRef}`,
        ["Call codex.browser_tabs again and use a fresh tabRef from the current Chrome session."]
      );
    }

    const providerLiteral = JSON.stringify(state.providerTabId);
    const result = await this.#runJson(effectiveCwd, `
const __cxBrowser = await globalThis.__codexlessBrowserAgent.browsers.get("chrome");
const __cxOpenTabs = await __cxBrowser.user.openTabs();
const __cxInfo = __cxOpenTabs.find((tab) => tab.providerTabId === ${providerLiteral});
if (!__cxInfo) throw new Error("CODEXLESS_BROWSER_TAB_STALE");
let __cxTab = null;
let __cxPayload = null;
try {
  const __cxOwnedTabs = await __cxBrowser.tabs.list();
  const __cxOwnedInfo = __cxOwnedTabs.find((tab) => String(tab.id) === String(__cxInfo.providerTabId));
  __cxTab = __cxOwnedInfo
    ? await __cxBrowser.tabs.get(__cxOwnedInfo.id)
    : await __cxBrowser.user.claimTab(__cxInfo);
  const __cxSnapshot = await __cxTab.playwright.domSnapshot();
  __cxPayload = {
    title: __cxInfo.title ?? null,
    url: __cxInfo.url ?? null,
    lastOpened: __cxInfo.lastOpened ?? null,
    snapshot: __cxSnapshot,
    lifecycleMode: __cxOwnedInfo ? "session-resume" : "fresh-claim",
  };
} finally {
  if (__cxTab && typeof __cxBrowser.tabs.finalize === "function") {
    await __cxBrowser.tabs.finalize({ keep: [] });
  }
}
nodeRepl.write(JSON.stringify(__cxPayload));
`, "Read existing Chrome tab DOM", { expectedGeneration: state.contextGeneration });

    const snapshot = typeof result?.snapshot === "string" ? result.snapshot : "";
    if (!snapshot && result?.snapshot !== "") {
      throw new BrowserReaderError("BROWSER_PROTOCOL_ERROR", "Chrome domSnapshot returned no text snapshot");
    }
    const truncated = snapshot.length > maxChars;
    const current = {
      ...state,
      title: stringOrNull(result?.title) ?? state.title,
      url: stringOrNull(result?.url) ?? state.url,
      lastOpened: stringOrNull(result?.lastOpened) ?? state.lastOpened,
      seenAt: Date.now(),
    };
    this.#tabs.set(tabRef, current);
    return {
      status: "ok",
      browser: "chrome",
      tab: publicTab(current),
      snapshot: truncated ? snapshot.slice(0, maxChars) : snapshot,
      snapshotChars: snapshot.length,
      returnedSnapshotChars: truncated ? maxChars : snapshot.length,
      snapshotTruncated: truncated,
      lifecycleMode: stringOrNull(result?.lifecycleMode) ?? "unknown",
      loadedContentOnly: true,
      authState: "site_specific_unknown",
      note: "Read-only snapshot of the currently loaded DOM. On Browser runtimes with tabs.finalize(), Codexless releases the claim after the read; on newer session-owned runtimes it reuses the same stable Browser session across App Server restarts. Codexless did not navigate, click, type, submit, or change page state. Lazy-loaded or virtualized content that is not currently present in the DOM may be absent.",
    };
  }

  #currentGeneration() {
    return Number.isInteger(this.#context?.generation) ? this.#context.generation : 0;
  }

  #syncGeneration() {
    const current = this.#currentGeneration();
    if (current === this.#contextGeneration) return false;
    this.#tabs.clear();
    this.#providerToRef.clear();
    this.#browserClientUrl = null;
    this.#contextGeneration = current;
    return true;
  }

  async #dependencyStatus(cwd) {
    try {
      const dependency = await this.#context.browserPrerequisites({ cwd });
      this.#syncGeneration();
      if (dependency.status !== "ok") {
        if (dependency.reason === "chrome_skill_unavailable") {
          return {
            status: "unavailable",
            reason: "chrome_skill_unavailable",
            chromeSkill: "missing",
            nodeRepl: "unknown",
            nextActions: [
              "Install/enable the current Codex Chrome Skill/plugin, then retry codex.browser_status.",
              "Browser Reader does not fall back to Computer Use.",
            ],
          };
        }
        return {
          status: "unavailable",
          reason: "node_repl_unavailable",
          chromeSkill: "ok",
          nodeRepl: "unavailable",
          nodeReplError: dependency.nodeReplError ?? null,
          nextActions: [
            "Restore the Codex node_repl MCP capability, then retry codex.browser_status.",
            "Browser Reader does not replace this path with generic Computer Use.",
          ],
        };
      }
      this.#browserClientUrl = this.#browserClientUrl ?? deriveBrowserClientUrl(dependency.chromeSkillPath);
      return { status: "ok", skillPathResolved: true, browserClientResolved: true };
    } catch (error) {
      this.#syncGeneration();
      return browserUnavailable(new BrowserReaderError(
        "BROWSER_DEPENDENCY_DISCOVERY_FAILED",
        `Could not read Codex Browser prerequisites: ${error instanceof Error ? error.message : String(error)}`
      ));
    }
  }

  async #requireReady(cwd) {
    const dependency = await this.#dependencyStatus(cwd);
    if (dependency.status !== "ok") {
      throw new BrowserReaderError(
        dependency.reason ?? "BROWSER_UNAVAILABLE",
        `Browser dependencies are unavailable: ${dependency.reason ?? "unknown"}`,
        dependency.nextActions ?? ["Call codex.browser_status for current diagnostics."]
      );
    }
    const backends = await this.#listBackends(cwd);
    if (!backends.some((backend) => backend.family === "chrome")) {
      throw new BrowserReaderError(
        "BROWSER_CHROME_NOT_CONNECTED",
        "The Codex Browser runtime is available but no connected Chrome extension/backend is visible",
        [
          "Open Chrome with the supported Codex Chrome extension/runtime enabled, then retry.",
          "Call codex.browser_status to distinguish Browser setup from site login state.",
        ]
      );
    }
  }

  async #listBackends(cwd) {
    const result = await this.#runJson(cwd, `
const __cxBackends = await globalThis.__codexlessBrowserAgent.browsers.list();
nodeRepl.write(JSON.stringify(__cxBackends.map((backend) => ({
  name: backend.name ?? null,
  family: backend.family ?? null,
  type: backend.type ?? null,
}))));
`, "Check connected browser backends");
    return Array.isArray(result) ? result.map(sanitizeBackend) : [];
  }

  async #runJson(cwd, body, title, { expectedGeneration = null } = {}) {
    const clientUrl = await this.#resolveBrowserClientUrl(cwd);
    const bootstrap = `
if (globalThis.__codexlessBrowserAgent?.browsers == null) {
  const { setupBrowserRuntime } = await import(${JSON.stringify(clientUrl)});
  globalThis.__codexlessBrowserAgent = await setupBrowserRuntime();
}
`;
    let response;
    try {
      response = await this.#context.nodeReplCall({
        cwd,
        arguments: { code: `${bootstrap}\n{\n${body}\n}`, title },
        meta: this.#nextTurnMeta(),
        expectedGeneration,
      });
      this.#syncGeneration();
    } catch (error) {
      const generationChanged = this.#syncGeneration();
      const message = error instanceof Error ? error.message : String(error);
      if (/PUBLIC_CONTEXT_GENERATION_STALE/i.test(message) || generationChanged) {
        throw new BrowserReaderError(
          "BROWSER_RUNTIME_RESTARTED",
          "The local Codex context runtime restarted before this Browser request could safely use its prior tab state",
          ["Call codex.browser_tabs again and use a fresh tabRef from the current runtime generation."]
        );
      }
      throw classifyBrowserError(error);
    }
    if (response?.isError) {
      throw classifyBrowserError(new Error(response?.text ?? "node_repl browser call failed"));
    }
    const text = typeof response?.text === "string" ? response.text.trim() : "";
    if (!text) {
      throw new BrowserReaderError(
        "BROWSER_EMPTY_RESPONSE",
        "Browser runtime returned no text result",
        ["Call codex.browser_status and retry after confirming Chrome/node_repl health."]
      );
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new BrowserReaderError(
        "BROWSER_PROTOCOL_ERROR",
        `Browser runtime returned non-JSON text: ${text.slice(0, 1000)}`,
        ["Use codex.browser_status to confirm the current Browser plugin/runtime contract."]
      );
    }
  }

  async #resolveBrowserClientUrl(cwd) {
    if (this.#browserClientUrl) return this.#browserClientUrl;
    const dependency = await this.#dependencyStatus(cwd);
    if (dependency.status !== "ok" || !this.#browserClientUrl) {
      throw new BrowserReaderError(
        dependency.reason ?? "BROWSER_CLIENT_UNAVAILABLE",
        "Could not resolve the current Codex Chrome browser-client runtime",
        dependency.nextActions ?? []
      );
    }
    return this.#browserClientUrl;
  }

  #nextTurnMeta() {
    return {
      "x-codex-turn-metadata": {
        session_id: this.#sessionId,
        turn_id: `${this.#sessionId}-${randomUUID()}`,
      },
    };
  }
}

function deriveBrowserClientUrl(skillPath) {
  const skillDir = path.dirname(path.resolve(skillPath));
  const versionRoot = path.resolve(skillDir, "..", "..");
  const browserClientPath = path.join(versionRoot, "scripts", "browser-client.mjs");
  return pathToFileURL(browserClientPath).href;
}

function sanitizeBackend(backend) {
  return {
    name: stringOrNull(backend?.name),
    family: stringOrNull(backend?.family),
    type: stringOrNull(backend?.type),
  };
}

function publicTab(state) {
  return {
    tabRef: state.tabRef,
    title: state.title,
    url: state.url,
    lastOpened: state.lastOpened,
  };
}

function stringOrNull(value) {
  return typeof value === "string" ? value : null;
}

function browserUnavailable(error) {
  const classified = classifyBrowserError(error);
  return {
    status: "unavailable",
    reason: classified.code ?? "browser_unavailable",
    error: classified.message,
    nextActions: classified.nextActions ?? ["Retry codex.browser_status after restoring the Browser runtime."],
  };
}

function classifyBrowserError(error) {
  if (error instanceof BrowserReaderError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (/CODEXLESS_BROWSER_TAB_STALE/i.test(message)) {
    return new BrowserReaderError(
      "BROWSER_TAB_REF_STALE",
      "The selected Chrome tab is no longer present in the connected browser session",
      ["Call codex.browser_tabs again and use a fresh tabRef."]
    );
  }
  if (/Missing required Codex turn metadata/i.test(message)) {
    return new BrowserReaderError(
      "BROWSER_TURN_METADATA_REJECTED",
      "The Codex Browser runtime rejected the Browser Reader turn metadata",
      ["Refresh Codexless/Browser runtime and retry from codex.browser_status."]
    );
  }
  return new BrowserReaderError(
    "BROWSER_BACKEND_ERROR",
    message,
    ["Call codex.browser_status to inspect the current Chrome Skill/node_repl/backend state before retrying."]
  );
}
