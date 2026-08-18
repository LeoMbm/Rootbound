import { createRequire } from "node:module";
import { registerAgentPreviewTools } from "./agent-tools.mjs";
import { registerBrowserReaderTools } from "./browser-reader-tools.mjs";
import { registerConstructionTools } from "./construction-tools.mjs";
import { registerPublicContextTools } from "./public-context-tools.mjs";
import { registerThreadHistoryTools } from "./thread-history-tools.mjs";
import { PUBLIC_SERVER_VERSION, PUBLIC_SURFACE_VERSION } from "./surface-contracts.mjs";

const require = createRequire(import.meta.url);
const { McpServer } = require("@modelcontextprotocol/server");
const z = require("zod/v4");
const bindingRefSchema = z.string().regex(/^binding_[0-9a-f-]{36}$/i).optional();

export function createPublicServerFactory({
  executor,
  authorityExecutor,
  publicContext,
  browserReader,
  agentExecutor,
  continuityState,
  meteredConsentMode = "off",
  meteredQuotaProvider = null,
  agentPreviewState = null,
  maxConcurrent = 1,
}) {
  if (!executor) throw new Error("Codexless public server requires an authority executor");
  if (!authorityExecutor) throw new Error("Codexless public server requires authorityExecutor");
  if (!publicContext) throw new Error("Codexless public server requires publicContext");
  if (!browserReader) throw new Error("Codexless public server requires browserReader");
  if (!agentExecutor) throw new Error("Codexless public server requires agentExecutor");
  if (!continuityState) throw new Error("Codexless public server requires continuityState");
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 4) {
    throw new Error("maxConcurrent must be an integer between 1 and 4");
  }

  const commandSchema = z.object({
    command: z.array(z.string().max(32_768)).min(1).max(128)
      .describe("argv vector passed to official Codex command/exec under the locally resolved Codex permission profile"),
    cwd: z.string().min(1).max(32_768).optional()
      .describe("Optional local working-directory context. cwd does not let the caller select or widen a permission profile."),
    access: z.enum(["inherit", "readOnly"]).default("readOnly")
      .describe("readOnly is the safe compatibility default. inherit uses the locally authorized/resolved Codex permission profile."),
    timeoutMs: z.number().int().positive().max(30_000).default(10_000),
    bindingRef: bindingRefSchema.describe("Optional opaque continuity binding. When supplied, Codexless journals this command's metadata for the next delta checkpoint."),
  }).strict();

  return function createServer() {
    let inFlight = 0;
    const server = new McpServer(
      {
        name: "codexless",
        title: "Codexless",
        version: PUBLIC_SERVER_VERSION,
        description: "Local bridge that lets ChatGPT use accepted Codex-backed capabilities and explicitly escalate to Codex when needed.",
      },
      {
        instructions:
          "Codexless Public Technical Preview. Public surface includes authority-bounded project construction, Codex project context and Skills, authorized persisted thread continuity, read-only Browser Reader, and explicit metered Codex Agent delegation. For a long-running ChatGPT↔Codex workflow, bind the intended Codex thread once with codex.continuity_bind, retain the returned bindingRef in this chat, pass it to supported project actions, and call codex.continuity_checkpoint before every final response that materially advances or changes the bound project. Checkpoints are delta handoffs: include only newly learned decisions/current state; Codexless appends observed local command/edit metadata automatically. Do not checkpoint unrelated conversation. Raw reasoning is not exposed. Browser click/fill, Computer Use, generic MCP calls/catalogs, raw host filesystem/process Workbench controls, and private capabilities are not part of this package. Remote callers cannot widen Codex permission profiles, sandbox, approval policy, trusted roots, or network authority. Model-free work and metered Codex Agent work remain separate lanes.",
      }
    );

    server.registerTool(
      "codex.command_exec",
      {
        title: "Codex Model-Free Command",
        description:
          "Run one buffered argv command through official Codex App Server command/exec without a Codex model turn. Codexless resolves the authorized Codex permission profile locally; the caller cannot select a stronger profile or permission envelope. This model-free lane must not launch Codex CLI directly or through recognized shell/interpreter wrappers. If bindingRef is supplied, only bounded command metadata (not stdout/stderr) is recorded for the next continuity checkpoint.",
        inputSchema: commandSchema,
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      },
      async ({ command, cwd, access, timeoutMs, bindingRef }) => {
        if (inFlight >= maxConcurrent) return toolError(`bridge concurrency limit reached (${maxConcurrent})`);
        inFlight += 1;
        try {
          const result = await executor.exec({ command, cwd, access, timeoutMs });
          if (bindingRef) {
            continuityState.record(bindingRef, {
              kind: "command",
              label: summarizeArgv(command),
              cwd: result.effectiveCwd,
              status: result.exitCode === 0 ? "ok" : "failed",
              exitCode: result.exitCode,
            });
          }
          const payload = {
            exitCode: result.exitCode,
            stdout: result.stdout,
            stderr: result.stderr,
            access,
            surfaceVersion: PUBLIC_SURFACE_VERSION,
          };
          if (typeof result.stdoutTruncated === "boolean") payload.stdoutTruncated = result.stdoutTruncated;
          if (typeof result.stderrTruncated === "boolean") payload.stderrTruncated = result.stderrTruncated;
          if (typeof result.permissionCeiling === "string") payload.permissionCeiling = result.permissionCeiling;
          if (typeof result.permissionProfile === "string") payload.permissionProfile = result.permissionProfile;
          if (typeof result.effectiveCwd === "string") payload.cwd = result.effectiveCwd;
          if (typeof result.authoritySource === "string") payload.authoritySource = result.authoritySource;
          if (typeof result.trustedAncestor === "string") payload.trustedAncestor = result.trustedAncestor;
          if (result.executableResolution && typeof result.executableResolution === "object") payload.executableResolution = result.executableResolution;
          if (typeof result.resolutionSource === "string") payload.resolutionSource = result.resolutionSource;
          if (bindingRef) payload.continuityJournaled = true;
          return {
            content: [{ type: "text", text: JSON.stringify(payload) }],
            structuredContent: payload,
            isError: result.exitCode !== 0,
          };
        } catch (error) {
          return toolError(
            error instanceof Error ? error.message : String(error),
            error && typeof error === "object" ? { errorCode: error.code, nextActions: error.nextActions } : undefined
          );
        } finally {
          inFlight -= 1;
        }
      }
    );

    registerPublicContextTools(server, publicContext);
    registerThreadHistoryTools(server, { context: publicContext, authorityExecutor, continuityState });
    registerConstructionTools(server, { authorityExecutor, continuityState });
    registerBrowserReaderTools(server, browserReader);
    registerAgentPreviewTools(server, {
      agentExecutor,
      authorityExecutor,
      meteredConsentMode,
      meteredQuotaProvider,
      agentPreviewState,
    });
    return server;
  };
}

function summarizeArgv(command) {
  const joined = command.join(" ").replace(/\s+/g, " ").trim();
  return joined.length > 512 ? joined.slice(0, 509) + "..." : joined;
}

function toolError(message, details = {}) {
  const structuredContent = { error: message };
  if (typeof details?.errorCode === "string") structuredContent.errorCode = details.errorCode;
  if (Array.isArray(details?.nextActions) && details.nextActions.every((value) => typeof value === "string")) {
    structuredContent.nextActions = details.nextActions;
  }
  return {
    content: [{ type: "text", text: message }],
    structuredContent,
    isError: true,
  };
}
