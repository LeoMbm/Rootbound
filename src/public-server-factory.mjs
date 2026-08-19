import { createRequire } from "node:module";
import { registerBrowserReaderTools } from "./browser-reader-tools.mjs";
import { registerCommandTools } from "./command-tools.mjs";
import { registerConstructionTools } from "./construction-tools.mjs";
import { registerPublicContextTools } from "./public-context-tools.mjs";
import { registerRepoTools } from "./repo-tools.mjs";
import { summarizeRedactedArgv } from "./secret-boundaries.mjs";
import { registerThreadHistoryTools } from "./thread-history-tools.mjs";
import { typedToolResponse } from "./tool-errors.mjs";
import { registerWorkspaceTools } from "./workspace-tools.mjs";
import { PUBLIC_SERVER_VERSION, PUBLIC_SURFACE_VERSION } from "./surface-contracts.mjs";

const require = createRequire(import.meta.url);
const { McpServer } = require("@modelcontextprotocol/server");
const z = require("zod/v4");
const bindingRefSchema = z.string().regex(/^binding_[0-9a-f-]{36}$/i).optional();

export function createPublicServerFactory({ executor, authorityExecutor, publicContext, browserReader, continuityState, commandManager, stateStore, maxConcurrent = 1 }) {
  if (!executor) throw new Error("Rootbound public server requires an authority executor");
  if (!authorityExecutor) throw new Error("Rootbound public server requires authorityExecutor");
  if (!publicContext) throw new Error("Rootbound public server requires publicContext");
  if (!browserReader) throw new Error("Rootbound public server requires browserReader");
  if (!continuityState) throw new Error("Rootbound public server requires continuityState");
  if (!commandManager) throw new Error("Rootbound public server requires commandManager");
  if (!stateStore) throw new Error("Rootbound public server requires stateStore");
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 4) throw new Error("maxConcurrent must be an integer between 1 and 4");

  const commandSchema = z.object({
    command: z.array(z.string().max(32_768)).min(1).max(128).describe("argv vector passed to official Codex command/exec under the locally resolved Codex permission profile"),
    cwd: z.string().min(1).max(32_768).optional().describe("Optional local working-directory context. cwd does not let the caller select or widen a permission profile."),
    access: z.enum(["inherit", "readOnly"]).default("readOnly").describe("readOnly is the safe compatibility default. inherit uses the locally authorized/resolved Codex permission profile."),
    timeoutMs: z.number().int().positive().max(120_000).default(30_000),
    bindingRef: bindingRefSchema.describe("Optional opaque continuity binding. When supplied, Rootbound scopes execution to the bound project and journals redacted command metadata for the next continuity checkpoint."),
  }).strict();

  return function createServer() {
    let inFlight = 0;
    const server = new McpServer(
      { name: "rootbound", title: "Rootbound Local", version: PUBLIC_SERVER_VERSION, description: "ChatGPT-only local coding bridge built on verified model-free Codex App Server primitives." },
      { instructions: "Rootbound Local is a ChatGPT-only, model-free coding surface. ChatGPT itself must reason, plan, inspect, edit, run tests, interpret failures, and decide next steps. This server exposes no Codex model, model catalog, agent delegation, Task Card, or turn/start tool. Start project work with workspace_open to resolve the canonical projectRef/root/authority, then prefer repo_search/read_many/git_status/git_diff for inspection, apply_patch or precise_edit for edits, command_exec for short buffered tests/builds, and command_start plus command_poll for long-running work. Successful precise_edit calls may return a mutationId; use edit_undo/edit_redo for guarded local reversal while hashes still match. On supported platforms command_write can send stdin and command_terminate stops the active process. Never attempt to launch Codex CLI through command tools; nested Codex launches are refused. Use idempotencyKey on continuity_bind/checkpoint when network retries are possible; ambiguous checkpoint retries fail closed rather than inject twice. Long-running command argv is persisted and therefore rejects detected credentials; command_exec continuity labels are redacted before journaling. The checkpoint is an external delta handoff only; no Codex model turn is started." }
    );

    server.registerTool(
      "codex.command_exec",
      {
        title: "Run Authorized Project Command",
        description: "Run one buffered argv command through official Codex App Server command/exec without starting a Codex model turn. ChatGPT remains the reasoning model. Nested Codex CLI launches and wrappers carrying Codex commands are refused. If bindingRef is supplied, execution is scoped to the bound project and only redacted command metadata is journaled for the next continuity checkpoint.",
        inputSchema: commandSchema,
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      },
      async ({ command, cwd, access, timeoutMs, bindingRef }) => typedToolResponse(async () => {
        if (inFlight >= maxConcurrent) {
          const error = new Error(`bridge concurrency limit reached (${maxConcurrent})`);
          error.code = "BRIDGE_CONCURRENCY_LIMIT";
          error.category = "transient";
          error.retryable = true;
          error.nextActions = ["Retry after the active command finishes or use command_start for long-running work."];
          throw error;
        }
        inFlight += 1;
        try {
          const scoped = bindingRef ? continuityState.assertCwd(bindingRef, cwd) : null;
          const result = await executor.exec({ command, cwd: scoped?.targetCwd ?? cwd, access, timeoutMs });
          if (bindingRef) continuityState.record(bindingRef, { kind: "command", label: summarizeRedactedArgv(command), cwd: result.effectiveCwd, status: result.exitCode === 0 ? "ok" : "failed", exitCode: result.exitCode });
          const payload = { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, access, surfaceVersion: PUBLIC_SURFACE_VERSION, modelTurnStarted: false };
          if (typeof result.stdoutTruncated === "boolean") payload.stdoutTruncated = result.stdoutTruncated;
          if (typeof result.stderrTruncated === "boolean") payload.stderrTruncated = result.stderrTruncated;
          if (typeof result.permissionCeiling === "string") payload.permissionCeiling = result.permissionCeiling;
          if (typeof result.permissionProfile === "string") payload.permissionProfile = result.permissionProfile;
          if (typeof result.effectiveCwd === "string") payload.cwd = result.effectiveCwd;
          if (typeof result.authoritySource === "string") payload.authoritySource = result.authoritySource;
          if (typeof result.trustedAncestor === "string") payload.trustedAncestor = result.trustedAncestor;
          if (bindingRef) payload.continuityJournaled = true;
          return payload;
        } finally { inFlight -= 1; }
      }, { operation: "command_exec", isError: (payload) => payload?.exitCode !== 0 })
    );

    registerWorkspaceTools(server, { store: stateStore, authorityExecutor, publicContext });
    registerCommandTools(server, { commandManager });
    registerPublicContextTools(server, publicContext);
    registerThreadHistoryTools(server, { context: publicContext, authorityExecutor, continuityState, stateStore });
    registerConstructionTools(server, { authorityExecutor, continuityState, stateStore });
    registerRepoTools(server, { authorityExecutor, continuityState });
    registerBrowserReaderTools(server, browserReader);
    return server;
  };
}
