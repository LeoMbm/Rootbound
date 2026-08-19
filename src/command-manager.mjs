import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import { assertNoNestedCodexInvocation } from "./public-command-policy.mjs";
import { projectRefForRoot } from "./project-registry.mjs";
import { isProcessAlive } from "./runtime-state.mjs";
import { assertDurableCommandHasNoSecrets } from "./secret-boundaries.mjs";
import { openStreamingCommandSession } from "./streaming-command-session.mjs";

const ACTIVE = new Set(["starting", "running", "stopping"]);
const DEFAULT_OUTPUT_CAP = 2 * 1024 * 1024;

export function createCommandManager({
  store,
  continuityState = null,
  rescueManager = null,
  authorityExecutor,
  codexBin,
  configOverrides = [],
  packageRoot,
  env = process.env,
  platform = process.platform,
  now = () => Date.now(),
  spawnFn = spawn,
  sessionFactory = openStreamingCommandSession,
  outputBytesCap = DEFAULT_OUTPUT_CAP,
} = {}) {
  if (!store || !codexBin || !packageRoot) throw new Error("command manager requires store, codexBin, and packageRoot");
  if (platform !== "win32" && !authorityExecutor) throw new Error("streaming command manager requires authorityExecutor outside Windows");
  if (!Array.isArray(configOverrides)) throw new Error("configOverrides must be an array");
  if (!Number.isInteger(outputBytesCap) || outputBytesCap < 1024) throw new Error("outputBytesCap must be at least 1024");

  const sessions = new Map();
  const persistedBytes = new Map();

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
    if (!row || !ACTIVE.has(row.status)) return row;
    if (sessions.has(row.commandId)) return row;
    if (row.workerPid && isProcessAlive(row.workerPid)) return row;
    const at = now();
    return store.updateCommand(row.commandId, { status: "interrupted", finishedAt: at, workerPid: null, error: row.error ?? "command runtime is no longer active", updatedAt: at });
  }

  function appendOutput(commandId, stream, data) {
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data ?? "");
    if (!buffer.length) return;
    const used = persistedBytes.has(commandId) ? persistedBytes.get(commandId) : store.commandOutputBytes(commandId);
    const remaining = Math.max(0, outputBytesCap - used);
    if (remaining > 0) {
      const accepted = buffer.subarray(0, remaining);
      if (accepted.length) store.appendCommandOutput({ commandId, stream, data: accepted, createdAt: now() });
      persistedBytes.set(commandId, used + accepted.length);
    }
    if (buffer.length > remaining) {
      const current = store.getCommand(commandId);
      const patch = stream === "stderr" ? { stderrTruncated: true } : { stdoutTruncated: true };
      if (current) store.updateCommand(commandId, { ...patch, updatedAt: now() });
    }
  }

  function finishStreaming(commandId, result, error = null) {
    const row = store.getCommand(commandId);
    if (!row) return;
    const at = now();
    const exitCode = Number.isInteger(result?.exitCode) ? result.exitCode : null;
    const status = error ? "failed" : exitCode === 0 ? "completed" : "failed";
    store.updateCommand(commandId, {
      status,
      exitCode,
      finishedAt: at,
      workerPid: null,
      error: error ? (error instanceof Error ? error.message : String(error)) : exitCode === 0 ? null : `command exited with code ${exitCode}`,
      updatedAt: at,
    });
    store.recordEvent({ projectRef: row.projectRef, bindingRef: row.bindingRef, kind: error ? "command.failed" : "command.finished", payload: { commandId, exitCode }, createdAt: at });
    if (row.bindingRef && row.access === "inherit" && rescueManager) {
      const rescue = rescueManager.activeByBinding(row.bindingRef);
      if (rescue) void rescueManager.refreshExpected(rescue, { rollbackSafe: false, reason: "long_command_write_capable" }).catch(() => {});
    }
    const session = sessions.get(commandId);
    sessions.delete(commandId);
    persistedBytes.delete(commandId);
    void session?.close().catch(() => {});
  }

  return {
    async start({ command, cwd = null, bindingRef = null, access = "inherit", timeoutMs = 10 * 60_000, tty = false }) {
      if (!Array.isArray(command) || command.length === 0 || !command.every((value) => typeof value === "string")) throw new Error("command must be a non-empty argv string array");
      if (!["inherit", "readOnly"].includes(access)) throw new Error("access must be inherit or readOnly");
      if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 30 * 60_000) throw new Error("timeoutMs must be between 1000 and 1800000");
      assertNoNestedCodexInvocation(command, { codexBin });
      assertDurableCommandHasNoSecrets(command);
      const scope = scopeFor({ bindingRef, cwd });
      const rescue = scope.bindingRef && rescueManager ? rescueManager.activeByBinding(scope.bindingRef) : null;
      if (rescue && access === "inherit") {
        await rescueManager.assertNoDrift(rescue);
        rescueManager.markRollbackPartial(rescue, "long_command_write_capable");
      }
      const at = now();
      const commandId = `command_${randomUUID()}`;
      store.createCommand({ commandId, projectRef: scope.projectRef, bindingRef: scope.bindingRef, argv: command, cwd: scope.cwd, status: "starting", access, timeoutMs, startedAt: at, updatedAt: at });

      if (platform === "win32") {
        const child = spawnFn(process.execPath, [path.join(packageRoot, "scripts", "command-worker.mjs")], {
          cwd: packageRoot,
          env: { ...env, ROOTBOUND_HOME: store.paths.root, ROOTBOUND_COMMAND_ID: commandId },
          detached: true,
          windowsHide: true,
          stdio: "ignore",
        });
        child.once?.("error", (error) => {
          const failedAt = now();
          try { store.updateCommand(commandId, { status: "failed", finishedAt: failedAt, workerPid: null, error: error instanceof Error ? error.message : String(error), updatedAt: failedAt }); } catch {}
        });
        child.unref?.();
        const row = store.updateCommand(commandId, { workerPid: child.pid ?? null, updatedAt: now() });
        return { ...row, mode: "buffered", interactive: false };
      }

      try {
        const session = await sessionFactory({
          authorityExecutor,
          codexBin,
          configOverrides,
          command,
          cwd: scope.cwd,
          access,
          processId: commandId,
          timeoutMs,
          tty,
          platform,
          onOutput: ({ stream, data }) => appendOutput(commandId, stream, data),
        });
        sessions.set(commandId, session);
        const running = store.updateCommand(commandId, { status: "running", updatedAt: now() });
        store.recordEvent({ projectRef: scope.projectRef, bindingRef: scope.bindingRef, kind: "command.running", payload: { commandId, mode: "streaming" }, createdAt: now() });
        void session.result.then((result) => finishStreaming(commandId, result), (error) => finishStreaming(commandId, null, error));
        return { ...running, mode: "streaming", interactive: true };
      } catch (error) {
        const failedAt = now();
        store.updateCommand(commandId, { status: "failed", finishedAt: failedAt, error: error instanceof Error ? error.message : String(error), updatedAt: failedAt });
        throw error;
      }
    },

    poll(commandId, { cursor = 0, limit = 100 } = {}) {
      if (!Number.isInteger(cursor) || cursor < 0) throw new Error("cursor must be a non-negative integer");
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error("limit must be between 1 and 500");
      const row = store.getCommand(commandId);
      if (!row) throw new Error(`unknown commandId: ${commandId}`);
      const command = reconcile(row);
      const chunks = store.listCommandOutputAfter(commandId, cursor, limit).map((chunk) => ({ cursor: chunk.cursor, stream: chunk.stream, text: chunk.data.toString("utf8"), bytes: chunk.data.length, at: chunk.at }));
      return {
        commandId,
        bindingRef: command.bindingRef ?? null,
        cwd: command.cwd,
        access: command.access,
        status: command.status,
        exitCode: command.exitCode,
        error: command.error,
        chunks,
        nextCursor: chunks.length ? chunks[chunks.length - 1].cursor : cursor,
        stdoutTruncated: command.stdoutTruncated,
        stderrTruncated: command.stderrTruncated,
        active: ACTIVE.has(command.status),
        interactive: platform !== "win32",
        finishedAt: command.finishedAt,
      };
    },

    async write(commandId, { data = "", closeStdin = false } = {}) {
      if (platform === "win32") throw typedError("COMMAND_STDIN_UNSUPPORTED", "command_write is not supported by the accepted Codex Windows streaming implementation.", ["Run the command non-interactively on Windows.", "Use macOS for stdin streaming until upstream Windows support lands."]);
      const session = sessions.get(commandId);
      if (!session) throw typedError("COMMAND_SESSION_NOT_ACTIVE", `No active streaming session for ${commandId}`, ["Poll the command status; if interrupted, start it again."]);
      const payload = Buffer.from(String(data), "utf8");
      return session.write({ data: payload, closeStdin });
    },

    async terminate(commandId) {
      const row = this.poll(commandId, { cursor: 0, limit: 1 });
      if (!row.active) return { commandId, status: row.status, terminated: false, reason: "not_active" };
      if (platform === "win32") {
        const command = store.getCommand(commandId);
        if (!command?.workerPid || !isProcessAlive(command.workerPid)) return { commandId, status: "interrupted", terminated: false, reason: "worker_not_running" };
        process.kill(command.workerPid, "SIGTERM");
        store.updateCommand(commandId, { status: "stopping", updatedAt: now() });
        return { commandId, status: "stopping", terminated: true, mode: "worker-signal" };
      }
      const session = sessions.get(commandId);
      if (!session) throw typedError("COMMAND_SESSION_NOT_ACTIVE", `No active streaming session for ${commandId}`, ["Poll the command status; if interrupted, start it again."]);
      const result = await session.terminate();
      store.updateCommand(commandId, { status: "stopping", updatedAt: now() });
      return { commandId, status: "stopping", ...result, mode: "app-server" };
    },

    async close() {
      const pending = [...sessions.entries()];
      sessions.clear();
      await Promise.allSettled(pending.map(async ([commandId, session]) => {
        await session.close({ terminate: true });
        const row = store.getCommand(commandId);
        if (row && ACTIVE.has(row.status)) store.updateCommand(commandId, { status: "interrupted", finishedAt: now(), error: row.error ?? "Rootbound runtime stopped while command was active", updatedAt: now() });
      }));
    },
  };
}

function typedError(code, message, nextActions = []) {
  const error = new Error(message);
  error.code = code;
  error.nextActions = nextActions;
  return error;
}
