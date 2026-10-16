/**
 * Talks to Claude Code's built-in browser MCP server (`claude
 * --claude-in-chrome-mcp`) the way an agent would, without a model: start it,
 * call a read-only tool or two, stop it. This is the round trip that fails
 * with "Browser extension is not connected" when Chrome is unreachable.
 */
// @effect-diagnostics-next-line nodeBuiltinImport:off - the MCP server needs a live stdin/stdout pipe for line-delimited JSON-RPC.
import * as NodeChildProcess from "node:child_process";
import type { BrowserBridgeBrowser, BrowserBridgeCheck } from "@specweave-studio/contracts";

export const BROWSER_MCP_FLAG = "--claude-in-chrome-mcp";

export interface BrowserMcpCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env: NodeJS.ProcessEnv;
}

export interface BrowserMcpToolCall {
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

export type BrowserMcpOutcome =
  | { readonly ok: true; readonly texts: ReadonlyArray<string> }
  | {
      readonly ok: false;
      readonly failure: "cli_missing" | "timeout" | "error";
      readonly message: string;
    };

const toolText = (result: unknown): string => {
  const content = (result as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      part && typeof part === "object" && (part as { type?: unknown }).type === "text"
        ? String((part as { text?: unknown }).text ?? "")
        : "",
    )
    .join("\n");
};

/** Run the calls in order over one short-lived server; stops it however the calls end. */
export function callBrowserMcp(
  command: BrowserMcpCommand,
  calls: ReadonlyArray<BrowserMcpToolCall>,
  timeoutMs: number,
): Promise<BrowserMcpOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    let buffer = "";
    let stderr = "";
    const texts: string[] = [];
    const child = NodeChildProcess.spawn(command.command, [...command.args], {
      env: command.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const finish = (outcome: BrowserMcpOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdin.end();
      child.kill();
      resolve(outcome);
    };
    // @effect-diagnostics-next-line globalTimers:off - bounds a plain Promise that owns the child process.
    const timer = setTimeout(
      () =>
        finish({
          ok: false,
          failure: "timeout",
          message: "Claude Code's browser server did not answer.",
        }),
      timeoutMs,
    );
    const send = (message: unknown) => {
      if (!child.stdin.destroyed) child.stdin.write(`${JSON.stringify(message)}\n`);
    };
    const callAt = (index: number) => {
      const call = calls[index];
      if (!call) return finish({ ok: true, texts });
      send({ jsonrpc: "2.0", id: 10 + index, method: "tools/call", params: call });
    };
    child.on("error", (error: NodeJS.ErrnoException) =>
      finish({
        ok: false,
        failure: error.code === "ENOENT" ? "cli_missing" : "error",
        message:
          error.code === "ENOENT" ? "Claude Code is not installed on this machine." : error.message,
      }),
    );
    child.on("exit", () =>
      finish({
        ok: false,
        failure: "error",
        message: stderr.trim().split("\n").at(-1) || "Claude Code's browser server stopped early.",
      }),
    );
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-4000);
    });
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (!line) continue;
        let message: { id?: unknown; result?: unknown; error?: { message?: unknown } };
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.id === 1) {
          send({ jsonrpc: "2.0", method: "notifications/initialized" });
          callAt(0);
        } else if (typeof message.id === "number" && message.id >= 10) {
          texts.push(
            message.error
              ? String(message.error.message ?? "Tool call failed.")
              : toolText(message.result),
          );
          callAt(message.id - 9);
        }
      }
    });
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "specwithcode-browser-check", version: "1" },
      },
    });
  });
}

const NOT_CONNECTED = /extension is not connected|not connected to chrome|no browser.*connected/i;
const CHOOSE_BROWSER =
  /several browsers|multiple browsers|more than one browser|select_browser|which browser/i;

/** Browsers from `list_connected_browsers`, whose text is a JSON array; unknown shapes yield none. */
export function parseConnectedBrowsers(text: string): BrowserBridgeBrowser[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  const list = Array.isArray(data)
    ? data
    : Array.isArray((data as { browsers?: unknown } | null)?.browsers)
      ? (data as { browsers: unknown[] }).browsers
      : [];
  return list.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const value = entry as Record<string, unknown>;
    const name =
      typeof value.name === "string"
        ? value.name
        : typeof value.displayName === "string"
          ? value.displayName
          : null;
    if (!name) return [];
    return [
      {
        name,
        ...(typeof value.deviceId === "string" ? { deviceId: value.deviceId } : {}),
        ...(typeof value.platform === "string" ? { platform: value.platform } : {}),
        ...(typeof value.onThisComputer === "boolean"
          ? { onThisComputer: value.onThisComputer }
          : {}),
        ...(typeof value.inUse === "boolean" ? { inUse: value.inUse } : {}),
      },
    ];
  });
}

/** Tabs in the agents' group, when the text is JSON that lists them. */
function parseTabCount(text: string): number | undefined {
  try {
    const data = JSON.parse(text) as Record<string, unknown>;
    for (const key of ["availableTabs", "tabs"]) {
      if (Array.isArray(data[key])) return (data[key] as unknown[]).length;
    }
  } catch {
    // Plain-text answers carry no count.
  }
  return undefined;
}

/** Read the two answers of a check into one state the UI can explain. */
export function classifyBrowserCheck(
  outcome: BrowserMcpOutcome,
  checkedAt: string,
  durationMs: number,
): BrowserBridgeCheck {
  if (!outcome.ok)
    return {
      state: outcome.failure,
      browsers: [],
      message: outcome.message,
      checkedAt,
      durationMs,
    };
  // A reconnect answers switch_browser first; the check's two answers are always last.
  const [browsersText = "", tabsText = ""] = outcome.texts.slice(-2);
  const browsers = parseConnectedBrowsers(browsersText);
  const base = { browsers, checkedAt, durationMs };
  if (NOT_CONNECTED.test(tabsText)) return { ...base, state: "not_connected", message: tabsText };
  if (CHOOSE_BROWSER.test(tabsText)) return { ...base, state: "choose_browser", message: tabsText };
  if (tabsText.trim() === "")
    return { ...base, state: "error", message: "Chrome did not describe its tabs." };
  const tabCount = parseTabCount(tabsText);
  return { ...base, state: "connected", ...(tabCount === undefined ? {} : { tabCount }) };
}

/** The read-only calls a check makes: who is connected, then the agents' tab group without creating it. */
export const CHECK_CALLS: ReadonlyArray<BrowserMcpToolCall> = [
  { name: "list_connected_browsers", arguments: {} },
  { name: "tabs_context_mcp", arguments: { createIfEmpty: false } },
];

/** Shows Connect in every Chrome with the extension; the server waits up to two minutes. */
export const RECONNECT_CALLS: ReadonlyArray<BrowserMcpToolCall> = [
  { name: "switch_browser", arguments: {} },
  ...CHECK_CALLS,
];
