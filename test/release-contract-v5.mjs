import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { PUBLIC_SURFACE_VERSION, PUBLIC_TOOL_NAMES } from "../src/surface-contracts.mjs";

const root = path.resolve(import.meta.dirname, "..");
const workflowPath = path.join(root, ".github", "workflows", "v5-foundation.yml");
const workflow = await readFile(workflowPath, "utf8");
const readme = await readFile(path.join(root, "README.md"), "utf8");
const readmeZh = await readFile(path.join(root, "README.zh-CN.md"), "utf8");
const security = await readFile(path.join(root, "SECURITY.md"), "utf8");
const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));

assert.equal(PUBLIC_SURFACE_VERSION, "codexless-public-preview-v5");
assert.equal(new Set(PUBLIC_TOOL_NAMES).size, PUBLIC_TOOL_NAMES.length, "public tool names must be unique");
assert.ok(PUBLIC_TOOL_NAMES.includes("codex.workspace_open"));
assert.ok(PUBLIC_TOOL_NAMES.includes("codex.command_poll"));
assert.ok(PUBLIC_TOOL_NAMES.includes("codex.edit_undo"));
assert.ok(PUBLIC_TOOL_NAMES.includes("codex.edit_redo"));
assert.equal(PUBLIC_TOOL_NAMES.some((name) => name.startsWith("codex.agent_")), false);

assert.match(workflow, /workflow_dispatch\s*:/);
assert.doesNotMatch(workflow, /^\s*push\s*:/m, "V5 CI must remain manual-only during stabilization");
assert.doesNotMatch(workflow, /^\s*pull_request\s*:/m, "V5 CI must remain manual-only during stabilization");

const checkedPaths = [...workflow.matchAll(/node --check\s+([^\s]+)/g)].map((match) => match[1]);
assert.ok(checkedPaths.length > 0);
for (const relative of checkedPaths) await access(path.join(root, relative));

assert.equal(packageJson.engines?.node, ">=22.13.0");
assert.equal(packageJson.bin?.codexless, "bin/codexless-entry.mjs");
assert.equal(packageJson.repository?.url, "git+https://github.com/LeoMbm/Codexless.git");
assert.equal(packageJson.homepage, "https://github.com/LeoMbm/Codexless#readme");
assert.equal(packageJson.bugs?.url, "https://github.com/LeoMbm/Codexless/issues");
assert.match(packageJson.scripts?.["test:v5"] ?? "", /release-contract-v5\.mjs/, "test:v5 must include the release contract guard");

assert.match(readme, /codexless-public-preview-v5/);
assert.match(readme, /27 public tools/);
assert.doesNotMatch(readme, /codex\.agent_(?:start|send|commit)/);
assert.doesNotMatch(readme, /exactly \*\*21/);

assert.match(security, /Codexless V5 public surface/);
assert.match(security, /27 public tools/);
assert.doesNotMatch(security, /codex\.agent_(?:start|send|commit)/);
assert.doesNotMatch(security, /exactly 21 tools/);

assert.match(readmeZh, /V5/);
assert.match(readmeZh, /README\.md/);
assert.doesNotMatch(readmeZh, /codex\.agent_(?:start|send|commit)/);

console.log("release-contract-v5: ok");
