#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveRootboundPaths } from "../src/state-paths.mjs";
import { withRuntimeMutationLock } from "../src/runtime-mutation-lock.mjs";

const binDir = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const command = args[0] ?? "help";
const runtimeMutations = new Set(["connect", "start", "stop"]);

if (command === "help" || command === "--help" || command === "-h") {
  printHelp();
} else if (command === "self-test") {
  const forwarded = args.slice(1);
  if (!forwarded.includes("--cwd") && forwarded[0] && !forwarded[0].startsWith("-")) {
    const project = forwarded.shift();
    forwarded.unshift("--cwd", project);
  }
  process.exitCode = await runScript("self-test.mjs", forwarded);
} else if (command === "upgrade") {
  process.exitCode = await runScript("upgrade.mjs", args.slice(1));
} else if (command === "diagnostic" || command === "diagnostics") {
  process.exitCode = await runScript("diagnostic.mjs", args.slice(1));
} else if (command === "tunnel") {
  process.exitCode = await runScript("tunnel-config-cli.mjs", args.slice(1));
} else if (command === "connection") {
  process.exitCode = await runScript("connection-cli.mjs", args.slice(1));
} else if (runtimeMutations.has(command)) {
  await withRuntimeMutationLock(resolveRootboundPaths(), () => import("./rootbound.mjs"));
} else {
  await import("./rootbound.mjs");
}

async function runScript(scriptName, forwarded) {
  const child = spawn(process.execPath, [path.join(binDir, "..", "scripts", scriptName), ...forwarded], {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
    windowsHide: true,
  });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
}

function printHelp() {
  process.stdout.write(`Rootbound V5\n\nUsage:\n  rootbound connect [path] [--yes] [--no-start] [--json]\n  rootbound start [path] [--json]\n  rootbound status [path] [--json]\n  rootbound connection list [--json]\n  rootbound connection current [--json]\n  rootbound connection add <name>\n  rootbound connection switch <name-or-id> [--json]\n  rootbound project list [--json]\n  rootbound project remove <project-ref-or-path> [--remove-trust] [--json]\n  rootbound trust remove <path> [--json]\n  rootbound doctor [path] [--json]\n  rootbound self-test [path] [--json]\n  rootbound logs [--bytes N] [--follow] [--json]\n  rootbound diagnostic [--output file] [--json]\n  rootbound tunnel configure --argv-json '<json argv>'\n  rootbound tunnel configure -- <argv...>\n  rootbound tunnel show [--json]\n  rootbound tunnel clear [--json]\n  rootbound stop [--force] [--json]\n  rootbound upgrade --from <release-directory> [--json]\n  rootbound version\n\nTrust is exact-root and explicit. Persistent tunnel config refuses literal credentials; use {env:VARIABLE} placeholders for secrets. No Codex model is started by self-test or the public model-free tool surface.\n`);
}
