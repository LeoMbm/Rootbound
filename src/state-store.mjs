import { DatabaseSync } from "node:sqlite";
import { ensureCodexlessStateDirs, resolveCodexlessPaths } from "./state-paths.mjs";

const SCHEMA_VERSION = 1;

export async function openStateStore({ paths = resolveCodexlessPaths() } = {}) {
  await ensureCodexlessStateDirs(paths);
  const db = new DatabaseSync(paths.dbPath);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS projects (
      project_ref TEXT PRIMARY KEY,
      root TEXT NOT NULL UNIQUE,
      git_root TEXT,
      name TEXT NOT NULL,
      trusted INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_connected_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS bindings (
      binding_ref TEXT PRIMARY KEY,
      project_ref TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      touched_at INTEGER NOT NULL,
      FOREIGN KEY(project_ref) REFERENCES projects(project_ref) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS commands (
      command_id TEXT PRIMARY KEY,
      project_ref TEXT NOT NULL,
      argv_json TEXT NOT NULL,
      cwd TEXT NOT NULL,
      status TEXT NOT NULL,
      exit_code INTEGER,
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      FOREIGN KEY(project_ref) REFERENCES projects(project_ref) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS checkpoints (
      checkpoint_id TEXT PRIMARY KEY,
      project_ref TEXT NOT NULL,
      binding_ref TEXT,
      through_seq INTEGER,
      created_at INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      FOREIGN KEY(project_ref) REFERENCES projects(project_ref) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS events (
      event_id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_ref TEXT,
      kind TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY(project_ref) REFERENCES projects(project_ref) ON DELETE CASCADE
    );
  `);
  const current = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get();
  if (!current) db.prepare("INSERT INTO meta(key, value) VALUES('schema_version', ?)").run(String(SCHEMA_VERSION));
  else if (Number(current.value) !== SCHEMA_VERSION) throw new Error(`Unsupported Codexless state schema: ${current.value}`);
  return createStore(db, paths);
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
    recordEvent({ projectRef = null, kind, payload = {}, createdAt = Date.now() }) {
      db.prepare("INSERT INTO events(project_ref, kind, payload_json, created_at) VALUES(?, ?, ?, ?)").run(projectRef, kind, JSON.stringify(payload), createdAt);
    },
  };
}

function normalizeProject(row) {
  if (!row) return null;
  return {
    projectRef: row.project_ref,
    root: row.root,
    gitRoot: row.git_root,
    name: row.name,
    trusted: row.trusted === 1,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    lastConnectedAt: row.last_connected_at === null ? null : Number(row.last_connected_at),
  };
}
