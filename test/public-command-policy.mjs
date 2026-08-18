import assert from "node:assert/strict";
import { assertNoNestedCodexInvocation, nestedCodexInvocationReason } from "../src/public-command-policy.mjs";

const configuredWindowsCodex = "C:\\Pinned\\codex.exe";

const blocked = [
  [["codex", "--version"], "direct-codex-executable"],
  [["C:\\Pinned\\codex.exe", "exec", "probe"], "direct-codex-executable"],
  [["cmd.exe", "/d", "/s", "/c", "codex exec probe"], "codex-via-cmd"],
  [["powershell.exe", "-NoProfile", "-Command", "& 'C:\\Pinned\\codex.exe' exec probe"], "codex-via-powershell"],
  [["bash", "-lc", "/Applications/ChatGPT.app/Contents/Resources/codex exec probe"], "codex-via-bash"],
  [["node", "-e", "require('node:child_process').spawnSync('codex',['exec','probe'])"], "codex-via-node"],
  [["node", "-p", "require('node:child_process').spawnSync('codex',['exec','probe'])"], "codex-via-node"],
  [["node", "--print", "require('node:child_process').spawnSync('codex',['exec','probe'])"], "codex-via-node"],
  [["deno", "eval", "new Deno.Command('codex',{args:['exec','probe']}).outputSync()"], "codex-via-deno"],
  [["python3", "-c", "import subprocess; subprocess.run(['codex','exec','probe'])"], "codex-via-python3"],
  [["sudo", "codex", "exec", "probe"], "codex-via-sudo"],
  [["wsl.exe", "codex", "exec", "probe"], "codex-via-wsl"],
  [["npx", "codex", "exec", "probe"], "codex-via-npx"],
  [["env", "codex", "exec", "probe"], "codex-via-env"],
];

for (const [command, reason] of blocked) {
  assert.equal(nestedCodexInvocationReason(command, { codexBin: configuredWindowsCodex }), reason, JSON.stringify(command));
  assert.throws(
    () => assertNoNestedCodexInvocation(command, { codexBin: configuredWindowsCodex }),
    (error) => error?.code === "CODEX_MODEL_LANE_DISABLED" && /ChatGPT-only|no Codex model/i.test(error?.message ?? ""),
    JSON.stringify(command)
  );
}

const allowed = [
  ["rg", "codex", "src"],
  ["git", "grep", "codex"],
  ["where.exe", "codex"],
  ["which", "codex"],
  ["node", "test/public-contract.mjs"],
  ["node", "-p", "1 + 1"],
  ["deno", "eval", "console.log('codexless')"],
  ["sudo", "echo", "ok"],
  ["wsl.exe", "echo", "ok"],
  ["npm", "test"],
  ["cmd.exe", "/d", "/s", "/c", "echo codexless"],
  ["powershell.exe", "-NoProfile", "-Command", "Write-Output 'codexless'"],
];

for (const command of allowed) {
  assert.equal(nestedCodexInvocationReason(command, { codexBin: configuredWindowsCodex }), null, JSON.stringify(command));
  assert.doesNotThrow(() => assertNoNestedCodexInvocation(command, { codexBin: configuredWindowsCodex }), JSON.stringify(command));
}

console.log("public command nested-Codex guard PASS");
