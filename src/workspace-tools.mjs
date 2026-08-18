import { createRequire } from "node:module";
import { registerProject, resolveProjectRoot } from "./project-registry.mjs";

const require = createRequire(import.meta.url);
const z = require("zod/v4");

export function registerWorkspaceTools(server, { store, authorityExecutor, publicContext }) {
  if (!store || !authorityExecutor || !publicContext) return;

  server.registerTool(
    "codex.workspace_open",
    {
      title: "Open Codexless Workspace",
      description: "Resolve one local workspace to its canonical real/Git root and durable projectRef, inspect exact-root Codex authority read-only, and return reusable project context. This never creates or widens Codex trust; an unauthorized workspace returns needs_trust with explicit next actions.",
      inputSchema: z.object({ cwd: z.string().min(1).max(32_768).optional() }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ cwd }) => structured(() => openWorkspace({ cwd, store, authorityExecutor, publicContext }))
  );
}

export async function openWorkspace({ cwd = null, store, authorityExecutor, publicContext }) {
  if (!store || !authorityExecutor || !publicContext) throw new Error("workspace_open requires store, authorityExecutor, and publicContext");
  const requested = cwd ?? authorityExecutor.defaultCwd ?? process.cwd();
  const resolved = await resolveProjectRoot(requested);
  let project = store.getProjectByRoot(resolved.root);
  if (!project) project = await registerProject(store, resolved.root, { trusted: false });

  let authority = null;
  try {
    authority = await authorityExecutor.resolveAuthority({ cwd: resolved.root, access: "readOnly", timeoutMs: 10_000 });
  } catch (error) {
    if (error?.code !== "PERMISSION_APPROVAL_REQUIRED") throw error;
    return {
      status: "needs_trust",
      project: { ...project, root: resolved.root, gitRoot: resolved.gitRoot },
      authority: null,
      modelTurnStarted: false,
      errorCode: error.code,
      nextActions: Array.isArray(error.nextActions) ? error.nextActions : ["Authorize the exact workspace root, then retry workspace_open."],
    };
  }

  project = await registerProject(store, resolved.root, { trusted: true });
  const context = await publicContext.projectContext({ cwd: resolved.root });
  return {
    status: "ready",
    project: { ...project, root: resolved.root, gitRoot: resolved.gitRoot },
    authority: {
      permissionProfile: authority.permissionProfile,
      permissionCeiling: authority.permissionCeiling,
      authoritySource: authority.authoritySource,
      trustedAncestor: authority.trustedAncestor,
    },
    context,
    modelTurnStarted: false,
  };
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
