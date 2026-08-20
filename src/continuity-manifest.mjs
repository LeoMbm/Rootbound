import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { publicFingerprint } from "./rescue-continuity.mjs";

const MANIFEST_SCHEMA = "rootbound.continuity.v1";

export function buildContinuityManifest({
  rescue,
  project,
  finalFingerprint,
  commits = [],
  journal = [],
  mutations = [],
  summary,
  decisions = [],
  remainingWork = [],
  quota = null,
  checkpointText = "",
  generatedAt = Date.now(),
} = {}) {
  if (!rescue?.rescueRef || !rescue?.bindingRef || !rescue?.threadId) throw new Error("continuity manifest requires an active rescue identity");
  if (!project?.projectRef || !project?.root) throw new Error("continuity manifest requires project identity");
  if (!finalFingerprint?.fingerprintHash) throw new Error("continuity manifest requires a final worktree fingerprint");

  const payload = {
    schema: MANIFEST_SCHEMA,
    generatedAt,
    source: {
      rescueRef: rescue.rescueRef,
      bindingRef: rescue.bindingRef,
      threadId: rescue.threadId,
      projectRef: project.projectRef,
    },
    verified: {
      baseline: publicFingerprint(rescue.baselineFingerprint),
      result: publicFingerprint(finalFingerprint),
      commits: commits.slice(0, 50).map((entry) => ({ sha: entry?.sha ?? null, subject: bounded(entry?.subject, 500) })),
      mutations: mutations.slice(0, 500).map((mutation) => ({
        operation: bounded(mutation?.operation, 120),
        path: safeRelative(project.root, mutation?.path),
        beforeExists: mutation?.beforeExists === true,
        beforeSha256: mutation?.beforeSha256 ?? null,
        afterExists: mutation?.afterExists === true,
        afterSha256: mutation?.afterSha256 ?? null,
        createdAt: mutation?.createdAt ?? null,
      })),
      activity: journal.slice(0, 200).map(projectActivity),
      checkpointTextSha256: sha256(String(checkpointText ?? "")),
    },
    reported: {
      source: "chatgpt_handoff_input",
      verified: false,
      summary: bounded(summary, 30_000),
      decisions: decisions.slice(0, 100).map((value) => bounded(value, 8_192)),
      remainingWork: remainingWork.slice(0, 100).map((value) => bounded(value, 8_192)),
    },
    safety: {
      externalDriftAtHandoff: false,
      rollbackCoverage: rescue.rollbackCoverage ?? "unknown",
      rollbackReasons: Array.isArray(rescue.rollbackReasons) ? rescue.rollbackReasons.slice(0, 100).map((value) => bounded(value, 1_024)) : [],
    },
    quota: compactQuota(quota),
  };
  const hash = sha256(canonicalJson(payload));
  return {
    ...payload,
    integrity: { algorithm: "sha256", hash },
  };
}

export function verifyContinuityManifest(manifest) {
  if (!manifest || manifest.schema !== MANIFEST_SCHEMA || manifest.integrity?.algorithm !== "sha256" || typeof manifest.integrity?.hash !== "string") {
    return { ok: false, reason: "invalid_manifest_shape", expectedHash: null, actualHash: null };
  }
  const { integrity, ...payload } = manifest;
  const actualHash = sha256(canonicalJson(payload));
  return {
    ok: actualHash === integrity.hash,
    reason: actualHash === integrity.hash ? null : "hash_mismatch",
    expectedHash: integrity.hash,
    actualHash,
  };
}

export function persistContinuityManifest({ store, manifest, projectRef, bindingRef, throughSeq = null, createdAt = Date.now() } = {}) {
  if (!store?.addCheckpoint) throw new Error("persistContinuityManifest requires state store checkpoint support");
  const verification = verifyContinuityManifest(manifest);
  if (!verification.ok) throw new Error(`refusing to persist invalid continuity manifest: ${verification.reason}`);
  const checkpointId = `manifest_${randomUUID()}`;
  store.addCheckpoint({
    checkpointId,
    projectRef,
    bindingRef,
    throughSeq,
    createdAt,
    payload: { kind: "continuity_manifest", manifest },
  });
  return { checkpointId, manifestHash: manifest.integrity.hash };
}

export function manifestInjectionFooter(manifest) {
  const verification = verifyContinuityManifest(manifest);
  if (!verification.ok) throw new Error(`manifest injection footer requires a valid manifest: ${verification.reason}`);
  const hash = manifest.integrity.hash;
  const baseline = manifest.verified?.baseline ?? {};
  const result = manifest.verified?.result ?? {};
  return [
    "",
    "[Rootbound verified continuity manifest]",
    `schema: ${MANIFEST_SCHEMA}`,
    `sha256: ${hash}`,
    `baseline_head: ${baseline.head ?? "unknown"}`,
    `result_head: ${result.head ?? "unknown"}`,
    `result_fingerprint: ${result.fingerprintHash ?? "unknown"}`,
    "The hash covers Rootbound-observed state plus separately-labelled reported handoff fields.",
  ].join("\n");
}

export function canonicalJson(value) {
  return JSON.stringify(sortValue(value));
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortValue(value[key])]));
}

function projectActivity(entry) {
  const source = entry && typeof entry === "object" ? entry : {};
  const output = {};
  for (const key of ["seq", "at", "kind", "label", "path", "cwd", "status", "exitCode", "changed"]) {
    const value = source[key];
    if (value === undefined || value === null) continue;
    output[key] = typeof value === "string" ? bounded(value, 2_048) : value;
  }
  return output;
}

function compactQuota(quota) {
  return {
    observedAt: quota?.observedAt ?? null,
    codexAvailability: quota?.codex?.availability ?? "unknown",
    exhausted: quota?.codex?.exhausted === true,
    resetsAt: quota?.codex?.resetsAt ?? null,
  };
}

function safeRelative(root, candidate) {
  if (typeof candidate !== "string" || !candidate) return null;
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (relative === "" || relative === ".") return ".";
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return "[outside-project]";
  return relative.split(path.sep).join("/");
}

function bounded(value, max) {
  const text = String(value ?? "");
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
