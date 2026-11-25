// @effect-diagnostics nodeBuiltinImport:off - Stands in for an Electron debugger.
import { describe, expect, it } from "@effect/vitest";
import { DesktopBrowserEvent } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as NodeEvents from "node:events";
import * as NodePath from "node:path";

import * as DesktopBrowserHost from "./DesktopBrowserHost.ts";

const decodeEvent = Schema.decodeUnknownSync(Schema.fromJsonString(DesktopBrowserEvent));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeCdpReply = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ id: Schema.Number })),
);
const key = { threadId: "thread-1", tabId: "tab-1" };

/** A tab's webContents and debugger, with the debugger's commands left pending until released. */
const makeDebuggee = () => {
  const emitter = new NodeEvents.EventEmitter();
  const pending: Array<() => void> = [];
  const debuggee = Object.assign(emitter, {
    sendCommand: (method: string) =>
      new Promise((resolve) => {
        if (method === "Target.getTargetInfo") {
          resolve({ targetInfo: { targetId: "GUEST" } });
          return;
        }
        pending.push(() => resolve({ method }));
      }),
  });
  const webContents = {
    getURL: () => "http://localhost/",
    getTitle: () => "Page",
    getUserAgent: () => "Electron",
  };
  return {
    tab: {
      webContents: webContents as unknown as Electron.WebContents,
      debugger: debuggee as unknown as Electron.Debugger,
    },
    emit: (method: string, params: unknown) => emitter.emit("message", {}, method, params, ""),
    release: () => pending.splice(0).forEach((resolve) => resolve()),
  };
};

/** Reads `count` events from one backend's subscription. */
const takeEvents = (host: DesktopBrowserHost.DesktopBrowserHost["Service"], count: number) =>
  host.events.pipe(
    Stream.take(count),
    Stream.runCollect,
    Effect.map((lines) => lines.map((line) => decodeEvent(new TextDecoder().decode(line)))),
  );

describe("DesktopBrowserHost", () => {
  it.effect("announces tabs already attached to a backend that starts later", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      host.attach(key, makeDebuggee().tab);
      // A restarted backend subscribes after the attach and still hears it.
      expect(yield* takeEvents(host, 1)).toEqual([{ type: "attached", ...key }]);
      expect(yield* takeEvents(host, 1)).toEqual([{ type: "attached", ...key }]);
    }),
  );

  it.effect("drops replies from a relay the server released", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      const debuggee = makeDebuggee();
      host.attach(key, debuggee.tab);
      const reader = yield* takeEvents(host, 2).pipe(Effect.forkScoped);
      // Wait until the reader has received the announcement.
      yield* Effect.yieldNow;
      const command = (id: number, method: string) =>
        host.handleCommandLine(
          encodeJson({
            type: "cdp",
            ...key,
            message: encodeJson({ id, method, sessionId: "studio-preview-page" }),
          }),
        );
      yield* command(1, "Page.captureScreenshot");
      yield* host.handleCommandLine(encodeJson({ type: "release", ...key }));
      yield* command(2, "DOM.enable");
      debuggee.release();
      yield* Effect.promise(() => new Promise((resolve) => setImmediate(resolve)));
      const [, reply] = yield* Fiber.join(reader);
      // Only the new connection's reply arrives; the old one's id could collide.
      expect(reply).toMatchObject({ type: "cdp" });
      expect(decodeCdpReply((reply as { message: string }).message).id).toBe(2);
    }).pipe(Effect.scoped),
  );

  it.effect("saves a server tab's download under its CDP guid where the server asked", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      const debuggee = makeDebuggee();
      host.attach(key, debuggee.tab);
      const paths: Array<string> = [];
      const item = {
        setSavePath: (path: string) => void paths.push(path),
      } as unknown as Electron.DownloadItem;
      // Before the server sets a directory, Electron keeps its own handling.
      expect(host.placeDownload(debuggee.tab.webContents, item)).toBe(false);
      yield* host.handleCommandLine(
        encodeJson({
          type: "cdp",
          ...key,
          message: encodeJson({
            id: 1,
            method: "Browser.setDownloadBehavior",
            params: { behavior: "allowAndName", downloadPath: "/srv/downloads" },
          }),
        }),
      );
      debuggee.emit("Browser.downloadWillBegin", { guid: "guid-1", suggestedFilename: "r.csv" });
      expect(host.placeDownload(debuggee.tab.webContents, item)).toBe(true);
      expect(paths).toEqual([NodePath.join("/srv/downloads", "guid-1")]);
    }),
  );

  it.effect("refuses relayed input while the person annotates the tab", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      const debuggee = makeDebuggee();
      const sent: Array<string> = [];
      const sendCommand = debuggee.tab.debugger.sendCommand.bind(debuggee.tab.debugger);
      (debuggee.tab.debugger as unknown as { sendCommand: unknown }).sendCommand = (
        method: string,
        ...rest: Array<unknown>
      ) => {
        sent.push(method);
        return (sendCommand as (...args: Array<unknown>) => Promise<unknown>)(method, ...rest);
      };
      let annotating = true;
      host.attach(key, {
        ...debuggee.tab,
        annotating: () => annotating,
      } as DesktopBrowserHost.DesktopBrowserTabDebugger);
      const reader = yield* takeEvents(host, 5).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      const command = (id: number, method: string) =>
        host.handleCommandLine(
          encodeJson({
            type: "cdp",
            ...key,
            message: encodeJson({
              id,
              method,
              params: { type: "mousePressed", x: 1, y: 1 },
              sessionId: "studio-preview-page",
            }),
          }),
        );
      yield* command(1, "Input.dispatchMouseEvent");
      yield* command(2, "Input.insertText");
      yield* command(3, "DOM.enable");
      // The annotation ends; the agent's input reaches the page again.
      annotating = false;
      yield* command(4, "Input.dispatchMouseEvent");
      debuggee.release();
      yield* Effect.promise(() => new Promise((resolve) => setImmediate(resolve)));
      const replies = (yield* Fiber.join(reader))
        .slice(1)
        .map((event) => JSON.parse((event as { message: string }).message));
      expect(sent.filter((method) => method.startsWith("Input."))).toEqual([
        "Input.dispatchMouseEvent",
      ]);
      expect(replies.find((reply) => reply.id === 1)?.error?.message).toMatch(/annotated/);
      expect(replies.find((reply) => reply.id === 2)?.error?.message).toMatch(/annotated/);
      expect(sent).toContain("DOM.enable");
    }).pipe(Effect.scoped),
  );

  // Wrapped commands could address another target, so the relay never sends them;
  // the annotation guard also refuses wrapped input should one ever get through.
  it.effect("never sends input wrapped in another command, annotating or not", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      const debuggee = makeDebuggee();
      const sent: Array<{ method: string; params: unknown }> = [];
      const sendCommand = debuggee.tab.debugger.sendCommand.bind(debuggee.tab.debugger);
      (debuggee.tab.debugger as unknown as { sendCommand: unknown }).sendCommand = (
        method: string,
        params?: unknown,
        ...rest: Array<unknown>
      ) => {
        sent.push({ method, params });
        return (sendCommand as (...args: Array<unknown>) => Promise<unknown>)(
          method,
          params,
          ...rest,
        );
      };
      let annotating = true;
      host.attach(key, {
        ...debuggee.tab,
        annotating: () => annotating,
      } as DesktopBrowserHost.DesktopBrowserTabDebugger);
      const reader = yield* takeEvents(host, 7).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      const wrap = (inner: unknown) => ({
        sessionId: "child-session",
        message: typeof inner === "string" ? inner : encodeJson(inner),
      });
      const command = (id: number, method: string, params: unknown) =>
        host.handleCommandLine(
          encodeJson({
            type: "cdp",
            ...key,
            message: encodeJson({ id, method, params, sessionId: "studio-preview-page" }),
          }),
        );
      const input = { id: 1, method: "Input.dispatchMouseEvent", params: { type: "mousePressed" } };
      yield* command(1, "Target.sendMessageToTarget", wrap(input));
      yield* command(2, "Target.sendMessageToTarget", wrap("{not json"));
      yield* command(
        3,
        "Target.sendMessageToTarget",
        wrap({ id: 2, method: "Target.sendMessageToTarget", params: wrap(input) }),
      );
      yield* command(4, "Target.sendMessageToTarget", wrap({ id: 3, method: "DOM.enable" }));
      yield* command(5, "DOM.enable", {});
      // The annotation ends; wrapped input reaches the page again.
      annotating = false;
      yield* command(6, "Target.sendMessageToTarget", wrap(input));
      debuggee.release();
      yield* Effect.promise(() => new Promise((resolve) => setImmediate(resolve)));
      const replies = (yield* Fiber.join(reader))
        .slice(1)
        .map((event) => JSON.parse((event as { message: string }).message));
      for (const id of [1, 2, 3, 4, 6]) {
        expect(replies.find((reply) => reply.id === id)?.error?.message, `id ${id}`).toMatch(
          /annotated|Not supported/,
        );
      }
      expect(replies.find((reply) => reply.id === 5)).toHaveProperty("result");
      expect(sent.filter((entry) => entry.method === "Target.sendMessageToTarget")).toEqual([]);
      expect(sent.map((entry) => entry.method)).toContain("DOM.enable");
    }).pipe(Effect.scoped),
  );
});
