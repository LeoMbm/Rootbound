import path from "node:path";

export function resolveTunnelLaunch({ env = process.env, packageRoot, projectRoot = null } = {}) {
  const raw = env.CODEXLESS_TUNNEL_ARGV_JSON;
  if (typeof raw !== "string" || !raw.trim()) {
    const error = new Error("Secure MCP Tunnel is not configured. Set CODEXLESS_TUNNEL_ARGV_JSON to a JSON argv array for the installed tunnel client.");
    error.code = "TUNNEL_NOT_CONFIGURED";
    throw error;
  }
  let argv;
  try { argv = JSON.parse(raw); }
  catch { throw new Error("CODEXLESS_TUNNEL_ARGV_JSON must be valid JSON"); }
  if (!Array.isArray(argv) || argv.length < 1 || !argv.every((value) => typeof value === "string" && value.length > 0)) {
    throw new Error("CODEXLESS_TUNNEL_ARGV_JSON must be a non-empty JSON array of non-empty strings");
  }
  const replacements = new Map([
    ["{node}", process.execPath],
    ["{packageRoot}", packageRoot],
    ["{launchScript}", path.join(packageRoot, "scripts", "launch.mjs")],
    ["{projectRoot}", projectRoot ?? ""],
  ]);
  const expanded = argv.map((value) => replacements.has(value) ? replacements.get(value) : value);
  if (expanded.some((value) => value === "")) throw new Error("Tunnel argv uses {projectRoot}, but no project root was supplied");
  return { command: expanded[0], args: expanded.slice(1), argv: expanded };
}
