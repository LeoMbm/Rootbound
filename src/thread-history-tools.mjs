import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const z = require("zod/v4");

const cwdSchema = z.string().min(1).max(32_768).optional();
const cursorSchema = z.string().min(1).max(32_768).optional();
const threadIdSchema = z.string().min(1).max(4_096);
const bindingRefSchema = z.string().regex(/^binding_[0-9a-f-]{36}$/i);
const lineSchema = z.string().min(1).max(8_192);

export function registerThreadHistoryTools(server, { context, authorityExecutor, continuityState }) {
  if (!context || !authorityExecutor || !continuityState) return;

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
    "codex.continuity_bind",
    {
      title: "Bind This Chat To A Codex Conversation",
      description:
        "Bind the current ChatGPT workflow to one authorized persisted Codex thread. Returns an opaque bindingRef that should be reused for subsequent Codexless project actions and continuity checkpoints in this chat. Binding itself is model-free and does not modify the Codex thread.",
      inputSchema: z.object({ threadId: threadIdSchema }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ threadId }) => structured(async () => {
      const metadata = await context.threadMetadata({ threadId });
      const authority = await authorizeThread(authorityExecutor, metadata.thread);
      const binding = continuityState.bind({
        threadId,
        cwd: authority.effectiveCwd,
        threadPreview: metadata.thread?.preview ?? null,
      });
      return withAuthority({ status: "bound", ...binding }, authority);
    })
  );

  server.registerTool(
    "codex.continuity_status",
    {
      title: "Read Codex Continuity Binding Status",
      description:
        "Read the current state of one opaque continuity binding, including pending local journal entries and checkpoint count. This does not read or modify the Codex thread.",
      inputSchema: z.object({ bindingRef: bindingRefSchema }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ bindingRef }) => structured(() => ({ status: "bound", ...continuityState.status(bindingRef) }))
  );

  server.registerTool(
    "codex.continuity_checkpoint",
    {
      title: "Checkpoint ChatGPT Continuity Into Codex",
      description:
        "Write one delta checkpoint into the Codex thread bound by bindingRef. Include only new project decisions/current state since the prior checkpoint; Codexless automatically appends its pending journal of observed local commands and edits. Uses thread/inject_items and never starts a Codex model turn. When a binding is active, call this before each final response that materially changes or advances the bound project.",
      inputSchema: z.object({
        bindingRef: bindingRefSchema,
        summary: z.string().min(1).max(30_000),
        decisions: z.array(lineSchema).max(100).default([]),
        remainingWork: z.array(lineSchema).max(100).default([]),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async (input) => structured(async () => {
      const pending = continuityState.prepareCheckpoint(input.bindingRef);
      const metadata = await context.threadMetadata({ threadId: pending.threadId });
      const authority = await authorizeThread(authorityExecutor, metadata.thread);
      if (authority.effectiveCwd !== pending.cwd) {
        throw new Error("continuity binding cwd no longer matches the authorized Codex thread cwd; bind again");
      }
      const text = buildContinuityCheckpoint({
        summary: input.summary,
        decisions: input.decisions,
        remainingWork: input.remainingWork,
        journal: pending.journal,
      });
      const result = await context.injectContinuity({ threadId: pending.threadId, text });
      const binding = continuityState.acknowledgeCheckpoint(input.bindingRef, pending.throughSeq);
      return withAuthority({
        ...result,
        status: "checkpointed",
        binding,
        journalEntriesIncluded: pending.journal.length,
        injectedChars: text.length,
        externalSource: "ChatGPT via Codexless",
      }, authority);
    })
  );

  server.registerTool(
    "codex.continuity_unbind",
    {
      title: "Unbind This Chat From Codex",
      description:
        "Remove one continuity binding from Codexless. This does not delete, archive, roll back, or otherwise modify the Codex conversation itself.",
      inputSchema: z.object({ bindingRef: bindingRefSchema }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ bindingRef }) => structured(() => continuityState.unbind(bindingRef))
  );
}

export function buildContinuityCheckpoint({ summary, decisions = [], remainingWork = [], journal = [] }) {
  const sections = [
    "[External continuity checkpoint from ChatGPT via Codexless]",
    "",
    "This is a delta handoff record from an external ChatGPT session. It is not a previous Codex-generated conclusion.",
    "",
    "New project state since the prior checkpoint:",
    summary.trim(),
  ];
  appendList(sections, "New decisions / constraints:", decisions);
  if (journal.length) {
    sections.push("", "Observed local activity:");
    for (const entry of journal) sections.push(`- ${formatJournalEntry(entry)}`);
  }
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

function formatJournalEntry(entry) {
  const pieces = [entry.kind];
  if (entry.label) pieces.push(entry.label);
  if (entry.path) pieces.push(entry.path);
  if (entry.status) pieces.push(`status=${entry.status}`);
  if (entry.exitCode !== undefined) pieces.push(`exit=${entry.exitCode}`);
  if (entry.changed !== undefined) pieces.push(`changed=${entry.changed}`);
  return pieces.join(" · ");
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
