import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const z = require("zod/v4");

const cwdSchema = z.string().min(1).max(32_768).optional();
const cursorSchema = z.string().min(1).max(32_768).optional();
const threadIdSchema = z.string().min(1).max(4_096);
const lineSchema = z.string().min(1).max(8_192);

export function registerThreadHistoryTools(server, { context, authorityExecutor }) {
  if (!context || !authorityExecutor) return;

  server.registerTool(
    "codex.thread_list",
    {
      title: "List Authorized Codex Conversations",
      description:
        "List stored Codex threads for one locally authorized project without starting a Codex model turn. The project cwd is resolved through the existing Codex trust/permission authority before history is returned. Results are paginated and intentionally omit rollout file paths and credentials.",
      inputSchema: z.object({
        cwd: cwdSchema,
        cursor: cursorSchema,
        limit: z.number().int().min(1).max(50).default(20),
        sortKey: z.enum(["created_at", "updated_at"]).default("updated_at"),
        sortDirection: z.enum(["asc", "desc"]).default("desc"),
        archived: z.boolean().default(false),
        searchTerm: z.string().max(1_024).optional(),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (input) => structured(async () => {
      const authority = await authorityExecutor.resolveAuthority({ cwd: input.cwd, access: "readOnly" });
      const result = await context.threadList({ ...input, cwd: authority.effectiveCwd });
      return withAuthority(result, authority);
    })
  );

  server.registerTool(
    "codex.thread_read",
    {
      title: "Read Authorized Codex Conversation",
      description:
        "Read metadata plus a bounded page of recent persisted Codex turns without resuming the conversation or starting a model turn. The thread's own cwd must still be covered by an explicitly trusted Codex project/root. Reasoning summaries may be returned, but raw reasoning content is always omitted.",
      inputSchema: z.object({
        threadId: threadIdSchema,
        cursor: cursorSchema,
        limit: z.number().int().min(1).max(50).default(12),
        sortDirection: z.enum(["asc", "desc"]).default("desc"),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (input) => structured(async () => {
      const metadata = await context.threadMetadata({ threadId: input.threadId });
      const authority = await authorizeThread(authorityExecutor, metadata.thread);
      const result = await context.threadRead({ ...input, metadata });
      return withAuthority(result, authority);
    })
  );

  server.registerTool(
    "codex.thread_items",
    {
      title: "Read Authorized Codex Conversation Items",
      description:
        "Page persisted items from an authorized Codex conversation, optionally restricted to one turn. This is the drill-down path for user/agent messages, plans, commands, file changes and other persisted activity. Raw reasoning content is never returned; only reasoning summaries are projected.",
      inputSchema: z.object({
        threadId: threadIdSchema,
        turnId: z.string().min(1).max(4_096).optional(),
        cursor: cursorSchema,
        limit: z.number().int().min(1).max(100).default(50),
        sortDirection: z.enum(["asc", "desc"]).default("asc"),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (input) => structured(async () => {
      const metadata = await context.threadMetadata({ threadId: input.threadId });
      const authority = await authorizeThread(authorityExecutor, metadata.thread);
      const result = await context.threadItems({ ...input, metadata });
      return withAuthority(result, authority);
    })
  );

  server.registerTool(
    "codex.continuity_push",
    {
      title: "Push ChatGPT Continuity Back To Codex",
      description:
        "Persist one explicitly targeted external handoff into an authorized Codex thread using official thread/inject_items. This does not start a Codex model turn or consume Codex model quota, but it does modify the thread's future model-visible history. The injected message is clearly labeled as external ChatGPT/Codexless continuity rather than a prior Codex conclusion.",
      inputSchema: z.object({
        threadId: threadIdSchema,
        summary: z.string().min(1).max(30_000),
        changedFiles: z.array(lineSchema).max(100).default([]),
        tests: z.array(lineSchema).max(100).default([]),
        decisions: z.array(lineSchema).max(100).default([]),
        remainingWork: z.array(lineSchema).max(100).default([]),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async (input) => structured(async () => {
      const metadata = await context.threadMetadata({ threadId: input.threadId });
      const authority = await authorizeThread(authorityExecutor, metadata.thread);
      const text = buildContinuityHandoff(input);
      const result = await context.injectContinuity({ threadId: input.threadId, text });
      return withAuthority({
        ...result,
        injectedChars: text.length,
        externalSource: "ChatGPT via Codexless",
      }, authority);
    })
  );
}

export function buildContinuityHandoff({ summary, changedFiles = [], tests = [], decisions = [], remainingWork = [] }) {
  const sections = [
    "[External continuity update from ChatGPT via Codexless]",
    "",
    "This is a handoff record from an external ChatGPT session. It is not a previous Codex-generated conclusion.",
    "",
    "Work completed / current state:",
    summary.trim(),
  ];
  appendList(sections, "Changed files:", changedFiles);
  appendList(sections, "Tests / verification:", tests);
  appendList(sections, "Decisions and constraints:", decisions);
  appendList(sections, "Remaining work:", remainingWork);
  return sections.join("\n").trimEnd() + "\n";
}

async function authorizeThread(authorityExecutor, thread) {
  const cwd = thread?.cwd;
  if (typeof cwd !== "string" || !cwd.trim()) {
    throw new Error("stored Codex thread has no cwd; Codexless refuses to expose or mutate history without a project authority root");
  }
  return authorityExecutor.resolveAuthority({ cwd, access: "readOnly" });
}

function withAuthority(payload, authority) {
  return {
    ...payload,
    authority: {
      cwd: authority.effectiveCwd,
      trustedAncestor: authority.trustedAncestor,
      permissionProfile: authority.permissionProfile,
      permissionCeiling: authority.permissionCeiling,
      source: authority.authoritySource,
    },
  };
}

function appendList(target, title, values) {
  if (!values.length) return;
  target.push("", title, ...values.map((value) => `- ${String(value).trim()}`));
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
