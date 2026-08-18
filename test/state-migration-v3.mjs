import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveCodexlessPaths } from "../src/state-paths.mjs";
import { openStateStore } from "../src/state-store.mjs";

const root = await mkdtemp(path.join(os.tmpdir(), "codexless-state-migration-v3-"));
const paths = resolveCodexlessPaths({ env: { CODEXLESS_HOME: path.join(root, "home") } });
await mkdir(paths.stateDir, { recursive: true });
const legacy = new DatabaseSync(paths.dbPath);
legacy.exec(`
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  INSERT INTO meta(key, value) VALUES('schema_version', '2');
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
    status TEXT NOT NULL, exit_code INTEGER, started_at INTEGER NOT NULL, finished_at INTEGER
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
  assert.equal(version.value, "3");
  const columns = new Set(store.db.prepare("PRAGMA table_info(commands)").all().map((row) => row.name));
  for (const column of ["binding_ref", "access", "timeout_ms", "worker_pid", "updated_at", "stdout", "stderr", "stdout_truncated", "stderr_truncated", "error"]) {
    assert.equal(columns.has(column), true, `missing migrated command column ${column}`);
  }
} finally {
  store.close();
}
console.log("state-migration-v3: ok");
