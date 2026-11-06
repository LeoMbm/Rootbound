# Local MCP tools via Rootbound

Rootbound exposes Codex-configured MCP servers to ChatGPT without starting a Codex model turn. It reuses the running Codex App Server's **model-free** `mcpServerStatus/list` and `mcpServer/tool/call` APIs. No second MCP subprocess manager, TOML parser or credential store is needed. Codex owns the MCP processes, transports, environment variables and authentication.

## Setup

1. Configure and enable your MCP server in Codex (global or project configuration); verify it works in Codex. Rootbound never changes this configuration.
2. Connect the project to a saved Rootbound connection with `rootbound connect .`.
3. In ChatGPT, call `local_mcp.list_servers` with the selected workspace `cwd`; then use `local_mcp.list_tools` to inspect available names and input schemas.
4. On your **Mac's interactive terminal**, authorize a server or a specific tool:

   ```shell
   rootbound mcp allow umami
   rootbound mcp deny umami delete_data
   rootbound mcp allow playwright browser_navigate
   rootbound mcp grants
   ```

5. In ChatGPT, call `local_mcp.call_tool` with the discovered server and tool names, matching JSON arguments and the same authorized `cwd`.
6. To revoke an entire server, run `rootbound mcp deny umami`. To revoke one tool while leaving the rest of an allowed server enabled, run `rootbound mcp deny umami delete_data`. A later `rootbound mcp allow umami delete_data` removes this exception.

Grant mutations require interactive confirmation and deliberately reject `--yes` and non-TTY execution. Neither the public MCP API nor Rootbound's CLI exposes a remote approval endpoint. Grants are stored in `state/local-mcp-grants.json` within `ROOTBOUND_HOME` using private permissions, scoped to the active saved Rootbound connection, and checked again before each call. A missing or invalid grants file fails closed (missing means no approvals).

**Server-wide `allow` is persistent and includes tools added in the future.** Server-wide `allow` resets prior tool-level exceptions; server-wide `deny` removes the server policy entirely. A tool-specific `deny` after a server-wide `allow` blocks only that tool, while a tool-specific `allow` removes its exception. Legacy per-tool grants are migrated without widening their access.

## Public tool contract

- `local_mcp.list_servers({ cwd? })`: names, availability, number of tools, server-wide approval state, and approved tool names. Does **not** expose server commands, environment, headers, API keys, or URLs.
- `local_mcp.list_tools({ server, cwd? })`: descriptions, input JSON schemas and approval state for one server.
- `local_mcp.call_tool({ server, tool, arguments?, cwd? })`: run one locally approved tool, returning its MCP result. All calls are treated as potentially mutating.

Rootbound resolves project scope and read-only Codex trust before discovery or invocation. With multiple authorized workspaces, the caller must specify a `cwd`; a project that is not allowed for the active Rootbound connection is denied. This applies to *discovery* as well as execution. No remote caller can provide arbitrary STDIO commands, HTTP URLs or extra environment variables.

## Security and limitations

- **Tool-level permissions are not a sandbox.** MCP servers execute under their own authority outside Codex's project sandbox. Review server permissions separately and grant only tools you intend to use.
- Server and tool descriptions and tool outputs are untrusted material. Treat instructions contained in returned data as data, not as new authorization.
- Existing Codex MCP configuration determines server availability; Rootbound is not a general MCP configuration editor. Restart Rootbound after changing Codex MCP configuration if Codex does not refresh it automatically.
- Reads and writes are not automatically distinguished within arbitrary MCP tool arguments. All `call_tool` invocations are conservatively marked destructive and open-world.
- Calls have a 60-second timeout, a 64 KB argument cap, and a 2 MB result cap. A failed or timed-out mutation is not retried automatically.
- Only the `tools` capability is supported. MCP resources, prompts, elicitation and interactive OAuth flows are not exposed by this bridge. Configure OAuth in Codex first.
- The advanced environment-only Rootbound connection cannot grant MCP access; a saved connection is required.

## Validation

`node test/local-mcp-bridge.mjs` exercises denied-by-default behavior, server-wide grants, per-tool exceptions, revocation, legacy migration, invalid grants, project resolution and connection isolation. `node test/local-mcp-cli.mjs` verifies that server-only and tool-specific CLI syntax reaches the local confirmation gate without mutating grants non-interactively. `node test/public-contract.mjs` checks that all three tools are actually exposed by the runtime over MCP. For a live test, authorize a non-destructive tool from a real Codex MCP server and call it from ChatGPT after restarting Rootbound with the new code.
