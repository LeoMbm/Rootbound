import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { buildDiagnosticSnapshot } from "../src/diagnostics.mjs";
import { openStateStore } from "../src/state-store.mjs";
import { resolveCodexlessPaths } from "../src/state-paths.mjs";

const args = parseArgs(process.argv.slice(2));
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const store = await openStateStore({ paths: resolveCodexlessPaths() });
try {
  const snapshot = await buildDiagnosticSnapshot({ store, packageRoot, maxEvents: args.events, maxLogBytes: args.logBytes });
  if (args.output) {
    const target = path.resolve(args.output);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
    if (args.json) process.stdout.write(`${JSON.stringify({ ok: true, action: "diagnostic-exported", path: target, generatedAt: snapshot.generatedAt }, null, 2)}\n`);
    else process.stdout.write(`Codexless diagnostic exported: ${target}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
  }
} finally {
  store.close();
}

function parseArgs(argv) {
  const parsed = { output: null, json: false, events: 200, logBytes: 64 * 1024 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") parsed.json = true;
    else if (arg === "--output" || arg === "-o") {
      if (!argv[index + 1]) throw new Error(`${arg} requires a path`);
      parsed.output = argv[++index];
    } else if (arg === "--events") {
      parsed.events = parseIntRange(argv[++index], "--events", 1, 1000);
    } else if (arg === "--log-bytes") {
      parsed.logBytes = parseIntRange(argv[++index], "--log-bytes", 1024, 1024 * 1024);
    } else if (arg === "-h" || arg === "--help") {
      process.stdout.write("Usage: node scripts/diagnostic.mjs [--output <file>] [--events N] [--log-bytes N] [--json]\n");
      process.exit(0);
    } else throw new Error(`Unknown diagnostic argument: ${arg}`);
  }
  return parsed;
}

function parseIntRange(value, label, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || String(parsed) !== String(value) || parsed < min || parsed > max) throw new Error(`${label} must be an integer between ${min} and ${max}`);
  return parsed;
}
