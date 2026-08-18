import { createRequire } from "node:module";
import { typedToolResponse } from "./tool-errors.mjs";

const require = createRequire(import.meta.url);
const z = require("zod/v4");
const commandId = z.string().regex(/^command_[0-9a-f-]{36}$/i);
const bindingRef = z.string().regex(/^binding_[0-9a-f-]{36}$/i).optional();

export function registerCommandTools(server, { commandManager }) {
  if (!commandManager) return;

  server.registerTool("codex.command_start", {
    title: "Start Long Command",
    description: "Start a long-running authorized project command without starting a Codex model turn. On supported platforms output is streamed incrementally and the returned commandId can be polled, written to, or terminated.",
    inputSchema: z.object({
      command: z.array(z.string().max(32_768)).min(1).max(256),
      cwd: z.string().min(1).max(32_768).optional(),
      bindingRef,
      access: z.enum(["inherit", "readOnly"]).default("inherit"),
      timeoutMs: z.number().int().min(1_000).max(1_800_000).default(600_000),
      tty: z.boolean().default(false),
    }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, async (args) => typedToolResponse(async () => ({ ...await commandManager.start(args), modelTurnStarted: false }), { operation: "command_start" }));

  server.registerTool("codex.command_poll", {
    title: "Poll Long Command",
    description: "Poll durable long-command state and incremental stdout/stderr chunks after a cursor. Returns nextCursor so callers do not need to re-read previous output.",
    inputSchema: z.object({ commandId, cursor: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(500).default(100) }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ commandId, cursor, limit }) => typedToolResponse(() => ({ ...commandManager.poll(commandId, { cursor, limit }), modelTurnStarted: false }), { operation: "command_poll" }));

  server.registerTool("codex.command_write", {
    title: "Write Long Command Stdin",
    description: "Write UTF-8 stdin to an active streaming command and optionally close stdin. This is model-free and fails explicitly on platforms where the accepted Codex command streaming implementation cannot support stdin.",
    inputSchema: z.object({ commandId, data: z.string().max(262_144).default(""), closeStdin: z.boolean().default(false) }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, async ({ commandId, data, closeStdin }) => typedToolResponse(async () => ({ ...await commandManager.write(commandId, { data, closeStdin }), modelTurnStarted: false }), { operation: "command_write" }));

  server.registerTool("codex.command_terminate", {
    title: "Terminate Long Command",
    description: "Terminate an active long-running command using the accepted Codex App Server terminate primitive when supported. Does not start a Codex model turn.",
    inputSchema: z.object({ commandId }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async ({ commandId }) => typedToolResponse(async () => ({ ...await commandManager.terminate(commandId), modelTurnStarted: false }), { operation: "command_terminate" }));
}
