const CODEX_EXECUTABLE_RE = /^codex(?:\.(?:exe|com|cmd|bat|ps1))?$/i;
const CODEX_COMMAND_TOKEN_RE = /(?:^|[\s"'`;&|(),])(?:[^\s"'`;&|(),]*[\\/])?codex(?:\.(?:exe|com|cmd|bat|ps1))?(?=$|[\s"'`;&|(),])/i;

const COMMAND_STRING_WRAPPERS = new Set([
  "cmd",
  "powershell",
  "pwsh",
  "sh",
  "bash",
  "zsh",
  "fish",
]);

const INLINE_CODE_WRAPPERS = new Set([
  "node",
  "nodejs",
  "python",
  "python3",
  "py",
  "ruby",
  "perl",
  "deno",
  "bun",
]);

const EXECUTABLE_LAUNCH_WRAPPERS = new Set([
  "env",
  "sudo",
  "wsl",
  "nohup",
  "timeout",
  "nice",
  "stdbuf",
  "xargs",
  "npx",
  "npm",
  "pnpm",
  "yarn",
]);

function portableBasename(value) {
  const normalized = String(value ?? "").replaceAll("\\", "/");
  const index = normalized.lastIndexOf("/");
  return (index >= 0 ? normalized.slice(index + 1) : normalized).toLowerCase();
}

function executableStem(value) {
  return portableBasename(value).replace(/\.(?:exe|com|cmd|bat|ps1)$/i, "");
}

function normalizedPortablePath(value) {
  return String(value ?? "").trim().replaceAll("\\", "/").toLowerCase();
}

function isCodexExecutableToken(value, codexBin = null) {
  const raw = String(value ?? "").trim().replace(/^['"]|['"]$/g, "");
  if (!raw) return false;
  if (CODEX_EXECUTABLE_RE.test(portableBasename(raw))) return true;
  return Boolean(codexBin && normalizedPortablePath(raw) === normalizedPortablePath(codexBin));
}

function containsCodexCommandToken(value, codexBin = null) {
  const text = String(value ?? "");
  if (CODEX_COMMAND_TOKEN_RE.test(text)) return true;
  if (!codexBin) return false;
  return normalizedPortablePath(text).includes(normalizedPortablePath(codexBin));
}

function wrapperCarriesNestedCodex(command, wrapper, codexBin) {
  const args = command.slice(1);
  if (COMMAND_STRING_WRAPPERS.has(wrapper)) {
    return args.some((arg) => containsCodexCommandToken(arg, codexBin));
  }

  if (INLINE_CODE_WRAPPERS.has(wrapper)) {
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index];
      const prior = args[index - 1];
      const inlineCode = ["-e", "--eval", "-c", "-Command", "--command", "-p", "--print"].includes(prior)
        || /^-(?:e|c|p)=/.test(arg)
        || /^--(?:eval|command|print)=/.test(arg)
        || (wrapper === "deno" && prior === "eval");
      if (inlineCode && containsCodexCommandToken(arg, codexBin)) return true;
    }
    return false;
  }

  if (EXECUTABLE_LAUNCH_WRAPPERS.has(wrapper)) {
    return args.some((arg) => isCodexExecutableToken(arg, codexBin) || containsCodexCommandToken(arg, codexBin));
  }

  return false;
}

export function nestedCodexInvocationReason(command, { codexBin = null } = {}) {
  if (!Array.isArray(command) || command.length === 0) return null;
  if (isCodexExecutableToken(command[0], codexBin)) return "direct-codex-executable";
  const wrapper = executableStem(command[0]);
  if (wrapperCarriesNestedCodex(command, wrapper, codexBin)) return `codex-via-${wrapper}`;
  return null;
}

export function assertNoNestedCodexInvocation(command, { codexBin = null } = {}) {
  const reason = nestedCodexInvocationReason(command, { codexBin });
  if (!reason) return;
  const error = new Error(
    "Codexless command_exec refuses to launch Codex CLI from the model-free command lane. " +
    "Use codex.agent_start / codex.agent_send so metered Codex work keeps its Task Card, quota state, and explicit lifecycle."
  );
  error.code = "METERED_CODEX_REQUIRES_AGENT_CARD";
  error.nextActions = [
    "Use codex.agent_start for a new formal Codex task.",
    "Use codex.agent_send only for an existing Codexless agentRef follow-up.",
    "Keep codex.command_exec for model-free local commands; do not use shell/interpreter wrappers to launch Codex.",
  ];
  error.reason = reason;
  throw error;
}
