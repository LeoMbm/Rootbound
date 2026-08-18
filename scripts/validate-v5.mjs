import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "..");
const checks = [
  { label: "lock metadata", command: process.execPath, args: [path.join(root, "scripts", "check-lock-root.mjs")] },
  { label: "V5 tests", command: npmCommand(), args: ["run", "test:v5"] },
  { label: "syntax", command: process.execPath, args: [path.join(root, "scripts", "validate-v5-syntax.mjs")] },
];

const results = [];
for (const check of checks) {
  const result = await run(check);
  results.push(result);
  if (!result.ok) break;
}

const ok = results.every((result) => result.ok);
process.stdout.write(`\nCodexless V5 validation: ${ok ? "PASS" : "FAIL"}\n`);
for (const result of results) process.stdout.write(`[${result.ok ? "PASS" : "FAIL"}] ${result.label}\n`);
if (!ok) {
  process.stdout.write("GitHub Actions was not triggered. Fix the local/trusted-machine validation first, then run one controlled manual Actions matrix.\n");
}
process.exitCode = ok ? 0 : 1;

async function run({ label, command, args }) {
  process.stdout.write(`\n== ${label} ==\n`);
  const child = spawn(command, args, { cwd: root, env: process.env, stdio: "inherit", windowsHide: true, shell: false });
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
  return { label, ok: exitCode === 0, exitCode };
}

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}
