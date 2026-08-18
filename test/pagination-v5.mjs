import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { decodeCursor, encodeCursor } from "../src/pagination.mjs";
import { readManyAuthorized } from "../src/construction-tools.mjs";
import { searchPageAuthorized } from "../src/repo-tools.mjs";

const signature = { query: "hello", cwd: "/tmp/project" };
const cursor = encodeCursor("unit", signature, { offset: 4 });
assert.deepEqual(decodeCursor(cursor, "unit", signature), { offset: 4 });
assert.throws(() => decodeCursor(cursor, "unit", { query: "other", cwd: "/tmp/project" }), (error) => error?.code === "PAGINATION_CURSOR_INVALID");

const root = await mkdtemp(path.join(os.tmpdir(), "codexless-pagination-"));
const a = path.join(root, "a.txt");
const b = path.join(root, "b.txt");
await writeFile(a, "abcdefghij", "utf8");
await writeFile(b, "klmnop", "utf8");

const readExecutor = {
  async resolveAuthority({ cwd }) { return { effectiveCwd: cwd, trustedAncestor: root, permissionProfile: ":read-only" }; },
  async exec({ command }) {
    const target = command[3];
    return { exitCode: 0, stdout: await readFile(target, "utf8"), stderr: "", stdoutTruncated: false };
  },
};

const firstRead = await readManyAuthorized({ authorityExecutor: readExecutor, paths: ["a.txt", "b.txt"], cwd: root, maxCharsPerFile: 5, maxTotalChars: 5 });
assert.equal(firstRead.files[0].text, "abcde");
assert.equal(firstRead.hasMore, true);
assert.ok(firstRead.nextCursor);

const secondRead = await readManyAuthorized({ authorityExecutor: readExecutor, paths: ["a.txt", "b.txt"], cwd: root, maxCharsPerFile: 5, maxTotalChars: 5, cursor: firstRead.nextCursor });
assert.equal(secondRead.files[0].text, "fghij");
assert.equal(secondRead.hasMore, true);

await writeFile(a, "CHANGED", "utf8");
await assert.rejects(
  () => readManyAuthorized({ authorityExecutor: readExecutor, paths: ["a.txt", "b.txt"], cwd: root, maxCharsPerFile: 5, maxTotalChars: 5, cursor: firstRead.nextCursor }),
  (error) => error?.code === "PAGINATION_SOURCE_CHANGED"
);

const narrow = path.join(root, "narrow");
await mkdir(narrow);
await writeFile(path.join(narrow, "inside.txt"), "inside", "utf8");
await writeFile(path.join(root, "sibling.txt"), "sibling", "utf8");
const inside = await readManyAuthorized({ authorityExecutor: readExecutor, paths: ["inside.txt"], cwd: narrow, maxCharsPerFile: 1000, maxTotalChars: 1000 });
assert.equal(inside.files[0].text, "inside");
await assert.rejects(
  () => readManyAuthorized({ authorityExecutor: readExecutor, paths: ["../sibling.txt"], cwd: narrow, maxCharsPerFile: 1000, maxTotalChars: 1000 }),
  /outside scope/i
);

const matches = ["a:1:1:first", "a:2:1:second", "b:3:1:third", "c:4:1:fourth"];
const searchExecutor = {
  async resolveAuthority({ cwd }) { return { effectiveCwd: cwd, trustedAncestor: cwd, permissionProfile: ":read-only" }; },
  async exec({ command }) {
    const offset = Number(command[4]);
    const limit = Number(command[5]);
    const page = matches.slice(offset, offset + limit);
    const hasMore = offset + limit < matches.length;
    return { exitCode: 0, stdout: JSON.stringify({ ok: true, page, hasMore, scanned: offset + page.length + (hasMore ? 1 : 0) }), stderr: "" };
  },
};
const firstSearch = await searchPageAuthorized({ authorityExecutor: searchExecutor, query: "x", cwd: root, maxResults: 2 });
assert.deepEqual(firstSearch.results, matches.slice(0, 2));
assert.equal(firstSearch.hasMore, true);
const secondSearch = await searchPageAuthorized({ authorityExecutor: searchExecutor, query: "x", cwd: root, maxResults: 2, cursor: firstSearch.nextCursor });
assert.deepEqual(secondSearch.results, matches.slice(2));
assert.equal(secondSearch.hasMore, false);
await assert.rejects(
  () => searchPageAuthorized({ authorityExecutor: searchExecutor, query: "different", cwd: root, maxResults: 2, cursor: firstSearch.nextCursor }),
  (error) => error?.code === "PAGINATION_CURSOR_INVALID"
);

console.log("pagination-v5: ok");
