import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const z = require("zod/v4");

export function registerPublicContextTools(server, context) {
  if (!context) return;

  server.registerTool(
    "codex.project_context",
    {
      title: "Codex Project Context",
      description:
        "Read a fresh model-free Codex project bootstrap for cwd: workspace roots, effective permission profile, instruction sources, approval policy, sandbox projection, and CLI version. The bootstrap is explicitly downscoped to :read-only so project inspection cannot create or widen Codex trust as a side effect.",
      inputSchema: z.object({ cwd: z.string().min(1).max(32_768).optional() }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (input) => structured(() => context.projectContext(input))
  );

  server.registerTool(
    "codex.skill_list",
    {
      title: "List Current Codex Skills",
      description:
        "List enabled Codex Skills for the current project context. This public tool is intentionally Skills-only; it does not expose Codex plugin, app, model, quota, agent, or generic MCP inventories.",
      inputSchema: z.object({
        cwd: z.string().min(1).max(32_768).optional(),
        query: z.string().max(32_768).default(""),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (input) => structured(() => context.skillList(input))
  );

  server.registerTool(
    "codex.skill_read",
    {
      title: "Read Current Codex Skill",
      description:
        "Resolve one Skill from Codex skills/list for cwd, then read exactly the Skill path returned by Codex. Exact name is preferred; a unique substring is accepted. The caller cannot supply an arbitrary filesystem path through this tool.",
      inputSchema: z.object({
        name: z.string().min(1).max(1024),
        cwd: z.string().min(1).max(32_768).optional(),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (input) => structured(() => context.skillRead(input))
  );
}

async function structured(task) {
  try {
    const payload = await task();
    return { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload, isError: false };
  } catch (error) {
    const payload = { error: error instanceof Error ? error.message : String(error) };
    if (typeof error?.code === "string") payload.errorCode = error.code;
    if (Array.isArray(error?.nextActions)) payload.nextActions = error.nextActions;
    return { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload, isError: true };
  }
}
