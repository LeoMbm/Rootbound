import { createRequire } from "node:module";
import { registerAgentPreviewTools } from "./agent-tools.mjs";
import { registerBrowserReaderTools } from "./browser-reader-tools.mjs";
import { registerConstructionTools } from "./construction-tools.mjs";
import { registerPublicContextTools } from "./public-context-tools.mjs";
import { PUBLIC_SERVER_VERSION, PUBLIC_SURFACE_VERSION } from "./surface-contracts.mjs";

const require = createRequire(import.meta.url);
const { McpServer } = require("@modelcontextprotocol/server");
const z = require("zod/v4");

export function createPublicServerFactory({
  executor,
  authorityExecutor,
  publicContext,
  browserReader,
  agentExecutor,
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
          "Codexless Public Technical Preview. Public surface is deliberately small: authority-bounded project construction, Codex project context and Skills, read-only Browser Reader, and explicit metered Codex Agent delegation with visible consent/usage state. Browser click/fill, Computer Use, generic MCP calls/catalogs, raw host filesystem/process Workbench controls, and private household capabilities are not part of this package. Remote callers cannot widen Codex permission profiles, sandbox, approval policy, trusted roots, or network authority. Model-free work and metered Codex Agent work are separate lanes.",
      }
    );

    server.registerTool(
      "codex.command_exec",
      {
        title: "Codex Model-Free Command",
        description:
          "Run one buffered argv command through official Codex App Server command/exec without a Codex model turn. Codexless resolves the authorized Codex permission profile locally; the caller cannot select a stronger profile or permission envelope. This model-free lane must not launch Codex CLI directly or through recognized shell/interpreter wrappers; formal metered Codex work must use codex.agent_start / codex.agent_send so Task Card, quota state, and lifecycle remain visible. A bare executable name may be resolved through host PATH on Windows without changing authority.",
        inputSchema: commandSchema,
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      },
      async ({ command, cwd, access, timeoutMs }) => {
        if (inFlight >= maxConcurrent) return toolError(`bridge concurrency limit reached (${maxConcurrent})`);
        inFlight += 1;
        try {
          const result = await executor.exec({ command, cwd, access, timeoutMs });
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
    registerConstructionTools(server, { authorityExecutor });
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
