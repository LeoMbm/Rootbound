import assert from "node:assert/strict";
import { buildContinuityManifest, canonicalJson, manifestInjectionFooter, persistContinuityManifest, verifyContinuityManifest } from "../src/continuity-manifest.mjs";

const rescue = {
  rescueRef: "rescue_11111111-1111-4111-8111-111111111111",
  bindingRef: "binding_11111111-1111-4111-8111-111111111111",
  threadId: "thread_1",
  rollbackCoverage: "complete",
  rollbackReasons: [],
  baselineFingerprint: {
    root: "/repo",
    head: "aaa",
    branch: "main",
    origin: "git@example/repo",
    dirty: false,
    changes: [],
    degraded: false,
    totalChangedPaths: 0,
    fingerprintHash: "baseline-hash",
  },
};
const project = { projectRef: "project_1", root: "/repo" };
const finalFingerprint = {
  root: "/repo",
  head: "bbb",
  branch: "main",
  origin: "git@example/repo",
  dirty: true,
  changes: ["src/a.js"],
  degraded: false,
  totalChangedPaths: 1,
  fingerprintHash: "result-hash",
};
const common = {
  rescue,
  project,
  finalFingerprint,
  commits: [{ sha: "bbb", subject: "feat: change" }],
  journal: [{ seq: 7, kind: "command", label: "npm test", status: "ok", exitCode: 0, secret: "must-not-project" }],
  mutations: [{
    operation: "precise_edit",
    path: "/repo/src/a.js",
    beforeExists: true,
    beforeSha256: "before",
    beforeText: "SUPER_SECRET_FILE_CONTENT",
    afterExists: true,
    afterSha256: "after",
    createdAt: 10,
  }],
  summary: "Implemented change",
  decisions: ["Keep API stable"],
  remainingWork: ["Run release validation"],
  quota: { observedAt: "2026-08-21T00:00:00.000Z", codex: { availability: "exhausted", exhausted: true, resetsAt: 123 } },
  checkpointText: "checkpoint body",
  generatedAt: 42,
};

const first = buildContinuityManifest(common);
const second = buildContinuityManifest(common);
assert.equal(first.integrity.hash, second.integrity.hash, "fixed inputs must produce deterministic integrity hash");
assert.equal(verifyContinuityManifest(first).ok, true);
assert.equal(first.schema, "rootbound.continuity.v1");
assert.equal(first.reported.verified, false);
assert.equal(first.reported.source, "chatgpt_handoff_input");
assert.equal(first.verified.mutations[0].path, "src/a.js");
assert.equal(Object.hasOwn(first.verified.mutations[0], "beforeText"), false, "manifest must not retain rollback snapshot contents");
assert.equal(canonicalJson({ b: 2, a: 1 }), canonicalJson({ a: 1, b: 2 }));
assert.match(manifestInjectionFooter(first), new RegExp(first.integrity.hash));
assert.equal(JSON.stringify(first).includes("SUPER_SECRET_FILE_CONTENT"), false);
assert.equal(JSON.stringify(first).includes("must-not-project"), false, "journal projection must remain allowlisted");

let persisted = null;
const fakeStore = {
  addCheckpoint(value) { persisted = value; },
};
const saved = persistContinuityManifest({ store: fakeStore, manifest: first, projectRef: project.projectRef, bindingRef: rescue.bindingRef, throughSeq: 7, createdAt: 99 });
assert.match(saved.checkpointId, /^manifest_/);
assert.equal(saved.manifestHash, first.integrity.hash);
assert.equal(persisted.payload.kind, "continuity_manifest");
assert.equal(persisted.payload.manifest.integrity.hash, first.integrity.hash);
assert.equal(persisted.throughSeq, 7);

const tamperedCopy = structuredClone(first);
tamperedCopy.reported.summary = "tampered after signing";
const verification = verifyContinuityManifest(tamperedCopy);
assert.equal(verification.ok, false);
assert.equal(verification.reason, "hash_mismatch");
assert.throws(() => manifestInjectionFooter(tamperedCopy), /valid manifest/);
assert.throws(() => persistContinuityManifest({ store: fakeStore, manifest: tamperedCopy, projectRef: project.projectRef, bindingRef: rescue.bindingRef }), /invalid continuity manifest/);

const different = buildContinuityManifest({ ...common, summary: "different" });
assert.notEqual(different.integrity.hash, first.integrity.hash, "reported fields are explicitly labelled but still covered by integrity hash");

console.log("continuity-manifest-v5: ok");
