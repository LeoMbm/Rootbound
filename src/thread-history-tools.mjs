import { createRequire } from "node:module";
import { createContinuityIdempotency } from "./continuity-idempotency.mjs";
import { RootboundToolError, typedToolResponse } from "./tool-errors.mjs";

const require = createRequire(import.meta.url);
const z = require("zod/v4");

const cwdSchema = z.string().min(1).max(32_768).optional();
const cursorSchema = z.string().min(1).max(32_768).optional();
const threadIdSchema = z.string().min(1).max(4_096);
const bindingRefSchema = z.string().regex(/^binding_[0-9a-f-]{36}$/i);
const lineSchema = z.string().min(1).max(8_192);
const idempotencyKeySchema = z.string().min(8).max(256).regex(/^[A-Za-z0-9._:-]+$/).optional();

export function registerThreadHistoryTools(server, { context, authorityExecutor, continuityState, stateStore = null }) {
  if (!context || !authorityExecutor || !continuityState) return;
  const idempotency = stateStore ? createContinuityIdempotency({ store: stateStore }) : null;

  server.registerTool(
    "codex.thread_list",
    {
      title: "List Authorized Codex Conversations",
      description: "List stored Codex threads for one locally authorized project without starting a Codex model turn. Results are paginated and intentionally omit rollout file paths and credentials.",
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
    async (input) => typedToolResponse(async () => {
      const authority = await authorityExecutor.resolveAuthority({ cwd: input.cwd, access: "readOnly" });
      const result = await context.threadList({ ...input, cwd: authority.effectiveCwd });
      return withAuthority(result, authority);
    }, { operation: "thread_list" })
  );

  server.registerTool(
    "codex.thread_read",
    {
      title: "Read Authorized Codex Conversation",
      description: "Read metadata plus a bounded page of recent persisted Codex turns without resuming the conversation or starting a model turn. Raw reasoning content is always omitted.",
      inputSchema: z.object({
        threadId: threadIdSchema,
        cursor: cursorSchema,
        limit: z.number().int().min(1).max(50).default(12),
        sortDirection: z.enum(["asc", "desc"]).default("desc"),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (input) => typedToolResponse(async () => {
      const metadata = await context.threadMetadata({ threadId: input.threadId });
      const authority = await authorizeThread(authorityExecutor, metadata.thread);
      const result = await context.threadRead({ ...input, metadata });
      return withAuthority(result, authority);
    }, { operation: "thread_read" })
  );

  server.registerTool(
    "codex.thread_items",
    {
      title: "Read Authorized Codex Conversation Items",
      description: "Page persisted items from an authorized Codex conversation, optionally restricted to one turn. Raw reasoning content is never returned; only reasoning summaries are projected.",
      inputSchema: z.object({
        threadId: threadIdSchema,
        turnId: z.string().min(1).max(4_096).optional(),
        cursor: cursorSchema,
        limit: z.number().int().min(1).max(100).default(50),
        sortDirection: z.enum(["asc", "desc"]).default("asc"),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (input) => typedToolResponse(async () => {
      const metadata = await context.threadMetadata({ threadId: input.threadId });
      const authority = await authorizeThread(authorityExecutor, metadata.thread);
      const result = await context.threadItems({ ...input, metadata });
      return withAuthority(result, authority);
    }, { operation: "thread_items" })
  );

  server.registerTool(
    "codex.continuity_bind",
    {
      title: "Bind This Chat To A Codex Conversation",
      description: "Bind the current ChatGPT workflow to one authorized persisted Codex thread. An optional idempotencyKey makes network retries return the same bindingRef rather than creating duplicate bindings. Binding is model-free and does not modify the Codex thread.",
      inputSchema: z.object({ threadId: threadIdSchema, idempotencyKey: idempotencyKeySchema }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ threadId, idempotencyKey }) => typedToolResponse(async () => {
      const metadata = await context.threadMetadata({ threadId });
      if (metadata.thread?.ephemeral === true) {
        throw new RootboundToolError("Continuity can bind only to a persisted Codex thread; ephemeral project-context threads cannot accept checkpoints.", {
          code: "CONTINUITY_THREAD_EPHEMERAL",
          category: "input",
          retryable: false,
          nextActions: ["Choose a persisted thread returned by codex.thread_list, then bind that threadId."],
        });
      }
      const authority = await authorizeThread(authorityExecutor, metadata.thread);
      const request = { threadId, cwd: authority.effectiveCwd };
      const idem = beginIdempotency(idempotency, { operation: "bind", key: idempotencyKey, request });
      if (idem.mode === "replay") {
        const replay = idem.result;
        try { continuityState.status(replay.bindingRef); }
        catch {
          throw new RootboundToolError("The binding saved for this idempotencyKey has expired or was removed.", {
            code: "IDEMPOTENCY_RESULT_EXPIRED",
            category: "state",
            retryable: false,
            nextActions: ["Bind again using a new idempotencyKey."],
          });
        }
        return { ...replay, idempotencyReplayed: true };
      }
      try {
        const binding = continuityState.bind({ threadId, cwd: authority.effectiveCwd, threadPreview: metadata.thread?.preview ?? null });
        const result = withAuthority({ status: "bound", ...binding, ...(idempotencyKey ? { idempotencyKey } : {}) }, authority);
        idempotency?.complete({ operation: "bind", key: idempotencyKey, requestHash: idem.requestHash, bindingRef: binding.bindingRef, result });
        return result;
      } catch (error) {
        if (idem.mode === "started") idempotency?.cancelPending({ operation: "bind", key: idempotencyKey, requestHash: idem.requestHash });
        throw error;
      }
    }, { operation: "continuity_bind" })
  );

  server.registerTool(
    "codex.continuity_status",
    {
      title: "Read Codex Continuity Binding Status",
      description: "Read the current state of one opaque continuity binding, including pending local journal entries and checkpoint count. This does not read or modify the Codex thread.",
      inputSchema: z.object({ bindingRef: bindingRefSchema }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ bindingRef }) => typedToolResponse(() => ({ status: "bound", ...continuityState.status(bindingRef) }), { operation: "continuity_status" })
  );

  server.registerTool(
    "codex.continuity_checkpoint",
    {
      title: "Checkpoint ChatGPT Continuity Into Codex",
      description: "Write one delta checkpoint into the Codex thread bound by bindingRef without starting a model turn. Supply idempotencyKey for retry-safe delivery: completed retries replay the saved result; ambiguous pending writes fail closed instead of injecting twice.",
      inputSchema: z.object({
        bindingRef: bindingRefSchema,
        summary: z.string().min(1).max(30_000),
        decisions: z.array(lineSchema).max(100).default([]),
        remainingWork: z.array(lineSchema).max(100).default([]),
        idempotencyKey: idempotencyKeySchema,
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async (input) => typedToolResponse(async () => {
      const pending = continuityState.prepareCheckpoint(input.bindingRef);
      const metadata = await context.threadMetadata({ threadId: pending.threadId });
      const authority = await authorizeThread(authorityExecutor, metadata.thread);
      if (authority.effectiveCwd !== pending.cwd) {
        throw new RootboundToolError("continuity binding cwd no longer matches the authorized Codex thread cwd; bind again", {
          code: "CONTINUITY_AUTHORITY_CHANGED",
          category: "permission",
          retryable: false,
          nextActions: ["Create a fresh continuity binding for the currently authorized thread cwd."],
        });
      }
      const text = buildContinuityCheckpoint({
        summary: input.summary,
        decisions: input.decisions,
        remainingWork: input.remainingWork,
        journal: pending.journal,
      });
      const request = {
        bindingRef: input.bindingRef,
        summary: input.summary,
        decisions: input.decisions,
        remainingWork: input.remainingWork,
      };
      const idem = beginIdempotency(idempotency, { operation: "checkpoint", key: input.idempotencyKey, request, bindingRef: input.bindingRef });
      if (idem.mode === "replay") return { ...idem.result, idempotencyReplayed: true };

      // From this point on, failures are deliberately left pending because the external write may have reached Codex.
      const injected = await context.injectContinuity({ threadId: pending.threadId, text });
      const binding = continuityState.acknowledgeCheckpoint(input.bindingRef, pending.throughSeq);
      const result = withAuthority({
        ...injected,
        status: "checkpointed",
        binding,
        journalEntriesIncluded: pending.journal.length,
        injectedChars: text.length,
        externalSource: "ChatGPT via Rootbound",
        ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      }, authority);
      idempotency?.complete({ operation: "checkpoint", key: input.idempotencyKey, requestHash: idem.requestHash, bindingRef: input.bindingRef, result });
      return result;
    }, { operation: "continuity_checkpoint" })
  );

  server.registerTool(
    "codex.continuity_unbind",
    {
      title: "Unbind This Chat From Codex",
      description: "Remove one continuity binding from Rootbound. This does not delete, archive, roll back, or otherwise modify the Codex conversation itself.",
      inputSchema: z.object({ bindingRef: bindingRefSchema }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ bindingRef }) => typedToolResponse(() => continuityState.unbind(bindingRef), { operation: "continuity_unbind" })
  );
}

export function buildContinuityCheckpoint({ summary, decisions = [], remainingWork = [], journal = [] }) {
  const sections = [
    "[External continuity checkpoint from ChatGPT via Rootbound]",
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

function beginIdempotency(idempotency, input) {
  if (!input.key) return { mode: "disabled", requestHash: null };
  if (!idempotency) {
    throw new RootboundToolError("Continuity idempotency storage is unavailable in this runtime.", {
      code: "IDEMPOTENCY_STORAGE_UNAVAILABLE",
      category: "state",
      retryable: false,
    });
  }
  return idempotency.begin(input);
}

async function authorizeThread(authorityExecutor, thread) {
  const cwd = thread?.cwd;
  if (typeof cwd !== "string" || !cwd.trim()) {
    throw new RootboundToolError("stored Codex thread has no cwd; Rootbound refuses to expose or mutate history without a project authority root", {
      code: "THREAD_CWD_MISSING",
      category: "state",
      retryable: false,
    });
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
