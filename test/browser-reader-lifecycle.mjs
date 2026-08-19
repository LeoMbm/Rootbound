import assert from "node:assert/strict";
import path from "node:path";
import { CodexBrowserReaderExecutor } from "../src/browser-reader-executor.mjs";

const cwd = path.resolve("C:\\rootbound-reader-lifecycle-fixture");

class FakeBrowserContext {
  constructor(name) {
    this.name = name;
    this.generation = 0;
    this.calls = [];
  }

  async browserPrerequisites() {
    return {
      status: "ok",
      chromeSkillPath: path.join(cwd, "skills", "chrome", "SKILL.md"),
    };
  }

  async nodeReplCall(request) {
    this.calls.push(structuredClone(request));
    const title = request?.arguments?.title ?? "";
    const code = request?.arguments?.code ?? "";

    if (title === "Check connected browser backends") {
      return ok([{ name: "Chrome", family: "chrome", type: "extension" }]);
    }
    if (title === "List current Chrome tabs") {
      return ok([
        { providerTabId: "provider-a", title: "A", url: "https://example.com/a", lastOpened: "2026-08-16T00:00:01Z" },
        { providerTabId: "provider-b", title: "B", url: "https://example.com/b", lastOpened: "2026-08-16T00:00:02Z" },
      ]);
    }
    if (title === "Read existing Chrome tab DOM") {
      const provider = code.includes('"provider-b"') ? "provider-b" : "provider-a";
      return ok({
        title: provider === "provider-a" ? "A" : "B",
        url: provider === "provider-a" ? "https://example.com/a" : "https://example.com/b",
        lastOpened: provider === "provider-a" ? "2026-08-16T00:00:01Z" : "2026-08-16T00:00:02Z",
        snapshot: provider === "provider-a" ? "A snapshot" : "B snapshot",
        lifecycleMode: "session-resume",
      });
    }
    throw new Error(`unexpected fake Browser call: ${title}`);
  }
}

function ok(value) {
  return { isError: false, text: JSON.stringify(value) };
}

function browserCalls(context, title) {
  return context.calls.filter((call) => call?.arguments?.title === title);
}

function sessionId(call) {
  return call?.meta?.["x-codex-turn-metadata"]?.session_id ?? null;
}

function turnId(call) {
  return call?.meta?.["x-codex-turn-metadata"]?.turn_id ?? null;
}

const contextA = new FakeBrowserContext("A");
const contextB = new FakeBrowserContext("B");
const readerA = new CodexBrowserReaderExecutor({ context: contextA, defaultCwd: cwd });
const readerB = new CodexBrowserReaderExecutor({ context: contextB, defaultCwd: cwd });

const [tabsA, tabsB] = await Promise.all([
  readerA.listTabs({ cwd }),
  readerB.listTabs({ cwd }),
]);
assert.equal(tabsA.count, 2);
assert.equal(tabsB.count, 2);
assert.notEqual(tabsA.tabs[0].tabRef, tabsB.tabs[0].tabRef, "each executor keeps its own opaque tab refs");

const firstListA = browserCalls(contextA, "List current Chrome tabs")[0];
const firstListB = browserCalls(contextB, "List current Chrome tabs")[0];
assert.match(sessionId(firstListA) ?? "", /^rootbound-browser-[0-9a-f]{20}$/);
assert.equal(sessionId(firstListA), sessionId(firstListB), "same cwd must derive the same stable Browser session across executors");
assert.notEqual(turnId(firstListA), turnId(firstListB), "separate Browser calls still require unique turn ids");

const [readA, readB] = await Promise.all([
  readerA.readTab({ tabRef: tabsA.tabs[0].tabRef, cwd, maxChars: 5000 }),
  readerB.readTab({ tabRef: tabsB.tabs[1].tabRef, cwd, maxChars: 5000 }),
]);
assert.equal(readA.tab.url, "https://example.com/a");
assert.equal(readB.tab.url, "https://example.com/b");
assert.equal(readA.lifecycleMode, "session-resume");
assert.equal(readB.lifecycleMode, "session-resume");

for (const call of [
  browserCalls(contextA, "Read existing Chrome tab DOM")[0],
  browserCalls(contextB, "Read existing Chrome tab DOM")[0],
]) {
  const code = call.arguments.code;
  assert.match(code, /__cxBrowser\.tabs\.list\(\)/, "Reader must inspect stable-session-owned tabs before claiming");
  assert.match(code, /__cxBrowser\.tabs\.get\(__cxOwnedInfo\.id\)/, "Reader must resume an already-owned exact tab");
  assert.match(code, /__cxBrowser\.user\.claimTab\(__cxInfo\)/, "Reader must retain a fresh-claim fallback for unowned user tabs");
  assert.match(code, /typeof __cxBrowser\.tabs\.finalize === "function"/, "Reader must tolerate runtimes where tabs.finalize is absent");
}

const originalSession = sessionId(firstListA);
contextA.generation += 1;
const tabsAfterRestart = await readerA.listTabs({ cwd });
assert.equal(tabsAfterRestart.count, 2);
const restartList = browserCalls(contextA, "List current Chrome tabs").at(-1);
assert.equal(sessionId(restartList), originalSession, "context/App Server generation changes must not rotate the stable Browser session");
assert.notEqual(turnId(restartList), turnId(firstListA), "post-restart calls must use a fresh turn id");
assert.notEqual(tabsAfterRestart.tabs[0].tabRef, tabsA.tabs[0].tabRef, "generation reset must retire stale opaque tab refs even while the stable Browser session survives");

await assert.rejects(
  () => readerA.readTab({ tabRef: tabsA.tabs[0].tabRef, cwd, maxChars: 5000 }),
  (error) => error?.code === "BROWSER_TAB_REF_UNKNOWN",
  "old opaque refs must not survive a local context generation reset"
);

const contextC = new FakeBrowserContext("C");
const readerAfterRestart = new CodexBrowserReaderExecutor({ context: contextC, defaultCwd: cwd });
await readerAfterRestart.listTabs({ cwd });
const firstListC = browserCalls(contextC, "List current Chrome tabs")[0];
assert.equal(sessionId(firstListC), originalSession, "a newly constructed Reader for the same cwd must rejoin the same stable Browser session");
assert.notEqual(turnId(firstListC), turnId(firstListA), "new executor calls still use unique turn ids");

console.log("Browser Reader stable-session lifecycle regression PASS");
