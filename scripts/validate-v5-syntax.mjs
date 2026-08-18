import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "..");
const roots = ["src", "scripts", "bin", "test"];
const files = [];
for (const relative of roots) await collect(path.join(root, relative));
files.sort();

let failed = 0;
for (const file of files) {
  const exitCode = await check(file);
  if (exitCode !== 0) failed += 1;
}

if (failed) {
  process.stderr.write(`V5 syntax check failed for ${failed}/${files.length} files.\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`V5 syntax check PASS (${files.length} JavaScript files).\n`);
}

async function collect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) await collect(full);
    else if (entry.isFile() && /\.(?:mjs|js)$/.test(entry.name)) files.push(full);
  }
}

async function check(file) {
  const child = spawn(process.execPath, ["--check", file], {
    cwd: root,
    env: process.env,
    stdio: ["ignore", "inherit", "inherit"],
    windowsHide: true,
    shell: false,
  });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
}
