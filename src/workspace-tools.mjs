import { realpathSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { registerProject, resolveProjectRoot } from "./project-registry.mjs";
import { typedToolResponse } from "./tool-errors.mjs";

const require = createRequire(import.meta.url);
const z = require("zod/v4");

export function registerWorkspaceTools(server, { store, authorityExecutor, publicContext }) {
  if (!store || !authorityExecutor || !publicContext) return;

  server.registerTool(
    "codex.workspace_open",
    {
      title: "Open Rootbound Workspace",
      description: "Resolve one local workspace to its canonical real/Git root and durable projectRef, require exact-root Codex trust for that canonical root, and return reusable read-only project context. This never creates or widens Codex trust; missing or ancestor-only trust returns needs_trust with explicit next actions.",
      inputSchema: z.object({ cwd: z.string().min(1).max(32_768).optional() }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ cwd }) => typedToolResponse(() => openWorkspace({ cwd, store, authorityExecutor, publicContext }), { operation: "workspace_open" })
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
    project = markProjectUntrusted(store, project);
    return needsTrust({
      project,
      resolved,
      errorCode: error.code,
      nextActions: Array.isArray(error.nextActions) ? error.nextActions : ["Authorize the exact workspace root, then retry workspace_open."],
    });
  }

  if (!authority.trustedAncestor || !samePath(authority.trustedAncestor, resolved.root)) {
    project = markProjectUntrusted(store, project);
    return needsTrust({
      project,
      resolved,
      errorCode: "EXACT_ROOT_TRUST_REQUIRED",
      trustedAncestor: authority.trustedAncestor ?? null,
      nextActions: [
        `Trust the canonical workspace root exactly: ${resolved.root}`,
        "Then retry codex.workspace_open.",
      ],
    });
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
      exactRoot: true,
    },
    context,
    modelTurnStarted: false,
  };
}

function needsTrust({ project, resolved, errorCode, trustedAncestor = null, nextActions }) {
  return {
    status: "needs_trust",
    project: { ...project, root: resolved.root, gitRoot: resolved.gitRoot },
    authority: trustedAncestor ? { trustedAncestor, exactRoot: false } : null,
    modelTurnStarted: false,
    errorCode,
    category: "permission",
    retryable: false,
    nextActions,
  };
}

function markProjectUntrusted(store, project) {
  if (!project?.trusted) return project;
  return store.upsertProject({ ...project, trusted: false, updatedAt: Date.now() });
}

function samePath(left, right) {
  const a = canonicalPath(left);
  const b = canonicalPath(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function canonicalPath(value) {
  const resolved = path.resolve(value);
  try { return realpathSync.native(resolved); }
  catch { return resolved; }
}
