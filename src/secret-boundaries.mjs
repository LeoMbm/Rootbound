import path from "node:path";
import { CodexlessToolError } from "./tool-errors.mjs";

const SECRET_FLAG = /^(?:--?|\/)(?:api[-_]?key|apikey|token|access[-_]?token|refresh[-_]?token|secret|client[-_]?secret|password|passwd|authorization|auth|cookie|private[-_]?key)(?:=(.*))?$/i;
const SECRET_VALUE = /^(?:sk|rk|pk)-[A-Za-z0-9_-]{12,}$|^gh[pousr]_[A-Za-z0-9_]{20,}$|^github_pat_[A-Za-z0-9_]{20,}$|^xox[baprs]-[A-Za-z0-9-]{10,}$|^[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}$/;
const AUTH_HEADER = /^(?:authorization\s*:\s*)?(?:bearer|basic)\s+\S+/i;
const SECRET_ASSIGNMENT = /^(?:api[-_]?key|apikey|token|access[-_]?token|refresh[-_]?token|secret|client[-_]?secret|password|passwd|authorization|auth|cookie|private[-_]?key)=.+$/i;
const URL_CREDENTIALS = /^https?:\/\/[^/\s:@]+:[^/\s@]+@/i;
const URL_SECRET_QUERY = /[?&](?:token|key|api_key|apikey|auth|authorization|sig|signature|secret|password)=[^&\s]+/i;
const SENSITIVE_BASENAMES = new Set([
  ".env", "credentials", "credentials.json", "secrets", "secrets.json", "id_rsa", "id_ed25519", "id_ecdsa", "id_dsa",
]);

export function inspectSensitiveArgv(command) {
  if (!Array.isArray(command)) return [];
  const findings = [];
  for (let index = 0; index < command.length; index += 1) {
    const value = String(command[index] ?? "");
    const flag = value.match(SECRET_FLAG);
    if (flag) {
      if (flag[1] !== undefined) findings.push({ index, kind: "secret-flag-inline" });
      else if (index + 1 < command.length) findings.push({ index: index + 1, kind: "secret-flag-value" });
      continue;
    }
    if (SECRET_ASSIGNMENT.test(value)) findings.push({ index, kind: "secret-assignment" });
    else if (URL_CREDENTIALS.test(value)) findings.push({ index, kind: "url-credentials" });
    else if (URL_SECRET_QUERY.test(value)) findings.push({ index, kind: "url-secret-query" });
    else if (SECRET_VALUE.test(value) || AUTH_HEADER.test(value)) findings.push({ index, kind: "secret-value" });
  }
  return dedupe(findings);
}

export function assertDurableCommandHasNoSecrets(command) {
  const findings = inspectSensitiveArgv(command);
  if (!findings.length) return;
  throw new CodexlessToolError("Codexless refuses to persist a long-running command whose argv appears to contain credentials or secrets.", {
    code: "SECRET_PERSISTENCE_BLOCKED",
    category: "safety",
    retryable: false,
    nextActions: [
      "Configure the credential in the local environment/tooling instead of placing it in command argv.",
      "Use a short non-persisted command_exec only when exposing the secret in argv is explicitly acceptable.",
    ],
    details: { redactedCommand: redactArgv(command), sensitiveArgumentCount: findings.length },
  });
}

export function redactArgv(command) {
  if (!Array.isArray(command)) return [];
  const output = command.map((value) => String(value));
  for (const finding of inspectSensitiveArgv(output)) {
    const value = output[finding.index];
    if (finding.kind === "secret-flag-inline" || finding.kind === "secret-assignment") {
      const equal = value.indexOf("=");
      output[finding.index] = equal >= 0 ? `${value.slice(0, equal + 1)}<redacted>` : "<redacted>";
    } else output[finding.index] = "<redacted>";
  }
  return output;
}

export function summarizeRedactedArgv(command, maxChars = 512) {
  const joined = redactArgv(command).join(" ").replace(/\s+/g, " ").trim();
  return joined.length > maxChars ? `${joined.slice(0, Math.max(0, maxChars - 3))}...` : joined;
}

export function isSensitivePath(value) {
  const basename = path.basename(String(value ?? "")).toLowerCase();
  if (SENSITIVE_BASENAMES.has(basename)) return true;
  if (basename.startsWith(".env.")) return true;
  if (/\.(?:pem|key|p12|pfx|jks|keystore)$/i.test(basename)) return true;
  if (/(?:credential|secret|private[-_]?key)/i.test(basename)) return true;
  return false;
}

function dedupe(rows) {
  const seen = new Set();
  return rows.filter((row) => {
    const key = `${row.index}:${row.kind}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
