import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const z = require("zod/v4");
const commandId = z.string().regex(/^command_[0-9a-f-]{36}$/i);
const bindingRef = z.string().regex(/^binding_[0-9a-f-]{36}$/i).optional();

export function registerCommandTools(server, { commandManager }) {
  if (!commandManager) return;
  server.registerTool("codex.command_start", {
    title: "Start Long Command",
    description: "Start a long-running command in an authorized project through model-free Codex command/exec and return immediately with a durable commandId.",
    inputSchema: z.object({ command: z.array(z.string().max(32_768)).min(1).max(256), cwd: z.string().min(1).max(32_768).optional(), bindingRef, access: z.enum(["inherit", "readOnly"]).default("inherit"), timeoutMs: z.number().int().min(1_000).max(1_800_000).default(600_000) }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, async (args) => structured(() => ({ ...commandManager.start(args), modelTurnStarted: false })));

  server.registerTool("codex.command_status", {
    title: "Read Long Command Status",
    description: "Read durable status for a previously started Codexless command without starting a model turn.",
    inputSchema: z.object({ commandId }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ commandId }) => structured(() => ({ ...commandManager.status(commandId), modelTurnStarted: false })));

  server.registerTool("codex.command_output", {
    title: "Read Long Command Output",
    description: "Read persisted stdout, stderr, exit status, and errors for a long-running Codexless command without starting a model turn.",
    inputSchema: z.object({ commandId }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ commandId }) => structured(() => ({ ...commandManager.output(commandId), modelTurnStarted: false })));

  server.registerTool("codex.command_stop", {
    title: "Stop Long Command",
    description: "Stop the dedicated worker for a long-running Codexless command. This does not invoke a Codex model.",
    inputSchema: z.object({ commandId, force: z.boolean().default(false) }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async ({ commandId, force }) => structured(() => ({ ...commandManager.stop(commandId, { force }), modelTurnStarted: false })));
}

async function structured(task) {
  try {
    const payload = await task();
    return { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload, isError: payload?.status === "failed" };
  } catch (error) {
    const payload = { error: error instanceof Error ? error.message : String(error) };
    if (typeof error?.code === "string") payload.errorCode = error.code;
    return { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload, isError: true };
  }
}
