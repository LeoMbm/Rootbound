import { createRequire } from "node:module";
import { createPublicRuntime } from "./public-runtime.mjs";

const require = createRequire(import.meta.url);
const { serveStdio } = require("@modelcontextprotocol/server/stdio");

const runtime = await createPublicRuntime();
const handle = serveStdio(runtime.createServer, {
  legacy: "serve",
  onerror: (error) => console.error("[codexless-mcp]", error),
});

console.error(
  `Codexless Public Preview running; defaultCwd=${runtime.authorityValidation.defaultCwd ?? runtime.defaultCwd}; ` +
  `consent=${runtime.meteredConsentMode}; surface=${runtime.surfaceVersion}; tools=${runtime.toolNames.length}`
);

let shutdownPromise = null;
function shutdown() {
  if (!shutdownPromise) {
    shutdownPromise = (async () => {
      try {
        await handle.close();
      } finally {
        await runtime.close();
      }
    })();
  }
  return shutdownPromise;
}

function shutdownAndExit() {
  void shutdown().finally(() => process.exit(0));
}

process.once("SIGINT", shutdownAndExit);
process.once("SIGTERM", shutdownAndExit);
process.stdin.once("end", shutdownAndExit);
process.stdin.once("close", shutdownAndExit);
