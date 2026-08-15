import process from "node:process";

const mode = (process.argv[2] ?? "").toLowerCase();
if (!new Set(["http", "stdio"]).has(mode)) {
  process.stderr.write("Usage: node scripts/launch.mjs <http|stdio>\n");
  process.exit(2);
}

const supportedPlatform = process.platform === "win32" || (process.platform === "darwin" && process.arch === "arm64");
if (!supportedPlatform) {
  process.stderr.write(`Codexless Technical Preview currently supports Windows and Apple Silicon macOS only. Current: ${process.platform}/${process.arch}\n`);
  process.exit(1);
}

const nodeMajor = Number.parseInt(process.versions.node.split(".")[0], 10);
if (!Number.isInteger(nodeMajor) || nodeMajor < 22) {
  process.stderr.write(`Codexless requires Node.js 22+. Current: ${process.version}\n`);
  process.exit(1);
}

await import(mode === "http" ? "../src/mcp-http.mjs" : "../src/mcp-stdio.mjs");
