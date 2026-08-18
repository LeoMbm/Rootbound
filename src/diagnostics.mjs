import os from "node:os";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { runtimeStatus, tailLog } from "./runtime-state.mjs";
import { PUBLIC_SERVER_VERSION, PUBLIC_SURFACE_VERSION, PUBLIC_TOOL_NAMES } from "./surface-contracts.mjs";

export async function buildDiagnosticSnapshot({ store, packageRoot, maxEvents = 200, maxLogBytes = 64 * 1024 } = {}) {
  if (!store || !packageRoot) throw new Error("diagnostic snapshot requires store and packageRoot");
  const pkg = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
  const runtime = await runtimeStatus(store.paths);
  const projects = store.listProjects().map((project) => ({
    projectRef: project.projectRef,
    name: project.name,
    root: redactText(project.root),
    gitRoot: project.gitRoot ? redactText(project.gitRoot) : null,
    trusted: project.trusted,
    updatedAt: project.updatedAt,
    lastConnectedAt: project.lastConnectedAt,
  }));
  const bindings = store.listBindings().slice(0, 100).map((binding) => ({
    bindingRef: binding.bindingRef,
    projectRef: binding.projectRef,
    threadId: redactIdentifier(binding.threadId),
    createdAt: binding.createdAt,
    touchedAt: binding.touchedAt,
    checkpointCount: binding.checkpointCount,
    lastCheckpointAt: binding.lastCheckpointAt,
    lastAckSeq: binding.lastAckSeq,
  }));
  const rows = store.db.prepare("SELECT event_id, project_ref, binding_ref, kind, payload_json, created_at FROM events ORDER BY event_id DESC LIMIT ?").all(maxEvents);
  const events = rows.reverse().map((row) => {
    let payload = {};
    try { payload = JSON.parse(row.payload_json); } catch {}
    const correlationId = typeof payload.commandId === "string" ? payload.commandId : row.binding_ref ?? row.project_ref ?? `event_${row.event_id}`;
    return {
      eventId: Number(row.event_id),
      correlationId,
      projectRef: row.project_ref,
      bindingRef: row.binding_ref,
      kind: row.kind,
      payload: redactValue(payload),
      createdAt: Number(row.created_at),
    };
  });
  const logText = await tailLog(store.paths.logPath, { maxBytes: maxLogBytes });

  return {
    schemaVersion: 1,
    generatedAt: Date.now(),
    codexless: {
      packageVersion: pkg.version,
      serverVersion: PUBLIC_SERVER_VERSION,
      surfaceVersion: PUBLIC_SURFACE_VERSION,
      publicToolCount: PUBLIC_TOOL_NAMES.length,
      modelLane: "chatgpt-only",
    },
    host: { platform: process.platform, arch: process.arch, node: process.version },
    runtime: redactValue(runtime),
    projects,
    bindings,
    events,
    logs: redactText(logText),
    privacy: {
      stdoutIncluded: false,
      stderrIncluded: false,
      threadPreviewIncluded: false,
      homePathsRedacted: true,
      credentialPatternsRedacted: true,
    },
  };
}

export function redactValue(value) {
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    if (/token|secret|password|authorization|cookie|api[_-]?key/i.test(key)) out[key] = "<redacted>";
    else out[key] = redactValue(child);
  }
  return out;
}

export function redactText(value, { home = os.homedir() } = {}) {
  let text = String(value ?? "");
  if (home) text = replaceAllPortable(text, home, "~");
  text = text
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]{8,}=*/gi, "Bearer <redacted>")
    .replace(/([?&](?:token|key|api_key|apikey|auth|authorization|sig|signature|secret|password)=)[^&\s"']+/gi, "$1<redacted>")
    .replace(/\b(token|api[_-]?key|apikey|auth|authorization|secret|password)\s*=\s*[^\s,;"']+/gi, "$1=<redacted>")
    .replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{12,}\b/g, "<redacted-key>");
  return text;
}

function redactIdentifier(value) {
  const text = String(value ?? "");
  if (text.length <= 8) return "<redacted-id>";
  return `${text.slice(0, 4)}…${text.slice(-4)}`;
}

function replaceAllPortable(text, needle, replacement) {
  if (!needle) return text;
  const variants = new Set([needle, needle.replaceAll("\\", "/"), needle.replaceAll("/", "\\")]);
  let output = text;
  for (const variant of variants) output = output.split(variant).join(replacement);
  return output;
}
