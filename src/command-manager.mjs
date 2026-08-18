import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import { assertNoNestedCodexInvocation } from "./public-command-policy.mjs";
import { projectRefForRoot } from "./project-registry.mjs";
import { isProcessAlive } from "./runtime-state.mjs";

const ACTIVE = new Set(["starting", "running", "stopping"]);

export function createCommandManager({ store, continuityState = null, codexBin, packageRoot, env = process.env, now = () => Date.now(), spawnFn = spawn } = {}) {
  if (!store || !codexBin || !packageRoot) throw new Error("command manager requires store, codexBin, and packageRoot");

  function scopeFor({ bindingRef = null, cwd = null }) {
    if (bindingRef && continuityState) {
      const scoped = continuityState.assertCwd(bindingRef, cwd);
      const binding = continuityState.status(bindingRef);
      return { cwd: scoped.targetCwd, projectRef: binding.projectRef, bindingRef };
    }
    if (typeof cwd !== "string" || !cwd.trim()) throw new Error("cwd is required when no continuity bindingRef is provided");
    const root = path.resolve(cwd);
    let project = store.getProjectByRoot(root);
    if (!project) {
      const at = now();
      project = store.upsertProject({ projectRef: projectRefForRoot(root), root, gitRoot: null, name: path.basename(root), trusted: false, createdAt: at, updatedAt: at, lastConnectedAt: null });
    }
    return { cwd: root, projectRef: project.projectRef, bindingRef: null };
  }

  function reconcile(row) {
    if (!row || !ACTIVE.has(row.status) || !row.workerPid) return row;
    if (isProcessAlive(row.workerPid)) return row;
    const at = now();
    return store.updateCommand(row.commandId, { status: "interrupted", finishedAt: at, workerPid: null, error: row.error ?? "command worker is no longer running", updatedAt: at });
  }

  return {
    start({ command, cwd = null, bindingRef = null, access = "inherit", timeoutMs = 10 * 60_000 }) {
      if (!Array.isArray(command) || command.length === 0 || !command.every((value) => typeof value === "string")) throw new Error("command must be a non-empty argv string array");
      if (!["inherit", "readOnly"].includes(access)) throw new Error("access must be inherit or readOnly");
      if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 30 * 60_000) throw new Error("timeoutMs must be between 1000 and 1800000");
      assertNoNestedCodexInvocation(command, { codexBin });
      const scope = scopeFor({ bindingRef, cwd });
      const at = now();
      const commandId = `command_${randomUUID()}`;
      store.createCommand({ commandId, projectRef: scope.projectRef, bindingRef: scope.bindingRef, argv: command, cwd: scope.cwd, status: "starting", access, timeoutMs, startedAt: at, updatedAt: at });
      const child = spawnFn(process.execPath, [path.join(packageRoot, "scripts", "command-worker.mjs")], {
        cwd: packageRoot,
        env: { ...env, CODEXLESS_HOME: store.paths.root, CODEXLESS_COMMAND_ID: commandId },
        detached: true,
        windowsHide: true,
        stdio: "ignore",
      });
      child.once?.("error", (error) => {
        const failedAt = now();
        try { store.updateCommand(commandId, { status: "failed", finishedAt: failedAt, workerPid: null, error: error instanceof Error ? error.message : String(error), updatedAt: failedAt }); } catch {}
      });
      child.unref?.();
      return store.updateCommand(commandId, { workerPid: child.pid ?? null, updatedAt: now() });
    },
    status(commandId) {
      const row = store.getCommand(commandId);
      if (!row) throw new Error(`unknown commandId: ${commandId}`);
      return reconcile(row);
    },
    output(commandId) {
      const row = this.status(commandId);
      return { commandId: row.commandId, status: row.status, exitCode: row.exitCode, stdout: row.stdout ?? "", stderr: row.stderr ?? "", stdoutTruncated: row.stdoutTruncated, stderrTruncated: row.stderrTruncated, error: row.error, finishedAt: row.finishedAt };
    },
    stop(commandId, { force = false } = {}) {
      const row = this.status(commandId);
      if (!ACTIVE.has(row.status)) return { commandId, status: row.status, stopped: false, reason: "not_active" };
      if (!row.workerPid || !isProcessAlive(row.workerPid)) return { commandId, status: "interrupted", stopped: false, reason: "worker_not_running" };
      const signal = force ? "SIGKILL" : "SIGTERM";
      process.kill(row.workerPid, signal);
      const at = now();
      const next = store.updateCommand(commandId, { status: force ? "cancelled" : "stopping", finishedAt: force ? at : null, workerPid: force ? null : row.workerPid, error: force ? "force cancelled" : row.error, updatedAt: at });
      return { commandId, status: next.status, stopped: true, signal };
    },
  };
}
