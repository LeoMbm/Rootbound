import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function resolveProjectRoot(input = ".") {
  const candidate = await realpath(path.resolve(input));
  const info = await stat(candidate);
  if (!info.isDirectory()) throw new Error(`Project path is not a directory: ${candidate}`);
  let gitRoot = null;
  try {
    const { stdout } = await execFileAsync("git", ["-C", candidate, "rev-parse", "--show-toplevel"], { encoding: "utf8", timeout: 5000 });
    gitRoot = await realpath(stdout.trim());
  } catch {}
  return { root: gitRoot ?? candidate, gitRoot };
}

export function projectRefForRoot(root) {
  const requested = path.resolve(root);
  let canonical = requested;
  try {
    canonical = realpathSync.native(requested);
  } catch {
    // Callers normally provide an existing project root. Keep a deterministic
    // fallback for validation/error paths where the directory may be absent.
  }
  const normalized = process.platform === "win32" ? canonical.toLowerCase() : canonical;
  return `project_${createHash("sha256").update(normalized).digest("hex").slice(0, 20)}`;
}

export async function registerProject(store, input = ".", { trusted = false, now = Date.now() } = {}) {
  const resolved = await resolveProjectRoot(input);
  const projectRef = projectRefForRoot(resolved.root);
  const existing = store.getProject(projectRef);
  const row = store.upsertProject({
    projectRef,
    root: resolved.root,
    gitRoot: resolved.gitRoot,
    name: path.basename(resolved.root),
    trusted: trusted || existing?.trusted === true,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    lastConnectedAt: now,
  });
  store.recordEvent({ projectRef, kind: existing ? "project.connected" : "project.registered", payload: { root: row.root, gitRoot: row.gitRoot } });
  return row;
}
