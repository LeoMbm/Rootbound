import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildDiagnosticSnapshot, redactText } from "../src/diagnostics.mjs";
import { resolveRootboundPaths } from "../src/state-paths.mjs";
import { openStateStore } from "../src/state-store.mjs";

const temp = await mkdtemp(path.join(os.tmpdir(), "rootbound-diagnostic-"));
const paths = resolveRootboundPaths({ env: { ROOTBOUND_HOME: path.join(temp, "home") } });
const packageRoot = path.join(temp, "package");
await mkdir(packageRoot);
await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({ name: "rootbound", version: "test" }));
const store = await openStateStore({ paths });
const now = Date.now();
const realHome = os.homedir();

try {
  store.upsertProject({ projectRef: "project_diag", root: path.join(realHome, "private-project"), gitRoot: path.join(realHome, "private-project"), name: "private-project", trusted: true, createdAt: now, updatedAt: now, lastConnectedAt: now });
  store.upsertBinding({ bindingRef: "binding_00000000-0000-0000-0000-000000000001", projectRef: "project_diag", threadId: "thread-super-secret-1234567890", threadPreview: { secret: "must-not-export" }, createdAt: now, touchedAt: now, checkpointCount: 0, lastCheckpointAt: null, lastAckSeq: 0 });
  store.createCommand({ commandId: "command_00000000-0000-0000-0000-000000000001", projectRef: "project_diag", argv: ["echo", "private-argv-secret"], cwd: path.join(realHome, "private-project"), status: "completed", access: "readOnly", timeoutMs: 1000, exitCode: 0, startedAt: now, finishedAt: now, updatedAt: now, stdout: "private-stdout-secret", stderr: "private-stderr-secret" });
  store.recordEvent({ projectRef: "project_diag", bindingRef: "binding_00000000-0000-0000-0000-000000000001", kind: "command.finished", payload: { commandId: "command_00000000-0000-0000-0000-000000000001", token: "event-token-secret", path: path.join(realHome, "private-project"), url: "https://example.test/?api_key=event-query-secret" }, createdAt: now });
  await writeFile(paths.logPath, `home=${realHome} Bearer abcdefghijklmnop https://x.test/?token=log-secret\n`);

  const snapshot = await buildDiagnosticSnapshot({ store, packageRoot });
  const text = JSON.stringify(snapshot);
  assert.equal(text.includes(realHome), false);
  assert.equal(text.includes("must-not-export"), false);
  assert.equal(text.includes("private-stdout-secret"), false);
  assert.equal(text.includes("private-stderr-secret"), false);
  assert.equal(text.includes("private-argv-secret"), false);
  assert.equal(text.includes("event-token-secret"), false);
  assert.equal(text.includes("event-query-secret"), false);
  assert.equal(text.includes("log-secret"), false);
  assert.equal(text.includes("abcdefghijklmnop"), false);
  assert.equal(snapshot.events[0].correlationId, "command_00000000-0000-0000-0000-000000000001");
  assert.equal(snapshot.privacy.stdoutIncluded, false);
  assert.equal(snapshot.privacy.threadPreviewIncluded, false);
  assert.match(snapshot.projects[0].root, /^~[/\\]/);

  assert.equal(redactText("/Users/alice/project token=abc", { home: "/Users/alice" }), "~/project token=<redacted>");
} finally {
  store.close();
}
console.log("diagnostics-v5: ok");
