# Rootbound Studio: visual feedback with ChatGPT

Studio is a companion visual inspector, **not a second AI chat**. The model-free Rootbound MCP connector exposes the `studio.open` widget in ChatGPT. ChatGPT itself decides what to change; the existing Rootbound code/command tools apply those changes locally. This does not start a Codex model turn.

## Start

1. Install/run the private [Rootbound Studio](https://github.com/LeoMbm/rootbound-studio) companion on the same Mac as Rootbound: `pnpm install && pnpm exec playwright install chromium && pnpm dev`.
2. Ensure the project is authorized on the active Rootbound connection: from that directory, `rootbound connect .`. The widget will only list workspaces allowed on this connection.
3. Upgrade the **installed** Rootbound runtime with the version containing these tools; changes to a source checkout alone do not affect an already-installed connector. Restart that runtime and refresh/reconnect the Rootbound plugin in ChatGPT to update the tool catalogue.
4. In a regular ChatGPT conversation with Rootbound connected, ask: **“Open Rootbound Studio for visual feedback.”** The model invokes `studio.open` and the embedded widget appears.
5. Choose a project, enter the **local dev server URL** (e.g. `http://127.0.0.1:3000`), inspect elements, add feedback and click **Send to ChatGPT**. The widget uses the host's `sendFollowUpMessage` capability. ChatGPT can then use Rootbound's existing model-free tools.

### If ChatGPT incorrectly reports that Studio is stopped

`127.0.0.1:3877` is the **backend** port. The user-facing development UI normally runs on `5173` or the next free port. Visiting the backend root is not a valid test of the MCP integration; Studio's backend redirects that URL to Vite. The MCP integration calls the authenticated `POST /api/bridge` endpoint, and `studio.open` now probes that endpoint before reporting companion readiness.

Check the local backend state with `curl -sS http://127.0.0.1:3877/api/state` (a `200` response with `engine: "chatgpt"` confirms the service). Never paste or expose the secret bridge token. If Studio responds, but ChatGPT still cannot call `studio.open`, refresh/reconnect the existing **Rootbound ChatGPT plugin** to update its cached MCP tool list and reopen the conversation if needed. A healthy MCP server exposes the three Studio tools in addition to the original coding tools.

If the host does not expose its message bridge, the widget attempts a clipboard fallback. Standalone Studio has a separate **Copy task to ChatGPT** option; it cannot silently post to an existing conversation.

## Architecture

```text
ChatGPT regular conversation (reasoning allocation)
  ↔ UI resource ui://rootbound/studio-v1.html
  ↔ app-only MCP tools studio.projects + studio.action
  ↔ Rootbound connection-scoped project authorization
  ↔ localhost authenticated Studio bridge (127.0.0.1:3877)
  ↔ Playwright screenshot/DOM picker + SQLite notes

ChatGPT model → existing Rootbound read/edit/test tools → project files
```

The widget's project dropdown is based on `listWorkspaces` with the current connection access provider. `studio.action` validates the projectRef again **on every call**, before proxying. Neither the widget nor the model can supply a raw project root to widen this authorization.

The companion stores a random 256-bit bridge token at `~/.rootbound-studio/mcp-bridge-token` (mode 0600). Rootbound reads it when calling the companion, never returns it to the widget and only sends it over loopback HTTP. The local endpoint can be overridden using `ROOTBOUND_STUDIO_URL=http://127.0.0.1:PORT` on the Rootbound runtime. Non-loopback origins and redirects are rejected.

`studio.open` is model-visible only to open the widget; `studio.projects` and `studio.action` are private, widget-only tools. They may show in raw MCP tool enumeration, but are annotated with `ui.visibility: ["app"]`. All widget actions are model-free; screenshots may be large and are returned only to the widget's tool call. User-authored notes are the sole content sent as a follow-up.

## Known constraints

- Studio must be running locally while the ChatGPT widget is used. Its port 3877 is independent of Vite's flexible 5173+ frontend port.
- The embedded preview is a rendered image; it supports selecting DOM-backed elements, not internal shapes within canvas/WebGL.
- The preview deliberately accepts only loopback HTTP addresses. Do not inspect a local development page containing secrets you wouldn't want in screenshots.
- The widget and ChatGPT conversation are separate UI lifecycles. The **Send to ChatGPT** action posts a new user message; it does not read the existing conversation or expose a ChatGPT model API to the standalone Studio window.
- Rootbound's underlying model-free Codex App Server permission/sandbox primitives remain in use for code execution. Those do not consume a Codex **model** turn; they are not an independent agent.
- These tools require refreshing the existing custom MCP connection; they will not appear in ChatGPT until the installed runtime and connector snapshot have been updated.
