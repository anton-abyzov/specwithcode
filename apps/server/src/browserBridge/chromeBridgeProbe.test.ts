import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import {
  CHECK_CALLS,
  callBrowserMcp,
  classifyBrowserCheck,
  parseConnectedBrowsers,
} from "./chromeBridgeProbe.ts";

const NOT_CONNECTED =
  "Browser extension is not connected. Please ensure the Claude browser extension is installed and running (https://claude.ai/chrome), and that you are logged into claude.ai with the same account as Claude Code.";

let dir: string;
beforeEach(async () => {
  dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "chrome-bridge-"));
});
afterEach(async () => {
  await NodeFSP.rm(dir, { recursive: true, force: true });
});

/** A stand-in for `claude --claude-in-chrome-mcp` that answers each tool from a table. */
async function fakeServer(answers: Record<string, string>, { hang = false } = {}) {
  const script = NodePath.join(dir, "fake-mcp.mjs");
  await NodeFSP.writeFile(
    script,
    `const answers = ${JSON.stringify(answers)};
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf("\\n")) >= 0) {
    const message = JSON.parse(buffer.slice(0, i));
    buffer = buffer.slice(i + 1);
    if (${hang}) continue;
    if (message.method === "initialize")
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { serverInfo: { name: "Claude in Chrome" } } }) + "\\n");
    if (message.method === "tools/call")
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: answers[message.params.name] ?? "" }] } }) + "\\n");
  }
});`,
  );
  return { command: process.execPath, args: [script], env: process.env };
}

describe("browser MCP check", () => {
  it("reports the extension as not connected with the server's own words", async () => {
    const command = await fakeServer({
      list_connected_browsers: "[]",
      tabs_context_mcp: NOT_CONNECTED,
    });
    const check = classifyBrowserCheck(
      await callBrowserMcp(command, CHECK_CALLS, 5000),
      "2026-10-16T00:00:00.000Z",
      12,
    );
    expect(check).toMatchObject({ state: "not_connected", browsers: [], message: NOT_CONNECTED });
  });
  it("reports connected browsers and the agents' tabs", async () => {
    const command = await fakeServer({
      list_connected_browsers: JSON.stringify([
        {
          deviceId: "d1",
          name: "SpecWithCode",
          platform: "macOS",
          onThisComputer: true,
          inUse: true,
        },
      ]),
      tabs_context_mcp: JSON.stringify({ availableTabs: [{ tabId: 1 }, { tabId: 2 }] }),
    });
    const check = classifyBrowserCheck(await callBrowserMcp(command, CHECK_CALLS, 5000), "t", 1);
    expect(check.state).toBe("connected");
    expect(check.tabCount).toBe(2);
    expect(check.browsers).toEqual([
      {
        name: "SpecWithCode",
        deviceId: "d1",
        platform: "macOS",
        onThisComputer: true,
        inUse: true,
      },
    ]);
  });
  it("asks for a choice when several browsers are connected", async () => {
    const command = await fakeServer({
      list_connected_browsers: JSON.stringify([{ name: "Work" }, { name: "Personal" }]),
      tabs_context_mcp: "Multiple browsers are connected and none is selected. Use select_browser.",
    });
    const check = classifyBrowserCheck(await callBrowserMcp(command, CHECK_CALLS, 5000), "t", 1);
    expect(check.state).toBe("choose_browser");
    expect(check.browsers.map((b) => b.name)).toEqual(["Work", "Personal"]);
  });
  it("names a missing Claude Code and a server that never answers", async () => {
    const missing = await callBrowserMcp(
      { command: NodePath.join(dir, "no-such-claude"), args: [], env: process.env },
      CHECK_CALLS,
      5000,
    );
    expect(classifyBrowserCheck(missing, "t", 1).state).toBe("cli_missing");
    const hung = await callBrowserMcp(await fakeServer({}, { hang: true }), CHECK_CALLS, 300);
    expect(classifyBrowserCheck(hung, "t", 1).state).toBe("timeout");
  });
  it("reads Claude Code's answer when two browsers wait for a choice", () => {
    // Shape captured from Claude Code on October 25, 2026, with neutral ids.
    const browsers = `${JSON.stringify([
      { deviceId: "device-1", name: "Browser 1", osPlatform: "macOS", isLocal: true },
      { deviceId: "device-2", name: "Browser 2", osPlatform: "macOS", isLocal: false },
    ])}\n2 browsers are connected and none is selected for this session. Before any browser action, you MUST call the AskUserQuestion tool.`;
    const tabs =
      "Multiple Chrome browsers are connected to this account and none has been selected for this session. If the user picks a specific browser, call select_browser with that browser's deviceId.";
    const check = classifyBrowserCheck({ ok: true, texts: [browsers, tabs] }, "t", 1);
    expect(check.state).toBe("choose_browser");
    expect(check.browsers).toEqual([
      { name: "Browser 1", deviceId: "device-1", platform: "macOS", onThisComputer: true },
      { name: "Browser 2", deviceId: "device-2", platform: "macOS", onThisComputer: false },
    ]);
  });
  it("ignores browser lists it does not understand", () => {
    expect(parseConnectedBrowsers("not json")).toEqual([]);
    expect(parseConnectedBrowsers(JSON.stringify({ browsers: [{ displayName: "A" }, 3] }))).toEqual(
      [{ name: "A" }],
    );
  });
});
