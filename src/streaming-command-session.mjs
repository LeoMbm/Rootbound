import { CodexAppServerClient } from "./codex-app-server-client.mjs";
import { assertRemoteModelFreeMethod } from "./toolbox-method-registry.mjs";

const FORBIDDEN_NOTIFICATION = (method) =>
  method === "thread/tokenUsage/updated" || method === "mcpServer/startupStatus/updated" || method.startsWith("turn/");

export async function openStreamingCommandSession({
  authorityExecutor,
  codexBin,
  configOverrides = [],
  command,
  cwd,
  access = "inherit",
  processId,
  timeoutMs,
  tty = false,
  platform = process.platform,
  onOutput = () => {},
} = {}) {
  if (!authorityExecutor || !codexBin) throw new Error("streaming command session requires authorityExecutor and codexBin");
  if (platform === "win32") throw typedError(
    "COMMAND_STREAMING_UNSUPPORTED",
    "Interactive command streaming is not supported by the accepted Codex Windows sandbox command/exec implementation.",
    ["Run the command in buffered mode on Windows.", "Use macOS for command_write/interactive streaming until upstream Windows support lands."]
  );
  if (!Array.isArray(command) || command.length === 0) throw new Error("command must be a non-empty argv array");
  if (typeof processId !== "string" || !processId) throw new Error("streaming command session requires processId");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000) throw new Error("streaming command timeoutMs must be at least 1000");

  for (const method of ["command/exec", "command/exec/write", "command/exec/terminate"]) assertRemoteModelFreeMethod(method);
  const authority = await authorityExecutor.resolveAuthority({ cwd, access, timeoutMs: Math.min(timeoutMs, 15_000) });
  const client = new CodexAppServerClient({
    cwd: authority.effectiveCwd,
    launch: () => ({
      command: codexBin,
      args: [...configOverrides.flatMap((value) => ["-c", value]), "app-server", "--stdio"],
      options: { cwd: authority.effectiveCwd },
    }),
    requestTimeoutMs: Math.max(timeoutMs + 15_000, 30_000),
    initializeCapabilities: { experimentalApi: true },
    stderrHandler: () => {},
    clientInfo: { name: "codexless_streaming_command", title: "Codexless Streaming Command", version: "0.1.0" },
  });
  await client.start();

  let violation = null;
  let settled = false;
  const unsubscribe = client.onNotification((message) => {
    const method = String(message?.method ?? "");
    if (FORBIDDEN_NOTIFICATION(method) && !violation) {
      violation = typedError(
        "CODEX_MODEL_SIDE_EFFECT_DETECTED",
        `Model/runtime side effect appeared during model-free command streaming: ${method}`,
        ["Stop the command and re-run after verifying the accepted Codex App Server build."]
      );
      void client.request("command/exec/terminate", { processId }, { timeoutMs: 5_000 }).catch(() => {});
      return;
    }
    if (method !== "command/exec/outputDelta") return;
    const params = message?.params ?? {};
    if (params.processId !== processId) return;
    const stream = params.stream === "stderr" ? "stderr" : "stdout";
    const data = Buffer.from(String(params.deltaBase64 ?? ""), "base64");
    onOutput({ stream, data, capReached: params.capReached === true });
  });

  const result = client.request("command/exec", {
    command,
    processId,
    cwd: authority.effectiveCwd,
    permissionProfile: authority.permissionProfile,
    tty: Boolean(tty),
    streamStdin: true,
    streamStdoutStderr: true,
    disableOutputCap: true,
    timeoutMs,
  }, { timeoutMs: timeoutMs + 15_000 }).then((value) => {
    settled = true;
    if (violation) throw violation;
    return value;
  }, (error) => {
    settled = true;
    throw violation ?? error;
  });

  return {
    processId,
    cwd: authority.effectiveCwd,
    permissionProfile: authority.permissionProfile,
    permissionCeiling: authority.permissionCeiling,
    authoritySource: authority.authoritySource,
    trustedAncestor: authority.trustedAncestor,
    result,
    async write({ data = null, closeStdin = false } = {}) {
      if ((!data || data.length === 0) && !closeStdin) throw new Error("command write requires data or closeStdin");
      const params = { processId, closeStdin: Boolean(closeStdin) };
      if (data && data.length) params.deltaBase64 = Buffer.from(data).toString("base64");
      await client.request("command/exec/write", params, { timeoutMs: 5_000 });
      return { processId, writtenBytes: data?.length ?? 0, closeStdin: Boolean(closeStdin) };
    },
    async terminate() {
      if (settled) return { processId, terminated: false, reason: "already_settled" };
      await client.request("command/exec/terminate", { processId }, { timeoutMs: 5_000 });
      return { processId, terminated: true };
    },
    async close({ terminate = false } = {}) {
      unsubscribe();
      if (terminate && !settled) await client.request("command/exec/terminate", { processId }, { timeoutMs: 5_000 }).catch(() => {});
      await client.close().catch(() => {});
    },
  };
}

function typedError(code, message, nextActions = []) {
  const error = new Error(message);
  error.code = code;
  error.nextActions = nextActions;
  return error;
}
