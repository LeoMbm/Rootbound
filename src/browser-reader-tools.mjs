import { createRequire } from "node:module";
import { typedToolResponse } from "./tool-errors.mjs";

const require = createRequire(import.meta.url);
const z = require("zod/v4");

export function registerBrowserReaderTools(server, browser) {
  if (!browser) return;

  server.registerTool(
    "codex.browser_status",
    {
      title: "Check Existing-Login Chrome Browser",
      description:
        "Read-only Browser Reader diagnostics. Check whether the current Codex Chrome Skill, node_repl body, and connected Chrome extension/backend are available. This starts no Codex model turn and inspects no page content.",
      inputSchema: z.object({
        cwd: z.string().min(1).max(32_768).optional()
          .describe("Optional project cwd used only to resolve the current Codex Skill/MCP context; it is not browser navigation or a permission selector."),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (input) => typedToolResponse(() => browser.status(input), { operation: "browser_status" })
  );

  server.registerTool(
    "codex.browser_tabs",
    {
      title: "List Existing Chrome Tabs",
      description:
        "Read-only Browser Reader. List tabs already open in the user's connected Chrome session and return opaque tabRef values plus visible title/url/lastOpened. It does not open, navigate, click, submit, or modify tabs.",
      inputSchema: z.object({
        cwd: z.string().min(1).max(32_768).optional()
          .describe("Optional project cwd used to resolve the current Codex Browser runtime; it does not choose a browser profile or widen authority."),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (input) => typedToolResponse(() => browser.listTabs(input), { operation: "browser_tabs" })
  );

  server.registerTool(
    "codex.browser_read",
    {
      title: "Read Existing Chrome Tab",
      description:
        "Read-only Browser Reader. Read a DOM snapshot from exactly one existing tabRef. The response reports original/returned snapshot size and truncation, and explicitly notes that lazy/virtualized content absent from the loaded DOM may not be visible. No click, fill, navigation, new-tab, or Computer Use actions exist on this public surface.",
      inputSchema: z.object({
        tabRef: z.string().min(1).max(256)
          .describe("Opaque tab reference returned by codex.browser_tabs. Raw Chrome/provider tab IDs are not accepted."),
        cwd: z.string().min(1).max(32_768).optional()
          .describe("Optional project cwd used to resolve the current Codex Browser runtime; it is not a navigation target or permission selector."),
        maxChars: z.number().int().min(1_000).max(200_000).default(80_000)
          .describe("Maximum DOM snapshot characters returned. Codexless reports original and returned character counts plus truncation."),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (input) => typedToolResponse(() => browser.readTab(input), { operation: "browser_read" })
  );
}
