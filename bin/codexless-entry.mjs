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
  const cwdIndex = forwarded.findIndex((value) => value === "--cwd");
  const hasExplicitCwd = cwdIndex >= 0;
  const positionals = forwarded.filter((value, index) => !value.startsWith("-") && (index === 0 || forwarded[index - 1] !== "--cwd"));
  if (!hasExplicitCwd && positionals[0]) forwarded.unshift("--cwd", positionals[0]);
  const child = spawn(process.execPath, [path.join(binDir, "..", "scripts", "self-test.mjs"), ...forwarded], {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
    windowsHide: true,
  });
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
  process.exitCode = exitCode;
} else {
  await import("./codexless.mjs");
}
