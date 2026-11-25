/**
 * Tool-search `_meta` for studio-code tools (1483).
 *
 * Claude Code loads MCP tools deferred and finds them through tool search. A
 * tool whose `_meta["anthropic/alwaysLoad"]` is true is loaded up front, so
 * its first use costs no search round trip. Only the tools where a
 * measurement showed that friction carry it (1483 `reports/tool-search.md`:
 * on Claude Code 2.1.331 each removed the ToolSearch call in 5 of 5 runs, or
 * 4 of 5 for delegate_task, and cut time to the call by 0.8-2 s), at about
 * 900 input tokens each on every request. `studio_report_save` gained
 * nothing and is left deferred. `anthropic/searchHint` is not set: tool
 * search picked every tool by its exact name, so hints did not change recall.
 * Other clients ignore the key.
 */

export const ALWAYS_LOAD_KEY = "anthropic/alwaysLoad";

/** Loaded up front in Claude threads. */
export const ALWAYS_LOAD_TOOLS: ReadonlySet<string> = new Set([
  "ask_user",
  "request_secret",
  "studio_thread_send",
  "delegate_task",
  "advisor",
]);

/** The `_meta` keys a tool is advertised with; none for most tools. */
export const toolMeta = (name: string): Readonly<Record<string, boolean>> =>
  ALWAYS_LOAD_TOOLS.has(name) ? { [ALWAYS_LOAD_KEY]: true } : {};
