import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
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
    CODEX_TOOLBOX_DEFAULT_CWD: "Z:\\codexless-must-ignore",
    CODEX_TOOLBOX_PROFILE: "__codexless_must_ignore__",
    CODEX_TOOLBOX_CONFIG_OVERRIDES_FILE: "Z:\\codexless-must-ignore.json",
    CODEX_TOOLBOX_AGENT_METERED_CONSENT: "__codexless_must_ignore__",
    ...(testCwd ? { CODEXLESS_DEFAULT_CWD: testCwd } : {}),
    ...extra,
  });
  return env;
}

assert.equal(PUBLIC_SURFACE_VERSION, "codexless-public-preview-v3");
assert.equal(PUBLIC_TOOL_NAMES.length, 28);

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
  "codex.thread_archive",
  "codex.thread_delete",
  "codex.thread_rollback",
  "codex.continuity_push",
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
  assert.equal(names.length, 28);

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
  const threadListTool = tools.tools.find((tool) => tool.name === "codex.thread_list");
  const threadReadTool = tools.tools.find((tool) => tool.name === "codex.thread_read");
  const threadItemsTool = tools.tools.find((tool) => tool.name === "codex.thread_items");
  const bindTool = tools.tools.find((tool) => tool.name === "codex.continuity_bind");
  const statusTool = tools.tools.find((tool) => tool.name === "codex.continuity_status");
  const checkpointTool = tools.tools.find((tool) => tool.name === "codex.continuity_checkpoint");
  const unbindTool = tools.tools.find((tool) => tool.name === "codex.continuity_unbind");
  const appOnlyCardToolNames = ["codex.agent_card_state", "codex.agent_decline", "codex.agent_commit"];

  assert.equal(commandTool?.annotations?.destructiveHint, true);
  assert.equal(preciseEditTool?.annotations?.destructiveHint, true);
  assert.equal(threadListTool?.annotations?.readOnlyHint, true);
  assert.equal(threadReadTool?.annotations?.readOnlyHint, true);
  assert.equal(threadItemsTool?.annotations?.readOnlyHint, true);
  assert.equal(bindTool?.annotations?.readOnlyHint, true);
  assert.equal(statusTool?.annotations?.readOnlyHint, true);
  assert.equal(checkpointTool?.annotations?.destructiveHint, true);
  assert.equal(unbindTool?.annotations?.destructiveHint, false);
  assert.match(threadReadTool?.description ?? "", /raw reasoning.*omitted/i);
  assert.match(checkpointTool?.description ?? "", /before each final response/i);
  assert.equal(Object.hasOwn(commandTool?.inputSchema?.properties ?? {}, "bindingRef"), true);
  assert.equal(Object.hasOwn(preciseEditTool?.inputSchema?.properties ?? {}, "bindingRef"), true);
  assert.deepEqual(Object.keys(skillListTool?.inputSchema?.properties ?? {}).sort(), ["cwd", "query"]);
  assert.equal(Object.hasOwn(skillListTool?.inputSchema?.properties ?? {}, "kind"), false);

  const nestedCodexCommand = await client.callTool({
    name: "codex.command_exec",
    arguments: { command: [codexBin, "--version"], access: "readOnly" },
  });
  assert.equal(nestedCodexCommand.isError, true, "public command_exec must refuse a nested Codex CLI launch before dispatch");
  assert.equal(nestedCodexCommand.structuredContent?.errorCode, "METERED_CODEX_REQUIRES_AGENT_CARD");
  assert.match(nestedCodexCommand.structuredContent?.error ?? nestedCodexCommand.content?.[0]?.text ?? "", /codex\.agent_start/i);

  for (const name of appOnlyCardToolNames) {
    const tool = tools.tools.find((candidate) => candidate.name === name);
    assert.deepEqual(tool?._meta?.ui?.visibility, ["app"], `${name} must remain app-only`);
  }

  const resources = await client.listResources();
  assert.equal(resources.resources.some((resource) => resource.uri === AGENT_TASK_CARD_URI), true);
  const taskCardResource = await client.readResource({ uri: AGENT_TASK_CARD_URI });
  assert.equal(taskCardResource.contents?.[0]?.mimeType, "text/html;profile=mcp-app");
  assert.match(taskCardResource.contents?.[0]?.text ?? "", /codex\.agent_commit/);
  assert.match(taskCardResource.contents?.[0]?.text ?? "", /codexlessCommitToken/);
  assert.match(taskCardResource.contents?.[0]?.text ?? "", /commitToken/);

  const startTool = tools.tools.find((tool) => tool.name === "codex.agent_start");
  const sendTool = tools.tools.find((tool) => tool.name === "codex.agent_send");
  assert.match(startTool?.description ?? "", /consentRef identifies.*never proof of approval/i);
  assert.match(sendTool?.description ?? "", /consentRef identifies.*never proof of approval/i);
  assert.match(startTool?.inputSchema?.properties?.consentRef?.description ?? "", /never authorizes/i);
  assert.match(sendTool?.inputSchema?.properties?.consentRef?.description ?? "", /never authorizes/i);

  const requestId = `contract-consent-${randomUUID()}`;
  const prompt = "Codexless contract probe: prepare only; do not start Codex.";
  const prepared = await client.callTool({ name: "codex.agent_start", arguments: { prompt, requestId } });

  if (prepared.isError) {
    const errorCode = prepared.structuredContent?.errorCode ?? null;
    const errorText = prepared.structuredContent?.error ?? prepared.content?.[0]?.text ?? "unknown error";
    if (testCwd) {
      assert.fail(`codex.agent_start failed for CODEXLESS_TEST_CWD=${testCwd}: ${errorCode ?? "no-code"}: ${errorText}`);
    }
    if (errorCode !== null) {
      assert.equal(
        errorCode,
        "PERMISSION_APPROVAL_REQUIRED",
        `agent consent contract failed for an unexpected reason: ${errorCode}: ${errorText}`
      );
    }
    assert.match(errorText, /trusted project|trusted.*root|explicitly trust|authorize/i);
    console.log("public contract agent consent flow SKIP: Codexless repo is not a trusted Codex project; set CODEXLESS_TEST_CWD to run the trusted-project end-to-end lane");
  } else {
    assert.equal(prepared.structuredContent?.status, "consent_required");
    assert.equal(prepared.structuredContent?.turnId, null);
    assert.equal(prepared.structuredContent?.agentRef, null);
    assert.equal(prepared.structuredContent?.manualFallback?.kind, "task_card_required");
    assert.match((prepared.structuredContent?.manualFallback?.lines ?? []).join(" "), /No Codex turn has started/i);
    const consentRef = prepared.structuredContent?.meteredConsent?.consentRef;
    assert.match(consentRef ?? "", /^consent_/);

    const replay = await client.callTool({ name: "codex.agent_start", arguments: { prompt, requestId, consentRef } });
    assert.equal(replay.structuredContent?.status, "consent_required");
    assert.equal(replay.structuredContent?.turnId, null);
    assert.equal(replay.structuredContent?.agentRef, null);
    assert.equal(replay.structuredContent?.duplicate, true);

    const rendered = await client.callTool({ name: "codex.agent_card_render", arguments: { consentRef } });
    const commitToken = rendered._meta?.codexlessCommitToken;
    assert.match(commitToken ?? "", /^commit_/);
    assert.equal(JSON.stringify(rendered.structuredContent).includes(commitToken), false);
    assert.equal((rendered.content?.[0]?.text ?? "").includes(commitToken), false);

    const missingCapability = await client.callTool({ name: "codex.agent_commit", arguments: { consentRef } }).catch((error) => ({ isError: true, error }));
    assert.equal(missingCapability.isError, true);

    const wrongCapability = await client.callTool({
      name: "codex.agent_commit",
      arguments: { consentRef, commitToken: `commit_wrong_${randomUUID()}` },
    });
    assert.equal(wrongCapability.isError, true);

    const declineRequestId = `contract-decline-${randomUUID()}`;
    const declinePrompt = "Codexless contract probe: prepare, decline, and stay terminal without starting Codex.";
    const declinePrepared = await client.callTool({ name: "codex.agent_start", arguments: { prompt: declinePrompt, requestId: declineRequestId } });
    assert.equal(declinePrepared.isError, false, `decline preparation failed: ${declinePrepared.structuredContent?.error ?? "unknown error"}`);
    const declineConsentRef = declinePrepared.structuredContent?.meteredConsent?.consentRef;
    assert.match(declineConsentRef ?? "", /^consent_/);
    const declined = await client.callTool({ name: "codex.agent_decline", arguments: { consentRef: declineConsentRef } });
    assert.equal(declined.structuredContent?.status, "rejected");
    assert.equal(declined.structuredContent?.terminal, true);
    assert.equal(declined.structuredContent?.agentRef, null);
    assert.equal(declined.structuredContent?.turnId, null);
  }
} finally {
  await client.close().catch(() => {});
  await transport.close().catch(() => {});
}

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
  let lastError = null;
  while (Date.now() < deadline) {
    if (httpChild.exitCode !== null) throw new Error(`Codexless HTTP exited early (${httpChild.exitCode}): ${httpStderr}`);
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
  assert.equal(Object.hasOwn(health, "defaultCwd"), false);

  const httpClient = new Client({ name: "codexless-public-contract-http", version: "0.1.0" });
  const httpTransport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
  try {
    await httpClient.connect(httpTransport);
    const httpTools = await httpClient.listTools();
    const httpNames = httpTools.tools.map((tool) => tool.name);
    assert.equal(httpNames.length, 28);
    assert.deepEqual([...httpNames].sort(), [...PUBLIC_TOOL_NAMES].sort());
    for (const name of forbiddenNames) assert.equal(httpNames.includes(name), false);
  } finally {
    await httpClient.close().catch(() => {});
  }
} finally {
  await stopHttpChild();
}
