import process from "node:process";
import { ACCEPTED_CODEX_VERSIONS, CodexAuthorityExecutor } from "../src/codex-authority-executor.mjs";
import { resolveCodexExecutable } from "../src/codex-bin.mjs";
import { resolveCodexlessPaths } from "../src/state-paths.mjs";
import { openStateStore } from "../src/state-store.mjs";

const commandId = process.env.CODEXLESS_COMMAND_ID;
if (!commandId) throw new Error("CODEXLESS_COMMAND_ID is required");
const store = await openStateStore({ paths: resolveCodexlessPaths() });
const command = store.getCommand(commandId);
if (!command) { store.close(); throw new Error(`Unknown Codexless command: ${commandId}`); }
let terminal = false;

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (!terminal) {
      terminal = true;
      const at = Date.now();
      try { store.updateCommand(commandId, { status: "cancelled", finishedAt: at, workerPid: null, error: `cancelled by ${signal}`, updatedAt: at }); } catch {}
      try { store.recordEvent({ projectRef: command.projectRef, bindingRef: command.bindingRef, kind: "command.cancelled", payload: { commandId }, createdAt: at }); } catch {}
      try { store.close(); } catch {}
    }
    process.exit(signal === "SIGINT" ? 130 : 143);
  });
}

try {
  const resolution = await resolveCodexExecutable({ env: process.env, acceptedVersions: ACCEPTED_CODEX_VERSIONS });
  const executor = new CodexAuthorityExecutor({
    codexBin: resolution.path,
    defaultCwd: command.cwd,
    maxTimeoutMs: Math.max(command.timeoutMs, 120_000),
    watchdogGraceMs: 5_000,
    outputBytesCap: 1_048_576,
    acceptedCodexVersions: ACCEPTED_CODEX_VERSIONS,
  });
  await executor.validate();
  store.updateCommand(commandId, { status: "running", workerPid: process.pid, updatedAt: Date.now() });
  store.recordEvent({ projectRef: command.projectRef, bindingRef: command.bindingRef, kind: "command.running", payload: { commandId }, createdAt: Date.now() });
  const result = await executor.exec({ command: command.argv, cwd: command.cwd, access: command.access, timeoutMs: command.timeoutMs });
  const at = Date.now();
  terminal = true;
  store.updateCommand(commandId, {
    status: result.exitCode === 0 ? "completed" : "failed",
    exitCode: result.exitCode,
    finishedAt: at,
    workerPid: null,
    stdout: result.stdout,
    stderr: result.stderr,
    stdoutTruncated: result.stdoutTruncated === true,
    stderrTruncated: result.stderrTruncated === true,
    error: result.exitCode === 0 ? null : `command exited with code ${result.exitCode}`,
    updatedAt: at,
  });
  store.recordEvent({ projectRef: command.projectRef, bindingRef: command.bindingRef, kind: "command.finished", payload: { commandId, exitCode: result.exitCode }, createdAt: at });
} catch (error) {
  const at = Date.now();
  terminal = true;
  store.updateCommand(commandId, { status: "failed", finishedAt: at, workerPid: null, error: error instanceof Error ? error.message : String(error), updatedAt: at });
  store.recordEvent({ projectRef: command.projectRef, bindingRef: command.bindingRef, kind: "command.failed", payload: { commandId, error: error instanceof Error ? error.message : String(error) }, createdAt: at });
  process.exitCode = 1;
} finally {
  store.close();
}
