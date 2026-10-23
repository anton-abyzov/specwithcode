# Coding harnesses in SpecWithCode

A harness runs the agent loop, executes tools and owns native conversation state. A model supplies responses. A vendor supplies that model. The configured account or endpoint determines billing. An adapter translates the harness protocol into the app's sessions, events, approvals and continuation operations.

For example, Claude through Copilot uses the Copilot harness and account. Claude through Pi uses Pi's runtime and its configured model endpoint. Neither model name proves Claude Code subscription access.

## Implemented integration paths

| Harness                | Adapter path                                                | What must be verified on the destination machine                                            |
| ---------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Codex                  | Native app-server                                           | Configured executable, account, model and session access                                    |
| Claude Code            | Agent SDK                                                   | Configured CLI/SDK environment and account or API billing                                   |
| Copilot and Gemini CLI | ACP registry instances                                      | Exact agent command/registry identity, sign-in and advertised capabilities                  |
| Grok                   | ACP                                                         | Compatible executable and account                                                           |
| Cursor                 | Cursor SDK                                                  | Executable, account and compatible SDK                                                      |
| OpenCode               | Native HTTP API and event stream, separate 1.x/2.x adapters | Local CLI or configured external server, detected API generation, connected model endpoints |
| Pi                     | Native JSONL RPC plus the app's extension bridge            | Compatible CLI, successful RPC discovery, model endpoint access and extension support       |

An ACP registry entry advertises an integration candidate. It does not prove installation, authentication or support for every native feature. The app does not add DeepAgents or another Pi ACP entry merely because another product lists them.

## OpenCode

OpenCode is both a standalone alternative workbench and an integration runtime. SpecWithCode adds its cross-harness project/session orchestration around the existing OpenCode agent. This is a difference in scope, not a claim that one is universally better.

The driver probes the configured server when a server URL is set, otherwise the configured executable. It selects the matching HTTP adapter for 1.x or 2.x. The existing 1.x integration requires at least `1.14.19`. Do not force an upgrade between major versions: their protocols and storage differ. Keep native session IDs for continuation.

Use Providers settings to select the existing OpenCode instance and its executable or server. Sign in/configure models through OpenCode's own supported setup. A reachable server does not require a local executable. An external server's credentials and tools remain under its owner's control; the app does not inject its MCP server into an external 1.x server.

Model inventory, tool/image support and billing come from runtime model data. OpenCode supports local and hosted endpoints; a free catalog label is not an account balance guarantee. Per-token APIs and routers require an explicit paid choice and must not become automatic free fallbacks.

Primary references: [OpenCode server API](https://opencode.ai/docs/server/), [SDK](https://opencode.ai/docs/sdk/), [providers and credentials](https://opencode.ai/docs/providers/).

## Pi

The existing adapter speaks Pi RPC directly, rather than depending on a third-party ACP wrapper. It discovers models and commands and bridges the app's MCP/approval facilities through an extension. It preserves Pi's native session path for continuation. The current adapter requires `0.80.5` or newer for history entries and reliable terminal settlement.

A successful version command alone is not a successful agent startup. Failed or timed-out RPC discovery reports a warning with unknown authentication. It must not contribute a ready model to automatic selection. Empty model discovery gives sign-in/model setup guidance. The `default` model delegates to Pi configuration and carries unknown billing rather than implying a free subscription.

Primary references: [Pi repository](https://github.com/earendil-works/pi), [coding agent](https://github.com/earendil-works/pi/tree/main/packages/coding-agent), [RPC protocol](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md).

## Evidence snapshot, October 23, 2026

| Integration                                   | Installed app catalog                                               | Independent evidence in increment 1020                                                                                                             |
| --------------------------------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex, Claude Code, Grok, Copilot, Gemini CLI | Enabled with models and no launch constraints                       | Catalog readiness only; no new account turn in this audit                                                                                          |
| OpenCode                                      | Disabled, zero models; catalog says executable missing              | Shell executable `1.14.33`; isolated real CLI server passes launch, native bash tool, SSE deltas and continuation with a local deterministic model |
| Pi                                            | Disabled, default placeholder only; catalog says executable missing | Shell executable `0.66.1`, below adapter minimum `0.80.5`; no compatible live Pi turn claimed                                                      |
| Cursor, Antigravity                           | Disabled, zero models                                               | No new live runtime acceptance                                                                                                                     |

Disabled providers are not probed. Their `installed: false` placeholder does not establish that an executable is absent from the shell or from another machine. Provider instance identity, shell PATH and service PATH are separate facts.

The native OpenCode contract fixture uses an isolated HOME/XDG store and a synthetic local model endpoint without credentials or billing. The same isolated server is also driven through the real app adapter: native command projection, assistant messages, completed terminal events and native-session continuation in a fresh adapter session pass. The 2.x adapter advertises MCP support to match its existing per-thread MCP registration and permission isolation. Adapter replay tests separately cover 2.x registration and removal. Neither proves installed app UI acceptance, hosted model quality or subscription entitlement. Run the reproducible native check with `python3 scripts/harness-support/opencode-runtime.py /absolute/evidence/path /absolute/opencode/path /absolute/node22/path` from the app checkout.

Known limits: the installed app has not been updated by this increment. Pi has adapter/replay coverage, not a new compatible live Pi turn. OpenCode 1.x mid-session transitions to a model without tools retain an existing MCP registration; model switch policy requires a separate session-manager repair. Missing model capability fields remain unreported rather than becoming false.
