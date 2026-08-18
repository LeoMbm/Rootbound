import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { ACCEPTED_CODEX_VERSIONS } from "../src/codex-authority-executor.mjs";
import { resolveCodexExecutable } from "../src/codex-bin.mjs";
import { PUBLIC_SURFACE_VERSION, PUBLIC_TOOL_NAMES } from "../src/surface-contracts.mjs";

const require = createRequire(import.meta.url);
const { Client, StreamableHTTPClientTransport } = require("@modelcontextprotocol/client");
const { StdioClientTransport } = require("@modelcontextprotocol/client/stdio");

const projectRoot = path.resolve(import.meta.dirname, "..");
const codexBin = (await resolveCodexExecutable({ acceptedVersions: ACCEPTED_CODEX_VERSIONS })).path;
const testCwd = process.env.CODEXLESS_TEST_CWD;
const stateHome = path.join(os.tmpdir(), `codexless-public-contract-${process.pid}`);

function createIsolatedPublicTestEnv(extra = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("CODEX_TOOLBOX_") || key.startsWith("CODEXLESS_")) delete env[key];
  }
  Object.assign(env, {
    CODEX_BIN: codexBin,
    CODEXLESS_HOME: stateHome,
    ...(testCwd ? { CODEXLESS_DEFAULT_CWD: testCwd } : {}),
    ...extra,
  });
  return env;
}

assert.equal(PUBLIC_SURFACE_VERSION, "codexless-public-preview-v5");
assert.ok(PUBLIC_TOOL_NAMES.length >= 27);
assert.equal(new Set(PUBLIC_TOOL_NAMES).size, PUBLIC_TOOL_NAMES.length);

const requiredNames = [
  "codex.command_start", "codex.command_poll", "codex.command_write", "codex.command_terminate",
  "codex.workspace_open", "codex.precise_edit", "codex.edit_undo", "codex.edit_redo",
];
const forbiddenNames = [
  "codex.account_preflight", "codex.model_list", "codex.agent_start", "codex.agent_card_render", "codex.agent_card_state",
  "codex.agent_show", "codex.agent_send", "codex.agent_decline", "codex.agent_commit", "codex.agent_approve", "codex.agent_reject",
  "codex.agent_cancel", "codex.thread_archive", "codex.thread_delete", "codex.thread_rollback", "codex.continuity_push",
  "codex.command_status", "codex.command_output", "codex.command_stop",
];

async function assertPublicSurface(client) {
  const tools = await client.listTools();
  const names = tools.tools.map((tool) => tool.name);
  assert.equal(names.length, PUBLIC_TOOL_NAMES.length);
  assert.deepEqual([...names].sort(), [...PUBLIC_TOOL_NAMES].sort());
  for (const name of requiredNames) assert.equal(names.includes(name), true, `${name} must be exposed by V5 surface`);
  for (const name of forbiddenNames) assert.equal(names.includes(name), false, `${name} must not be exposed by ChatGPT-only surface`);
  assert.equal(names.some((name) => name.startsWith("codex.agent_")), false);

  const commandTool = tools.tools.find((tool) => tool.name === "codex.command_exec");
  const commandStartTool = tools.tools.find((tool) => tool.name === "codex.command_start");
  const commandPollTool = tools.tools.find((tool) => tool.name === "codex.command_poll");
  const commandWriteTool = tools.tools.find((tool) => tool.name === "codex.command_write");
  const commandTerminateTool = tools.tools.find((tool) => tool.name === "codex.command_terminate");
  const workspaceTool = tools.tools.find((tool) => tool.name === "codex.workspace_open");
  const undoTool = tools.tools.find((tool) => tool.name === "codex.edit_undo");
  const redoTool = tools.tools.find((tool) => tool.name === "codex.edit_redo");
  const searchTool = tools.tools.find((tool) => tool.name === "codex.repo_search");
  const patchTool = tools.tools.find((tool) => tool.name === "codex.apply_patch");
  const statusTool = tools.tools.find((tool) => tool.name === "codex.git_status");
  const diffTool = tools.tools.find((tool) => tool.name === "codex.git_diff");
  const contextTool = tools.tools.find((tool) => tool.name === "codex.project_context");

  assert.equal(commandTool?.annotations?.destructiveHint, true);
  assert.equal(commandStartTool?.annotations?.destructiveHint, true);
  assert.equal(commandPollTool?.annotations?.readOnlyHint, true);
  assert.equal(commandWriteTool?.annotations?.destructiveHint, true);
  assert.equal(commandTerminateTool?.annotations?.destructiveHint, true);
  assert.equal(workspaceTool?.annotations?.readOnlyHint, true);
  assert.equal(undoTool?.annotations?.destructiveHint, true);
  assert.equal(redoTool?.annotations?.destructiveHint, true);
  assert.equal(searchTool?.annotations?.readOnlyHint, true);
  assert.equal(statusTool?.annotations?.readOnlyHint, true);
  assert.equal(diffTool?.annotations?.readOnlyHint, true);
  assert.equal(patchTool?.annotations?.destructiveHint, true);
  assert.match(commandTool?.description ?? "", /without starting a Codex model turn/i);
  assert.match(commandStartTool?.description ?? "", /without starting a Codex model turn/i);
  assert.match(commandPollTool?.description ?? "", /incremental/i);
  assert.match(commandWriteTool?.description ?? "", /stdin/i);
  assert.match(commandTerminateTool?.description ?? "", /terminate/i);
  assert.match(workspaceTool?.description ?? "", /never creates|never.*trust|does not.*trust/i);
  assert.match(undoTool?.description ?? "", /hash|SHA/i);
  assert.match(redoTool?.description ?? "", /hash|SHA/i);
  assert.match(patchTool?.description ?? "", /does not start a Codex model turn/i);
  assert.match(contextTool?.description ?? "", /read-only/i);

  const nestedCodexCommand = await client.callTool({ name: "codex.command_exec", arguments: { command: [codexBin, "--version"], access: "readOnly" } });
  assert.equal(nestedCodexCommand.isError, true, "nested Codex launch must stay blocked");
  assert.match(nestedCodexCommand.structuredContent?.error ?? nestedCodexCommand.content?.[0]?.text ?? "", /Codex|agent/i);

  const nestedLongCommand = await client.callTool({ name: "codex.command_start", arguments: { command: [codexBin, "--version"], cwd: projectRoot, access: "readOnly" } });
  assert.equal(nestedLongCommand.isError, true, "nested Codex launch through command_start must stay blocked");
}

const client = new Client({ name: "codexless-public-contract", version: "0.1.0" });
const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(projectRoot, "src", "mcp-stdio.mjs")], cwd: projectRoot, env: createIsolatedPublicTestEnv(), stderr: "pipe" });
transport.stderr?.setEncoding("utf8");
transport.stderr?.on("data", (chunk) => process.stderr.write(`[codexless] ${chunk}`));
await client.connect(transport);
try { await assertPublicSurface(client); }
finally { await client.close().catch(() => {}); await transport.close().catch(() => {}); }

const httpPort = 17691;
const baseUrl = `http://127.0.0.1:${httpPort}`;
const httpChild = spawn(process.execPath, [path.join(projectRoot, "src", "mcp-http.mjs")], {
  cwd: projectRoot,
  env: createIsolatedPublicTestEnv({ CODEXLESS_HOST: "127.0.0.1", CODEXLESS_PORT: String(httpPort) }),
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
let httpStderr = "";
httpChild.stderr.setEncoding("utf8");
httpChild.stderr.on("data", (chunk) => { httpStderr += chunk; });
async function waitForHttpHealth() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (httpChild.exitCode !== null) throw new Error(`Codexless HTTP exited early (${httpChild.exitCode}): ${httpStderr}`);
    try { const response = await fetch(`${baseUrl}/healthz`); if (response.ok) return response.json(); } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Codexless HTTP did not become healthy: ${httpStderr}`);
}

try {
  const health = await waitForHttpHealth();
  assert.equal(health.ok, true);
  assert.equal(health.surfaceVersion, PUBLIC_SURFACE_VERSION);
  assert.equal(health.toolCount, PUBLIC_TOOL_NAMES.length);
  const httpClient = new Client({ name: "codexless-public-contract-http", version: "0.1.0" });
  const httpTransport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
  try { await httpClient.connect(httpTransport); await assertPublicSurface(httpClient); }
  finally { await httpClient.close().catch(() => {}); }
} finally {
  if (httpChild.exitCode === null) httpChild.kill("SIGTERM");
}

console.log("ChatGPT-only public contract PASS");
