import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createEditMutationJournal } from "../src/edit-mutations.mjs";
import { projectRefForRoot } from "../src/project-registry.mjs";
import { resolveCodexlessPaths } from "../src/state-paths.mjs";
import { openStateStore } from "../src/state-store.mjs";

const root = await mkdtemp(path.join(os.tmpdir(), "codexless-edit-mutation-"));
const file = path.join(root, "sample.txt");
const beforeText = "alpha\n";
const afterText = "beta\n";
await writeFile(file, afterText, "utf8");

const paths = resolveCodexlessPaths({ env: { CODEXLESS_HOME: path.join(root, ".state") } });
const store = await openStateStore({ paths });
const projectRef = projectRefForRoot(root);
store.upsertProject({ projectRef, root, gitRoot: null, name: "sample", trusted: true, createdAt: 1, updatedAt: 1, lastConnectedAt: 1 });

const authorityExecutor = {
  async resolveAuthority({ cwd }) {
    return { effectiveCwd: cwd, permissionProfile: ":workspace", permissionCeiling: ":workspace", trustedAncestor: cwd };
  },
  async exec({ command }) {
    const target = command[3];
    if (command.length === 4) {
      const text = await readFile(target, "utf8");
      return { exitCode: 0, stdout: text, stderr: "", stdoutTruncated: false };
    }
    const expectedSha = command[4];
    const nextText = Buffer.from(command[5], "base64").toString("utf8");
    const current = await readFile(target);
    const currentSha = sha(current);
    if (currentSha !== expectedSha) return { exitCode: 12, stdout: "", stderr: "mutation restore refused: file hash changed" };
    await writeFile(target, nextText, "utf8");
    return { exitCode: 0, stdout: "", stderr: "" };
  },
};

const journal = createEditMutationJournal({ store, authorityExecutor });
try {
  const mutation = journal.record({
    projectRef,
    cwd: root,
    path: file,
    beforeSha256: sha(Buffer.from(beforeText)),
    afterSha256: sha(Buffer.from(afterText)),
    beforeText,
    afterText,
    createdAt: 10,
  });

  const undone = await journal.undo(mutation.mutationId);
  assert.equal(undone.status, "undone");
  assert.equal(await readFile(file, "utf8"), beforeText);

  const redone = await journal.redo(mutation.mutationId);
  assert.equal(redone.status, "applied");
  assert.equal(await readFile(file, "utf8"), afterText);

  await writeFile(file, "external change\n", "utf8");
  await assert.rejects(
    () => journal.undo(mutation.mutationId),
    (error) => error?.code === "UNDO_CONFLICT" && error?.category === "state"
  );
  assert.equal(await readFile(file, "utf8"), "external change\n");
} finally {
  store.close();
}

console.log("edit-mutations-v5: ok");

function sha(value) {
  return createHash("sha256").update(value).digest("hex");
}
