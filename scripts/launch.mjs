import process from "node:process";

const mode = (process.argv[2] ?? "").toLowerCase();
if (!new Set(["http", "stdio"]).has(mode)) {
  process.stderr.write("Usage: node scripts/launch.mjs <http|stdio>\n");
  process.exit(2);
}

const supportedPlatform = process.platform === "win32" || (process.platform === "darwin" && process.arch === "arm64");
if (!supportedPlatform) {
  process.stderr.write(`Rootbound Technical Preview currently supports Windows and Apple Silicon macOS only. Current: ${process.platform}/${process.arch}\n`);
  process.exit(1);
}

const [nodeMajor, nodeMinor] = process.versions.node.split(".").map((value) => Number.parseInt(value, 10));
const supportedNode = Number.isInteger(nodeMajor) && Number.isInteger(nodeMinor) && (nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 13));
if (!supportedNode) {
  process.stderr.write(`Rootbound V5 requires Node.js 22.13+. Current: ${process.version}\n`);
  process.exit(1);
}

await import(mode === "http" ? "../src/mcp-http.mjs" : "../src/mcp-stdio.mjs");
