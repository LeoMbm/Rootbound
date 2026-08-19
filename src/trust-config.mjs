import os from "node:os";
import path from "node:path";
import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";

export function resolveCodexConfigPath({ env = process.env, home = os.homedir() } = {}) {
  if (typeof env.CODEX_HOME === "string" && env.CODEX_HOME.trim()) return path.join(path.resolve(env.CODEX_HOME.trim()), "config.toml");
  return path.join(home, ".codex", "config.toml");
}

export function hasExactTrustedProject(text, root) {
  const escaped = root.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  const header = `[projects."${escaped}"]`;
  const start = text.indexOf(header);
  if (start < 0) return false;
  const rest = text.slice(start + header.length);
  const next = rest.search(/^\s*\[/m);
  const block = next >= 0 ? rest.slice(0, next) : rest;
  return /(?:^|\n)\s*trust_level\s*=\s*["']trusted["']\s*(?:#.*)?(?:\n|$)/.test(block);
}

export async function ensureExactProjectTrust(root, { configPath = resolveCodexConfigPath(), backupsDir, now = Date.now() } = {}) {
  if (!backupsDir) throw new Error("ensureExactProjectTrust requires backupsDir");
  await mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 });
  await mkdir(backupsDir, { recursive: true, mode: 0o700 });
  let original = "";
  try { original = await readFile(configPath, "utf8"); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  if (hasExactTrustedProject(original, root)) return { changed: false, configPath, backupPath: null };

  const stamp = new Date(now).toISOString().replaceAll(":", "-");
  const backupPath = path.join(backupsDir, `codex-config-${stamp}.toml`);
  if (original) await copyFile(configPath, backupPath);
  else await writeFile(backupPath, "", { mode: 0o600 });

  const escaped = root.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  const addition = `${original.endsWith("\n") || original.length === 0 ? "" : "\n"}\n[projects."${escaped}"]\ntrust_level = "trusted"\n`;
  const temp = `${configPath}.rootbound-${process.pid}.tmp`;
  await writeFile(temp, original + addition, { mode: 0o600 });
  await rename(temp, configPath);
  return { changed: true, configPath, backupPath };
}

export async function rollbackTrustConfig({ configPath, backupPath }) {
  if (!backupPath) return { rolledBack: false };
  await copyFile(backupPath, configPath);
  return { rolledBack: true, configPath, backupPath };
}
