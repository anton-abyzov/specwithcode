// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off -- a fake extension for the plain relay hub.
/** A paired Chrome profile that answers the way the SpecWithCode Browser extension would. */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { makeBrowserExtension } from "./BrowserExtension.ts";
import type { RelaySocket } from "./relayHub.ts";

export const PNG_1x1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

export interface FakeChrome {
  readonly calls: Array<{ method: string; params: unknown[] }>;
  readonly closed: Array<{ code: number; reason: string }>;
  readonly session: { receive: (text: string) => void; closed: () => void };
  /** CDP method -> error the next call to it fails with, once. */
  readonly failNext: Map<string, string>;
}

/** A paired profile that answers chrome.* calls the way the extension would. */
export function connectFake(
  extension: ReturnType<typeof makeBrowserExtension>,
  token: string,
  label = "Personal",
  page: { url: string; title: string } = { url: "https://example.com/", title: "Example" },
  instanceId?: string,
): FakeChrome {
  const calls: FakeChrome["calls"] = [];
  const closed: FakeChrome["closed"] = [];
  const failNext: FakeChrome["failNext"] = new Map();
  let nextTab = 100;
  const tabs = new Map<number, { id: number; url: string; title: string; active: boolean }>([
    [1, { id: 1, url: "https://mail.example.com/", title: "Mail", active: true }],
  ]);
  const reply = (id: number, body: { result?: unknown; error?: string }) =>
    queueMicrotask(() => session.receive(JSON.stringify({ id, ...body })));
  const socket: RelaySocket = {
    send(text) {
      const message = JSON.parse(text);
      if (typeof message.id !== "number") return;
      const params = message.params as unknown[];
      calls.push({ method: message.method, params });
      switch (message.method) {
        case "chrome.tabs.query":
          return reply(message.id, { result: [...tabs.values()] });
        case "chrome.tabs.get": {
          const tab = tabs.get(params[0] as number);
          return reply(message.id, tab ? { result: tab } : { error: "No tab with id" });
        }
        case "chrome.tabs.create": {
          const tab = { id: nextTab++, url: "about:blank", title: "", active: true };
          for (const other of tabs.values()) other.active = false;
          tabs.set(tab.id, tab);
          return reply(message.id, { result: tab });
        }
        case "chrome.tabs.remove":
          tabs.delete(params[0] as number);
          return reply(message.id, { result: {} });
        case "chrome.debugger.attach":
        case "chrome.debugger.detach":
          return reply(message.id, { result: {} });
        case "chrome.debugger.sendCommand": {
          const [, method, args] = params as [unknown, string, Record<string, unknown>];
          const failure = failNext.get(method);
          if (failure !== undefined) {
            failNext.delete(method);
            return reply(message.id, { error: failure });
          }
          if (method === "Runtime.evaluate") {
            const expression = String(args.expression);
            if (expression === "document.readyState")
              return reply(message.id, { result: { result: { value: "complete" } } });
            if (expression === "({ title: document.title, url: location.href })")
              return reply(message.id, { result: { result: { value: page } } });
            if (expression.includes("data-swc-ref") && expression.includes("elements"))
              return reply(message.id, {
                result: {
                  result: {
                    value: {
                      ...page,
                      text: "Hello",
                      textTruncated: false,
                      elements: [{ ref: "e1", role: "button", name: "Send" }],
                    },
                  },
                },
              });
            if (expression.includes("scrollIntoView"))
              return reply(message.id, {
                result: { result: { value: { found: true, x: 10, y: 20, width: 5, height: 5 } } },
              });
            if (expression === "throw")
              return reply(message.id, {
                result: {
                  exceptionDetails: { text: "Uncaught", exception: { description: "Boom" } },
                },
              });
            return reply(message.id, { result: { result: { value: 42 } } });
          }
          if (method === "Page.captureScreenshot")
            return reply(message.id, { result: { data: PNG_1x1 } });
          return reply(message.id, { result: {} });
        }
      }
      reply(message.id, { error: `Unknown method: ${message.method}` });
    },
    close(code, reason) {
      closed.push({ code, reason });
    },
  };
  const session = extension.hub.open(socket);
  session.receive(
    JSON.stringify({
      method: "hello",
      params: {
        protocol: 1,
        token,
        label,
        extensionVersion: "1.0.0",
        extensionId: `ext-${label}`,
        ...(instanceId === undefined ? {} : { instanceId }),
        userAgent: "Mozilla/5.0 Chrome/141.0.0.0 Safari/537.36",
      },
    }),
  );
  return { calls, closed, session, failNext };
}

export function setup() {
  const stateDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "swc-browser-"));
  const extension = makeBrowserExtension({ stateDir, port: 8319, machineName: "mac" });
  const code = extension.pairing(false).pairingCode;
  const json = JSON.parse(
    Buffer.from(code.slice("swc-chrome:1:".length), "base64url").toString("utf8"),
  );
  return { stateDir, extension, token: json.t as string, json };
}
