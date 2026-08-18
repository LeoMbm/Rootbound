import { createRequire } from "node:module";
import { typedToolResponse } from "./tool-errors.mjs";

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
    async (input) => typedToolResponse(() => context.projectContext(input), { operation: "project_context" })
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
    async (input) => typedToolResponse(() => context.skillList(input), { operation: "skill_list" })
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
    async (input) => typedToolResponse(() => context.skillRead(input), { operation: "skill_read" })
  );
}
