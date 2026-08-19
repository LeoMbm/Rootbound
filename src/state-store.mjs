import { DatabaseSync } from "node:sqlite";
import { ensureRootboundStateDirs, resolveRootboundPaths } from "./state-paths.mjs";

const SCHEMA_VERSION = 4;

export async function openStateStore({ paths = resolveRootboundPaths() } = {}) {
  await ensureRootboundStateDirs(paths);
  const db = new DatabaseSync(paths.dbPath);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
  createSchema(db);
  migrateSchema(db);
  createIndexes(db);
  return createStore(db, paths);
}

function createSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS projects (
      project_ref TEXT PRIMARY KEY, root TEXT NOT NULL UNIQUE, git_root TEXT, name TEXT NOT NULL,
      trusted INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_connected_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS bindings (
      binding_ref TEXT PRIMARY KEY, project_ref TEXT NOT NULL, thread_id TEXT NOT NULL, thread_preview_json TEXT,
      created_at INTEGER NOT NULL, touched_at INTEGER NOT NULL, checkpoint_count INTEGER NOT NULL DEFAULT 0,
      last_checkpoint_at INTEGER, last_ack_seq INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY(project_ref) REFERENCES projects(project_ref) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS commands (
      command_id TEXT PRIMARY KEY, project_ref TEXT NOT NULL, argv_json TEXT NOT NULL, cwd TEXT NOT NULL,
      binding_ref TEXT, status TEXT NOT NULL, access TEXT NOT NULL DEFAULT 'readOnly', timeout_ms INTEGER NOT NULL DEFAULT 120000,
      worker_pid INTEGER, exit_code INTEGER, started_at INTEGER NOT NULL, finished_at INTEGER, updated_at INTEGER,
      stdout TEXT, stderr TEXT, stdout_truncated INTEGER NOT NULL DEFAULT 0, stderr_truncated INTEGER NOT NULL DEFAULT 0, error TEXT,
      FOREIGN KEY(project_ref) REFERENCES projects(project_ref) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS command_output_chunks (
      chunk_seq INTEGER PRIMARY KEY AUTOINCREMENT,
      command_id TEXT NOT NULL,
      stream TEXT NOT NULL,
      data BLOB NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY(command_id) REFERENCES commands(command_id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS checkpoints (
      checkpoint_id TEXT PRIMARY KEY, project_ref TEXT NOT NULL, binding_ref TEXT, through_seq INTEGER,
      created_at INTEGER NOT NULL, payload_json TEXT NOT NULL,
      FOREIGN KEY(project_ref) REFERENCES projects(project_ref) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS events (
      event_id INTEGER PRIMARY KEY AUTOINCREMENT, project_ref TEXT, binding_ref TEXT, kind TEXT NOT NULL,
      payload_json TEXT NOT NULL, created_at INTEGER NOT NULL,
      FOREIGN KEY(project_ref) REFERENCES projects(project_ref) ON DELETE CASCADE
    );
  `);
}

function createIndexes(db) {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_bindings_touched ON bindings(touched_at);
    CREATE INDEX IF NOT EXISTS idx_events_binding_seq ON events(binding_ref, event_id);
    CREATE INDEX IF NOT EXISTS idx_command_output_cursor ON command_output_chunks(command_id, chunk_seq);
  `);
}

function migrateSchema(db) {
  const current = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get();
  if (!current) {
    db.prepare("INSERT INTO meta(key, value) VALUES('schema_version', ?)").run(String(SCHEMA_VERSION));
    return;
  }
  let version = Number(current.value);
  if (version > SCHEMA_VERSION) throw new Error(`Unsupported Rootbound state schema: ${current.value}`);
  if (version < 2) {
    addColumnIfMissing(db, "bindings", "thread_preview_json", "TEXT");
    addColumnIfMissing(db, "bindings", "checkpoint_count", "INTEGER NOT NULL DEFAULT 0");
    addColumnIfMissing(db, "bindings", "last_checkpoint_at", "INTEGER");
    addColumnIfMissing(db, "bindings", "last_ack_seq", "INTEGER NOT NULL DEFAULT 0");
    addColumnIfMissing(db, "events", "binding_ref", "TEXT");
    db.prepare("UPDATE meta SET value='2' WHERE key='schema_version'").run();
    version = 2;
  }
  if (version < 3) {
    addColumnIfMissing(db, "commands", "binding_ref", "TEXT");
    addColumnIfMissing(db, "commands", "access", "TEXT NOT NULL DEFAULT 'readOnly'");
    addColumnIfMissing(db, "commands", "timeout_ms", "INTEGER NOT NULL DEFAULT 120000");
    addColumnIfMissing(db, "commands", "worker_pid", "INTEGER");
    addColumnIfMissing(db, "commands", "updated_at", "INTEGER");
    addColumnIfMissing(db, "commands", "stdout", "TEXT");
    addColumnIfMissing(db, "commands", "stderr", "TEXT");
    addColumnIfMissing(db, "commands", "stdout_truncated", "INTEGER NOT NULL DEFAULT 0");
    addColumnIfMissing(db, "commands", "stderr_truncated", "INTEGER NOT NULL DEFAULT 0");
    addColumnIfMissing(db, "commands", "error", "TEXT");
    db.exec("UPDATE commands SET updated_at=COALESCE(updated_at, started_at)");
    db.prepare("UPDATE meta SET value='3' WHERE key='schema_version'").run();
    version = 3;
  }
  if (version < 4) {
    db.prepare("UPDATE meta SET value='4' WHERE key='schema_version'").run();
    version = 4;
  }
  if (version !== SCHEMA_VERSION) throw new Error(`Unsupported Rootbound state schema: ${version}`);
}

function addColumnIfMissing(db, table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
  if (!columns.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function createStore(db, paths) {
  return {
    paths,
    db,
    close() { db.close(); },
    getProject(projectRef) { return normalizeProject(db.prepare("SELECT * FROM projects WHERE project_ref=?").get(projectRef)); },
    getProjectByRoot(root) { return normalizeProject(db.prepare("SELECT * FROM projects WHERE root=?").get(root)); },
    listProjects() { return db.prepare("SELECT * FROM projects ORDER BY updated_at DESC, name ASC").all().map(normalizeProject); },
    upsertProject(project) {
      db.prepare(`INSERT INTO projects(project_ref, root, git_root, name, trusted, created_at, updated_at, last_connected_at)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_ref) DO UPDATE SET root=excluded.root, git_root=excluded.git_root, name=excluded.name,
          trusted=excluded.trusted, updated_at=excluded.updated_at, last_connected_at=excluded.last_connected_at`).run(
        project.projectRef, project.root, project.gitRoot ?? null, project.name, project.trusted ? 1 : 0,
        project.createdAt, project.updatedAt, project.lastConnectedAt ?? null
      );
      return this.getProject(project.projectRef);
    },
    getBinding(bindingRef) { return normalizeBinding(db.prepare("SELECT * FROM bindings WHERE binding_ref=?").get(bindingRef)); },
    listBindings() { return db.prepare("SELECT * FROM bindings ORDER BY touched_at DESC").all().map(normalizeBinding); },
    upsertBinding(binding) {
      db.prepare(`INSERT INTO bindings(binding_ref, project_ref, thread_id, thread_preview_json, created_at, touched_at, checkpoint_count, last_checkpoint_at, last_ack_seq)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(binding_ref) DO UPDATE SET project_ref=excluded.project_ref, thread_id=excluded.thread_id,
          thread_preview_json=excluded.thread_preview_json, touched_at=excluded.touched_at, checkpoint_count=excluded.checkpoint_count,
          last_checkpoint_at=excluded.last_checkpoint_at, last_ack_seq=excluded.last_ack_seq`).run(
        binding.bindingRef, binding.projectRef, binding.threadId, binding.threadPreview === null || binding.threadPreview === undefined ? null : JSON.stringify(binding.threadPreview),
        binding.createdAt, binding.touchedAt, binding.checkpointCount ?? 0, binding.lastCheckpointAt ?? null, binding.lastAckSeq ?? 0
      );
      return this.getBinding(binding.bindingRef);
    },
    deleteBinding(bindingRef) { return db.prepare("DELETE FROM bindings WHERE binding_ref=?").run(bindingRef).changes > 0; },
    deleteBindingsTouchedBefore(cutoff) { return db.prepare("DELETE FROM bindings WHERE touched_at < ?").run(cutoff).changes; },
    recordEvent({ projectRef = null, bindingRef = null, kind, payload = {}, createdAt = Date.now() }) {
      const result = db.prepare("INSERT INTO events(project_ref, binding_ref, kind, payload_json, created_at) VALUES(?, ?, ?, ?, ?)").run(projectRef, bindingRef, kind, JSON.stringify(payload), createdAt);
      return Number(result.lastInsertRowid);
    },
    listBindingEventsAfter(bindingRef, afterSeq = 0, limit = 10000) {
      return db.prepare("SELECT event_id, kind, payload_json, created_at FROM events WHERE binding_ref=? AND event_id>? ORDER BY event_id ASC LIMIT ?")
        .all(bindingRef, afterSeq, limit).map((row) => ({ seq: Number(row.event_id), at: Number(row.created_at), kind: row.kind, ...JSON.parse(row.payload_json) }));
    },
    deleteBindingEventsThrough(bindingRef, throughSeq) { return db.prepare("DELETE FROM events WHERE binding_ref=? AND event_id<=?").run(bindingRef, throughSeq).changes; },
    addCheckpoint({ checkpointId, projectRef, bindingRef = null, throughSeq = null, createdAt = Date.now(), payload = {} }) {
      db.prepare("INSERT INTO checkpoints(checkpoint_id, project_ref, binding_ref, through_seq, created_at, payload_json) VALUES(?, ?, ?, ?, ?, ?)")
        .run(checkpointId, projectRef, bindingRef, throughSeq, createdAt, JSON.stringify(payload));
    },
    createCommand(command) {
      db.prepare(`INSERT INTO commands(command_id, project_ref, argv_json, cwd, binding_ref, status, access, timeout_ms, worker_pid, exit_code, started_at, finished_at, updated_at, stdout, stderr, stdout_truncated, stderr_truncated, error)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(command.commandId, command.projectRef, JSON.stringify(command.argv), command.cwd, command.bindingRef ?? null, command.status, command.access ?? "readOnly", command.timeoutMs ?? 120000, command.workerPid ?? null, command.exitCode ?? null, command.startedAt, command.finishedAt ?? null, command.updatedAt ?? command.startedAt, command.stdout ?? null, command.stderr ?? null, command.stdoutTruncated ? 1 : 0, command.stderrTruncated ? 1 : 0, command.error ?? null);
      return this.getCommand(command.commandId);
    },
    getCommand(commandId) { return normalizeCommand(db.prepare("SELECT * FROM commands WHERE command_id=?").get(commandId)); },
    updateCommand(commandId, patch = {}) {
      const current = this.getCommand(commandId);
      if (!current) return null;
      const next = { ...current, ...patch, commandId, updatedAt: patch.updatedAt ?? Date.now() };
      db.prepare(`UPDATE commands SET status=?, access=?, timeout_ms=?, worker_pid=?, exit_code=?, finished_at=?, updated_at=?, stdout=?, stderr=?, stdout_truncated=?, stderr_truncated=?, error=? WHERE command_id=?`).run(next.status, next.access ?? "readOnly", next.timeoutMs ?? 120000, next.workerPid ?? null, next.exitCode ?? null, next.finishedAt ?? null, next.updatedAt, next.stdout ?? null, next.stderr ?? null, next.stdoutTruncated ? 1 : 0, next.stderrTruncated ? 1 : 0, next.error ?? null, commandId);
      return this.getCommand(commandId);
    },
    appendCommandOutput({ commandId, stream, data, createdAt = Date.now() }) {
      if (!new Set(["stdout", "stderr"]).has(stream)) throw new Error(`invalid command output stream: ${stream}`);
      const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data ?? "");
      if (!buffer.length) return null;
      const result = db.prepare("INSERT INTO command_output_chunks(command_id, stream, data, created_at) VALUES(?, ?, ?, ?)").run(commandId, stream, buffer, createdAt);
      return Number(result.lastInsertRowid);
    },
    listCommandOutputAfter(commandId, afterCursor = 0, limit = 100) {
      return db.prepare("SELECT chunk_seq, stream, data, created_at FROM command_output_chunks WHERE command_id=? AND chunk_seq>? ORDER BY chunk_seq ASC LIMIT ?")
        .all(commandId, afterCursor, limit)
        .map((row) => ({ cursor: Number(row.chunk_seq), stream: row.stream, data: Buffer.from(row.data), at: Number(row.created_at) }));
    },
    commandOutputBytes(commandId) {
      const row = db.prepare("SELECT COALESCE(SUM(length(data)), 0) AS bytes FROM command_output_chunks WHERE command_id=?").get(commandId);
      return Number(row?.bytes ?? 0);
    },
    interruptActiveCommands(at = Date.now()) {
      return db.prepare("UPDATE commands SET status='interrupted', finished_at=?, updated_at=?, error=COALESCE(error, 'runtime restarted while command was active') WHERE status IN ('starting','running','stopping')").run(at, at).changes;
    },
  };
}

function normalizeProject(row) {
  if (!row) return null;
  return { projectRef: row.project_ref, root: row.root, gitRoot: row.git_root, name: row.name, trusted: row.trusted === 1,
    createdAt: Number(row.created_at), updatedAt: Number(row.updated_at), lastConnectedAt: row.last_connected_at === null ? null : Number(row.last_connected_at) };
}
function normalizeBinding(row) {
  if (!row) return null;
  let threadPreview = null; try { threadPreview = row.thread_preview_json ? JSON.parse(row.thread_preview_json) : null; } catch {}
  return { bindingRef: row.binding_ref, projectRef: row.project_ref, threadId: row.thread_id, threadPreview,
    createdAt: Number(row.created_at), touchedAt: Number(row.touched_at), checkpointCount: Number(row.checkpoint_count ?? 0),
    lastCheckpointAt: row.last_checkpoint_at === null ? null : Number(row.last_checkpoint_at), lastAckSeq: Number(row.last_ack_seq ?? 0) };
}
function normalizeCommand(row) {
  if (!row) return null;
  let argv = []; try { argv = JSON.parse(row.argv_json); } catch {}
  return { commandId: row.command_id, projectRef: row.project_ref, bindingRef: row.binding_ref ?? null, argv, cwd: row.cwd, status: row.status,
    access: row.access ?? "readOnly", timeoutMs: Number(row.timeout_ms ?? 120000), workerPid: row.worker_pid === null ? null : Number(row.worker_pid),
    exitCode: row.exit_code === null ? null : Number(row.exit_code), startedAt: Number(row.started_at), finishedAt: row.finished_at === null ? null : Number(row.finished_at),
    updatedAt: row.updated_at === null ? Number(row.started_at) : Number(row.updated_at), stdout: row.stdout, stderr: row.stderr,
    stdoutTruncated: row.stdout_truncated === 1, stderrTruncated: row.stderr_truncated === 1, error: row.error };
}
