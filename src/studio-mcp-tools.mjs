import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { listWorkspaces, createRuntimeProjectAccessProvider } from "./workspace-tools.mjs";

const require = createRequire(import.meta.url);
const z = require("zod/v4");
export const STUDIO_URI = "ui://rootbound/studio-v1.html";
const MIME = "text/html;profile=mcp-app";
const refSchema = z.string().regex(/^project_[0-9a-f]{20}$/);

function localEndpoint(env) {
  const url = new URL(env.ROOTBOUND_STUDIO_URL || "http://127.0.0.1:3877");
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      url.username || url.password || url.pathname !== "/" || url.search || url.hash)
    throw new Error("ROOTBOUND_STUDIO_URL must be a loopback HTTP origin");
  return url.origin;
}

export async function requestStudio(payload, { env = process.env, fetcher = fetch, readToken = readFileSync } = {}) {
  const tokenPath = env.ROOTBOUND_STUDIO_TOKEN_PATH || join(homedir(), ".rootbound-studio", "mcp-bridge-token");
  let token;
  try { token = readToken(tokenPath, "utf8").trim(); }
  catch { throw new Error("Studio is not running. Start Rootbound Studio locally."); }
  if (!/^[0-9a-f]{64}$/.test(token)) throw new Error("Invalid Studio bridge token");
  const endpoint = localEndpoint(env);
  let response;
  try {
    response = await fetcher(endpoint + "/api/bridge", {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/json", authorization: "Bearer " + token },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(payload.action === "open" ? 25000 : 15000),
    });
  } catch { throw new Error("Cannot contact local Studio. Start pnpm dev, then retry."); }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : "Studio bridge failed");
  return body;
}

const result = (data, summary) => ({
  content: [{ type: "text", text: summary }], structuredContent: data,
});

export function registerStudioMcpTools(server, { store, projectAccessProvider = createRuntimeProjectAccessProvider({ store }), bridge = requestStudio } = {}) {
  const visibleProjects = async () => {
    const listing = await listWorkspaces({ store, projectAccessProvider });
    return listing.workspaces.filter((project) => project.trusted && project.available);
  };
  const projectFor = async (projectRef) => {
    const projects = await visibleProjects();
    const project = projects.find((item) => item.projectRef === projectRef);
    if (!project) throw new Error("Project is not authorized on this Rootbound connection");
    return project;
  };
  const widgetHtml = readFileSync(new URL("./studio-widget.html", import.meta.url), "utf8");
  server.registerResource("Rootbound Studio", STUDIO_URI, { title: "Rootbound Studio", mimeType: MIME },
    async () => ({ contents: [{ uri: STUDIO_URI, mimeType: MIME, text: widgetHtml,
      _meta: { "openai/ui": { availableDisplayModes: ["inline", "fullscreen"] } } }] }));
  server.registerTool("studio.open", {
    title: "Open Rootbound Studio Visual Workspace",
    description: "Open a visual coding workspace inside ChatGPT. ChatGPT reasons, Rootbound executes model-free actions. Requires the local Studio service.",
    inputSchema: z.object({}).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    _meta: { ui: { resourceUri: STUDIO_URI, visibility: ["model", "app"] },
      "openai/outputTemplate": STUDIO_URI, "openai/widgetAccessible": true },
  }, async () => {
    const projects = await visibleProjects();
    return result({ status: "ready", projects: projects.map(({ projectRef, name, root }) => ({ projectRef, name, root })) },
      "Select a project in the Studio widget. All reasoning stays in the ChatGPT conversation.");
  });
  server.registerTool("studio.projects", {
    title: "Studio projects", description: "Connection-authorized project list for Studio widget.",
    inputSchema: z.object({}).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    _meta: { ui: { visibility: ["app"] }, "openai/visibility": "private", "openai/widgetAccessible": true },
  }, async () => {
    const projects = await visibleProjects();
    return result({ projects: projects.map(({ projectRef, name, root }) => ({ projectRef, name, root })) }, "Authorized Studio projects");
  });
  const noteSchema = z.object({ note: z.string().min(1).max(2000), url: z.string().max(2048),
    selector: z.string().max(1024), label: z.string().max(400),
    bounds: z.array(z.number()).length(4), styles: z.record(z.string(), z.string()) }).strict();
  server.registerTool("studio.action", {
    title: "Studio preview and annotations",
    description: "Widget-only visual inspection and notes. Does not start model inference.",
    inputSchema: z.object({ projectRef: refSchema,
      action: z.enum(["activate", "open", "screenshot", "select", "click", "resize", "notes", "addNote", "resolveNotes"]),
      url: z.string().max(2048).optional(),
      x: z.number().min(0).max(10000).optional(), y: z.number().min(0).max(10000).optional(),
      width: z.number().int().optional(), note: noteSchema.optional(),
      ids: z.array(z.string().uuid()).max(100).optional() }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    _meta: { ui: { visibility: ["app"] }, "openai/visibility": "private", "openai/widgetAccessible": true },
  }, async ({ projectRef, ...args }) => {
    const project = await projectFor(projectRef);
    const data = await bridge({ cwd: project.root, ...args });
    return result(data, "Studio " + args.action + " completed for authorized project " + project.name);
  });
}
