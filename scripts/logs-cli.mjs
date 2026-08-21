import { open, stat } from "node:fs/promises";
import { watch } from "node:fs";
import path from "node:path";
import process from "node:process";
import { tailLog } from "../src/runtime-state.mjs";
import { resolveRootboundPaths } from "../src/state-paths.mjs";

const paths = resolveRootboundPaths();
const args = parseArgs(process.argv.slice(2));
if (args.newOnly && !args.follow) fail("--new-only requires --follow");

const text = args.newOnly ? "" : await tailLog(paths.logPath, { maxBytes: args.bytes });
if (args.json) process.stdout.write(`${JSON.stringify({ ok: true, logPath: paths.logPath, text, follow: args.follow, newOnly: args.newOnly }, null, 2)}\n`);
else if (text) {
  if (args.follow) process.stdout.write("--- previous log tail ---\n");
  process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
}
if (args.follow && !args.json) process.stdout.write("--- following new entries from now ---\n");
if (args.follow) await followLog(paths.logPath);

function parseArgs(argv) {
  const out = { bytes: 64 * 1024, follow: false, newOnly: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--follow" || arg === "-f") out.follow = true;
    else if (arg === "--new-only") out.newOnly = true;
    else if (arg === "--json") out.json = true;
    else if (arg === "--bytes") {
      const value = argv[++i];
      const parsed = Number.parseInt(value, 10);
      if (!Number.isInteger(parsed) || String(parsed) !== String(value) || parsed < 1 || parsed > 1024 * 1024) fail("--bytes must be an integer between 1 and 1048576");
      out.bytes = parsed;
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write("Usage: rootbound logs [--bytes N] [--follow] [--new-only] [--json]\n");
      process.exit(0);
    } else fail(`Unknown logs option: ${arg}`);
  }
  return out;
}

async function followLog(logPath) {
  let offset = 0;
  try { offset = (await stat(logPath)).size; } catch {}
  await new Promise((resolve, reject) => {
    const watcher = watch(path.dirname(logPath), async (event, filename) => {
      if (filename && filename.toString() !== path.basename(logPath)) return;
      try {
        const info = await stat(logPath);
        if (info.size < offset) offset = 0;
        if (info.size === offset) return;
        const handle = await open(logPath, "r");
        try {
          const buffer = Buffer.alloc(info.size - offset);
          await handle.read(buffer, 0, buffer.length, offset);
          offset = info.size;
          process.stdout.write(buffer);
        } finally { await handle.close(); }
      } catch (error) { if (error?.code !== "ENOENT") reject(error); }
    });
    const stop = () => { watcher.close(); resolve(); };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    watcher.once("error", reject);
  });
}

function fail(message) {
  process.stderr.write(`Rootbound logs: ${message}\n`);
  process.exit(2);
}
