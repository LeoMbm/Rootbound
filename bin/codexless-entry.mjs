#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const binDir = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const command = args[0] ?? "help";

if (command === "self-test") {
  const forwarded = args.slice(1);
  if (!forwarded.includes("--cwd") && forwarded[0] && !forwarded[0].startsWith("-")) {
    const project = forwarded.shift();
    forwarded.unshift("--cwd", project);
  }
  process.exitCode = await runScript("self-test.mjs", forwarded);
} else if (command === "upgrade") {
  process.exitCode = await runScript("upgrade.mjs", args.slice(1));
} else {
  await import("./codexless.mjs");
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
