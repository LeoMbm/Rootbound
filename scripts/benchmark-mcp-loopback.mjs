import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { performance } from "node:perf_hooks";

const require = createRequire(import.meta.url);
const { Client, StreamableHTTPClientTransport } = require("@modelcontextprotocol/client");

const options = parseArgs(process.argv.slice(2));
const cwd = path.resolve(options.cwd ?? process.cwd());
const endpoint = new URL(options.url);
const client = new Client({ name: "rootbound-loopback-benchmark", version: "0.1.0" });
const transport = new StreamableHTTPClientTransport(endpoint);

try {
  await client.connect(transport);

  const scenarios = [
    {
      name: "repo_search",
      request: {
        name: "codex.repo_search",
        arguments: { cwd, query: "CodexAuthorityExecutor", glob: "src/*.mjs", maxResults: 20 },
      },
    },
    {
      name: "read_many_3",
      request: {
        name: "codex.read_many",
        arguments: {
          cwd,
          paths: ["package.json", "src/public-runtime.mjs", "src/codex-authority-executor.mjs"],
          maxCharsPerFile: 30_000,
          maxTotalChars: 80_000,
        },
      },
    },
    { name: "git_status", request: { name: "codex.git_status", arguments: { cwd } } },
    { name: "git_diff", request: { name: "codex.git_diff", arguments: { cwd, staged: false, pathspec: [] } } },
    {
      name: "command_exec",
      request: {
        name: "codex.command_exec",
        arguments: {
          cwd,
          command: [process.execPath, "-e", "process.stdout.write('ok')"],
          access: "readOnly",
          timeoutMs: 10_000,
        },
      },
    },
  ];

  const results = {};
  for (const scenario of scenarios) {
    for (let index = 0; index < options.warmups; index += 1) await callChecked(client, scenario);
    const samples = [];
    for (let index = 0; index < options.iterations; index += 1) {
      const startedAt = performance.now();
      await callChecked(client, scenario);
      samples.push(performance.now() - startedAt);
    }
    results[scenario.name] = summarize(samples);
  }

  const output = {
    schemaVersion: 1,
    benchmark: "rootbound-mcp-loopback",
    measuredAt: new Date().toISOString(),
    endpoint: endpoint.toString(),
    cwd,
    iterations: options.iterations,
    warmups: options.warmups,
    results,
  };
  process.stdout.write(`${JSON.stringify(output, null, options.json ? 0 : 2)}\n`);
} finally {
  await client.close().catch(() => {});
}

async function callChecked(target, scenario) {
  const result = await target.callTool(scenario.request);
  if (result?.isError) {
    const detail = result.structuredContent?.error
      ?? result.content?.map((part) => part?.text).filter(Boolean).join("\n")
      ?? "unknown MCP tool error";
    throw new Error(`${scenario.name} failed: ${detail}`);
  }
  return result;
}

function summarize(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    samplesMs: samples.map(round),
    minMs: round(sorted[0]),
    medianMs: round(percentile(sorted, 0.5)),
    p95Ms: round(percentile(sorted, 0.95)),
    maxMs: round(sorted[sorted.length - 1]),
    meanMs: round(samples.reduce((sum, value) => sum + value, 0) / samples.length),
  };
}

function percentile(sorted, value) {
  if (sorted.length === 1) return sorted[0];
  const index = (sorted.length - 1) * value;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  const weight = index - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function round(value) { return Math.round(value * 100) / 100; }

function parseArgs(argv) {
  const parsed = { cwd: null, url: "http://127.0.0.1:7690/mcp", iterations: 7, warmups: 1, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--cwd") parsed.cwd = requireValue(argv, ++index, arg);
    else if (arg === "--url") parsed.url = requireValue(argv, ++index, arg);
    else if (arg === "--iterations") parsed.iterations = positiveInt(requireValue(argv, ++index, arg), arg);
    else if (arg === "--warmups") parsed.warmups = nonNegativeInt(requireValue(argv, ++index, arg), arg);
    else if (arg === "--json") parsed.json = true;
    else if (arg === "-h" || arg === "--help") {
      process.stdout.write("Usage: node scripts/benchmark-mcp-loopback.mjs [--cwd <project>] [--url <mcp-url>] [--iterations N] [--warmups N] [--json]\n");
      process.exit(0);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  return parsed;
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

function positiveInt(value, flag) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || String(parsed) !== value) throw new Error(`${flag} must be a positive integer`);
  return parsed;
}

function nonNegativeInt(value, flag) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0 || String(parsed) !== value) throw new Error(`${flag} must be a non-negative integer`);
  return parsed;
}
