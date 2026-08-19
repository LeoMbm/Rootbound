import { createRequire } from "node:module";
import process from "node:process";

const require = createRequire(import.meta.url);
const { Client, StreamableHTTPClientTransport } = require("@modelcontextprotocol/client");

const endpoint = process.env.ROOTBOUND_SOAK_URL ?? "http://127.0.0.1:7690/mcp";
const cwd = process.env.ROOTBOUND_SOAK_CWD ?? process.cwd();
const iterations = Number.parseInt(process.env.ROOTBOUND_SOAK_ITERATIONS ?? "20", 10);

if (!Number.isInteger(iterations) || iterations < 1 || iterations > 200) {
  throw new Error("ROOTBOUND_SOAK_ITERATIONS must be an integer between 1 and 200");
}

const client = new Client({ name: "rootbound-http-soak", version: "0.1.0" });
const transport = new StreamableHTTPClientTransport(new URL(endpoint));

await client.connect(transport);
try {
  const listed = await client.listTools();
  const names = listed.tools.map((tool) => tool.name);
  if (!names.includes("codex.command_exec")) throw new Error("codex.command_exec is missing from the HTTP surface");
  console.log(`connected: ${endpoint}`);
  console.log(`tools: ${names.length}`);
  console.log(`cwd: ${cwd}`);

  for (let i = 1; i <= iterations; i += 1) {
    const startedAt = Date.now();
    const result = await client.callTool({
      name: "codex.command_exec",
      arguments: {
        cwd,
        access: "readOnly",
        timeoutMs: 10_000,
        command: ["/bin/sh", "-lc", `printf 'soak-${i}'`],
      },
    });
    const elapsed = Date.now() - startedAt;
    const payload = result.structuredContent ?? {};
    if (result.isError) {
      console.error(JSON.stringify({ iteration: i, elapsedMs: elapsed, result }, null, 2));
      process.exitCode = 1;
      break;
    }
    if (payload.exitCode !== 0 || payload.stdout !== `soak-${i}` || payload.modelTurnStarted !== false) {
      console.error(JSON.stringify({ iteration: i, elapsedMs: elapsed, unexpected: payload }, null, 2));
      process.exitCode = 1;
      break;
    }
    console.log(`PASS ${i}/${iterations} ${elapsed}ms profile=${payload.permissionProfile ?? "unknown"}`);
  }
} finally {
  await client.close().catch(() => {});
  await transport.close?.().catch(() => {});
}
