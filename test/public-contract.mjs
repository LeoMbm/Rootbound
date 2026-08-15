import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { ACCEPTED_CODEX_VERSIONS } from "../src/codex-authority-executor.mjs";
import { resolveCodexExecutable } from "../src/codex-bin.mjs";
import { PUBLIC_SURFACE_VERSION, PUBLIC_TOOL_NAMES } from "../src/surface-contracts.mjs";
import { AGENT_TASK_CARD_URI } from "../src/agent-card-ui.mjs";

const require = createRequire(import.meta.url);
const { Client, StreamableHTTPClientTransport } = require("@modelcontextprotocol/client");
const { StdioClientTransport } = require("@modelcontextprotocol/client/stdio");

const projectRoot = path.resolve(import.meta.dirname, "..");
const codexBin = (await resolveCodexExecutable({ acceptedVersions: ACCEPTED_CODEX_VERSIONS })).path;
const testCwd = process.env.CODEXLESS_TEST_CWD;

function createIsolatedPublicTestEnv(extra = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("CODEX_TOOLBOX_") || key.startsWith("CODEXLESS_")) delete env[key];
  }
  Object.assign(env, {
    CODEX_BIN: codexBin,
    // Poison legacy Toolwire variables deliberately. A clean Codexless runtime must ignore all of them.
    CODEX_TOOLBOX_DEFAULT_CWD: "Z:\\codexless-must-ignore",
    CODEX_TOOLBOX_PROFILE: "__codexless_must_ignore__",
    CODEX_TOOLBOX_CONFIG_OVERRIDES_FILE: "Z:\\codexless-must-ignore.json",
    CODEX_TOOLBOX_AGENT_METERED_CONSENT: "__codexless_must_ignore__",
    ...(testCwd ? { CODEXLESS_DEFAULT_CWD: testCwd } : {}),
    ...extra,
  });
  return env;
}

assert.equal(PUBLIC_SURFACE_VERSION, "codexless-public-preview-v1");
assert.equal(PUBLIC_TOOL_NAMES.length, 21);

const forbiddenNames = [
  "codex.browser_prepare_click",
  "codex.browser_click",
  "codex.browser_prepare_fill",
  "codex.browser_fill",
  "codex.fs_read",
  "codex.fs_mutate",
  "codex.process",
  "codex.process_receipt",
  "codex.catalog",
  "codex.mcp_call",
];

const client = new Client({ name: "codexless-public-contract", version: "0.1.0" });
if (process.env.MCP_TEST_NEGOTIATION === "modern") client.setVersionNegotiation({ mode: "auto" });

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(projectRoot, "src", "mcp-stdio.mjs")],
  cwd: projectRoot,
  env: createIsolatedPublicTestEnv(),
  stderr: "pipe",
});
transport.stderr?.setEncoding("utf8");
transport.stderr?.on("data", (chunk) => process.stderr.write(`[codexless] ${chunk}`));

await client.connect(transport);
try {
  const tools = await client.listTools();
  const names = tools.tools.map((tool) => tool.name);
  assert.deepEqual([...names].sort(), [...PUBLIC_TOOL_NAMES].sort());
  assert.equal(names.length, 21);

  for (const name of forbiddenNames) {
    assert.equal(names.includes(name), false, `${name} must not be exposed by the public preview`);
  }
  assert.equal(names.some((name) => name.startsWith("computer.")), false);
  assert.deepEqual(names.filter((name) => name.startsWith("codex.browser_")), [
    "codex.browser_status",
    "codex.browser_tabs",
    "codex.browser_read",
  ]);

  const commandTool = tools.tools.find((tool) => tool.name === "codex.command_exec");
  const preciseEditTool = tools.tools.find((tool) => tool.name === "codex.precise_edit");
  const skillListTool = tools.tools.find((tool) => tool.name === "codex.skill_list");
  const appOnlyCardToolNames = ["codex.agent_card_state", "codex.agent_decline", "codex.agent_commit"];
  assert.equal(commandTool?.annotations?.destructiveHint, true);
  assert.equal(preciseEditTool?.annotations?.destructiveHint, true);
  assert.deepEqual(Object.keys(skillListTool?.inputSchema?.properties ?? {}).sort(), ["cwd", "query"]);
  assert.equal(Object.hasOwn(skillListTool?.inputSchema?.properties ?? {}, "kind"), false);
  for (const name of appOnlyCardToolNames) {
    const tool = tools.tools.find((candidate) => candidate.name === name);
    assert.deepEqual(tool?._meta?.ui?.visibility, ["app"], `${name} must remain app-only`);
  }

  const resources = await client.listResources();
  assert.equal(resources.resources.some((resource) => resource.uri === AGENT_TASK_CARD_URI), true);
  const taskCardResource = await client.readResource({ uri: AGENT_TASK_CARD_URI });
  assert.equal(taskCardResource.contents?.[0]?.mimeType, "text/html;profile=mcp-app");
  assert.match(taskCardResource.contents?.[0]?.text ?? "", /codex\.agent_commit/);
} finally {
  await client.close().catch(() => {});
  await transport.close().catch(() => {});
}

const httpPort = 17691;
const baseUrl = `http://127.0.0.1:${httpPort}`;
const httpChild = spawn(process.execPath, [path.join(projectRoot, "src", "mcp-http.mjs")], {
  cwd: projectRoot,
  env: createIsolatedPublicTestEnv({
    CODEXLESS_HOST: "127.0.0.1",
    CODEXLESS_PORT: String(httpPort),
  }),
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});

let httpStderr = "";
httpChild.stderr.setEncoding("utf8");
httpChild.stderr.on("data", (chunk) => { httpStderr += chunk; });

async function waitForHttpHealth() {
  const deadline = Date.now() + 30_000;
  let lastError = null;
  while (Date.now() < deadline) {
    if (httpChild.exitCode !== null) {
      throw new Error(`Codexless HTTP exited early (${httpChild.exitCode}): ${httpStderr}`);
    }
    try {
      const response = await fetch(`${baseUrl}/healthz`);
      if (response.ok) return response.json();
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Codexless HTTP did not become healthy: ${String(lastError ?? "timeout")}\n${httpStderr}`);
}

async function stopHttpChild() {
  if (httpChild.exitCode !== null) return;
  httpChild.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => httpChild.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (httpChild.exitCode === null) httpChild.kill("SIGKILL");
}

try {
  const health = await waitForHttpHealth();
  assert.equal(health.ok, true);
  assert.equal(health.service, "codexless-public-preview");
  assert.equal(health.surfaceVersion, PUBLIC_SURFACE_VERSION);
  assert.equal(health.toolCount, PUBLIC_TOOL_NAMES.length);
  assert.equal(Object.hasOwn(health, "defaultCwd"), false, "public health metadata must not expose local project paths");

  const httpClient = new Client({ name: "codexless-public-contract-http", version: "0.1.0" });
  const httpTransport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
  try {
    await httpClient.connect(httpTransport);
    const httpTools = await httpClient.listTools();
    const httpNames = httpTools.tools.map((tool) => tool.name);
    assert.equal(httpNames.length, 21);
    assert.deepEqual([...httpNames].sort(), [...PUBLIC_TOOL_NAMES].sort());
    for (const name of forbiddenNames) {
      assert.equal(httpNames.includes(name), false, `${name} must not be exposed by the public HTTP preview`);
    }
  } finally {
    await httpClient.close().catch(() => {});
  }
} finally {
  await stopHttpChild();
}
