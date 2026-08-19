import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveRootboundPaths } from "../src/state-paths.mjs";
import { openStateStore } from "../src/state-store.mjs";

const root = await mkdtemp(path.join(os.tmpdir(), "rootbound-state-migration-v4-"));
const paths = resolveRootboundPaths({ env: { ROOTBOUND_HOME: path.join(root, "home") } });
await mkdir(paths.stateDir, { recursive: true });
const legacy = new DatabaseSync(paths.dbPath);
legacy.exec(`
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  INSERT INTO meta(key, value) VALUES('schema_version', '3');
  CREATE TABLE projects (
    project_ref TEXT PRIMARY KEY, root TEXT NOT NULL UNIQUE, git_root TEXT, name TEXT NOT NULL,
    trusted INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_connected_at INTEGER
  );
  CREATE TABLE bindings (
    binding_ref TEXT PRIMARY KEY, project_ref TEXT NOT NULL, thread_id TEXT NOT NULL, thread_preview_json TEXT,
    created_at INTEGER NOT NULL, touched_at INTEGER NOT NULL, checkpoint_count INTEGER NOT NULL DEFAULT 0,
    last_checkpoint_at INTEGER, last_ack_seq INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE commands (
    command_id TEXT PRIMARY KEY, project_ref TEXT NOT NULL, argv_json TEXT NOT NULL, cwd TEXT NOT NULL,
    binding_ref TEXT, status TEXT NOT NULL, access TEXT NOT NULL DEFAULT 'readOnly', timeout_ms INTEGER NOT NULL DEFAULT 120000,
    worker_pid INTEGER, exit_code INTEGER, started_at INTEGER NOT NULL, finished_at INTEGER, updated_at INTEGER,
    stdout TEXT, stderr TEXT, stdout_truncated INTEGER NOT NULL DEFAULT 0, stderr_truncated INTEGER NOT NULL DEFAULT 0, error TEXT
  );
  CREATE TABLE checkpoints (
    checkpoint_id TEXT PRIMARY KEY, project_ref TEXT NOT NULL, binding_ref TEXT, through_seq INTEGER,
    created_at INTEGER NOT NULL, payload_json TEXT NOT NULL
  );
  CREATE TABLE events (
    event_id INTEGER PRIMARY KEY AUTOINCREMENT, project_ref TEXT, binding_ref TEXT, kind TEXT NOT NULL,
    payload_json TEXT NOT NULL, created_at INTEGER NOT NULL
  );
`);
legacy.close();

const store = await openStateStore({ paths });
try {
  const version = store.db.prepare("SELECT value FROM meta WHERE key='schema_version'").get();
  assert.equal(version.value, "5");
  const table = store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='command_output_chunks'").get();
  assert.equal(table.name, "command_output_chunks");
  const rescueTable = store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='rescue_sessions'").get();
  assert.equal(rescueTable.name, "rescue_sessions");
  const rescueMutationTable = store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='rescue_mutations'").get();
  assert.equal(rescueMutationTable.name, "rescue_mutations");

  const now = Date.now();
  store.upsertProject({ projectRef: "project_test", root: root, gitRoot: null, name: "test", trusted: false, createdAt: now, updatedAt: now, lastConnectedAt: null });
  store.createCommand({ commandId: "command_00000000-0000-0000-0000-000000000001", projectRef: "project_test", argv: ["echo", "hi"], cwd: root, status: "running", access: "readOnly", timeoutMs: 1000, startedAt: now, updatedAt: now });
  const cursor = store.appendCommandOutput({ commandId: "command_00000000-0000-0000-0000-000000000001", stream: "stdout", data: Buffer.from("hello"), createdAt: now });
  assert.ok(cursor > 0);
  const chunks = store.listCommandOutputAfter("command_00000000-0000-0000-0000-000000000001", 0, 10);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].data.toString("utf8"), "hello");
  assert.equal(store.commandOutputBytes("command_00000000-0000-0000-0000-000000000001"), 5);
} finally {
  store.close();
}
console.log("state-migration-v4: ok");
