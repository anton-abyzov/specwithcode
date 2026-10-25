// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const openFileInFront = vi.fn();
const writeTextToClipboard = vi.fn(async (_value: string, _target?: string) => true);

vi.mock("~/hooks/useHtmlRenderTheme", () => ({
  useHtmlRenderTheme: () => ({ appearance: "dark", variables: { "--background": "#111" } }),
}));
vi.mock("~/lib/openInFront", () => ({ openFileInFront }));
vi.mock("~/hooks/useCopyToClipboard", () => ({ writeTextToClipboard }));

const { HtmlRenderDocument } = await import("./BrowserDocumentFrame");

const threadRef = { environmentId: "env-A", threadId: "thread-A" } as never;
const trusted = { threadRef, cwd: "/Users/someone/work/app", canReadFiles: true };
const SRC = "https://host.test/api/assets/report.html";

let root: Root;
let container: HTMLDivElement;
let frame: HTMLIFrameElement;
let replies: unknown[];

/** `null` mounts a frame with no thread, as a standalone page has. */
async function mount(fileTarget: typeof trusted | null = trusted) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root.render(
      <HtmlRenderDocument src={SRC} title="Report" fileTarget={fileTarget ?? undefined} />,
    ),
  );
  frame = container.querySelector("iframe")!;
  replies = [];
  vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation((message: unknown) => {
    replies.push(message);
  });
  frame.tabIndex = 0;
  frame.focus();
}

function post(data: unknown, init: { source?: unknown; origin?: string } = {}) {
  window.dispatchEvent(
    new MessageEvent("message", {
      data,
      origin: init.origin ?? "null",
      source: (init.source === undefined ? frame.contentWindow : init.source) as Window,
    }),
  );
}

const open = (path: unknown, extra: object = {}, id: unknown = "studio-file-1") => ({
  jsonrpc: "2.0",
  id,
  method: "specwithcode/open-file",
  params: { path, ...extra },
});

let clock = 1_000;
beforeEach(() => {
  openFileInFront.mockClear();
  writeTextToClipboard.mockClear();
  clock += 10_000;
  vi.spyOn(performance, "now").mockImplementation(() => clock);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  Reflect.deleteProperty(navigator, "userActivation");
});

describe("HtmlRenderDocument evidence links", () => {
  it("opens the file in the reply's own thread, with the line, and answers the page", async () => {
    await mount();
    post(open("/Users/someone/work/app/shots/login.png", { line: 12 }));
    expect(openFileInFront).toHaveBeenCalledWith({
      threadRef,
      cwd: trusted.cwd,
      path: "/Users/someone/work/app/shots/login.png",
      line: 12,
    });
    expect(replies).toEqual([{ jsonrpc: "2.0", id: "studio-file-1", result: {} }]);
  });

  it("takes machine, thread and folder from the frame, never from the page", async () => {
    await mount();
    post(
      open("/Users/someone/x.png", {
        environmentId: "env-other",
        threadId: "project-coordinator:other",
        cwd: "/",
        machine: "other",
      }),
    );
    expect(openFileInFront).toHaveBeenCalledTimes(1);
    expect(openFileInFront.mock.calls[0]![0]).toEqual({
      threadRef,
      cwd: trusted.cwd,
      path: "/Users/someone/x.png",
      line: undefined,
    });
  });

  it("ignores a message from another window, another origin, without activation or focus", async () => {
    await mount();
    post(open("/Users/someone/x.png"), { source: window });
    post(open("/Users/someone/x.png"), { origin: "https://host.test" });
    Object.defineProperty(navigator, "userActivation", {
      configurable: true,
      value: { isActive: false },
    });
    post(open("/Users/someone/x.png"));
    Reflect.deleteProperty(navigator, "userActivation");
    frame.blur();
    document.body.focus();
    post(open("/Users/someone/x.png"));
    expect(openFileInFront).not.toHaveBeenCalled();
    expect(replies).toEqual([]);
  });

  it("refuses non-path, traversing, encoded, control-character and oversized paths", async () => {
    await mount();
    const hostile = [
      "javascript:alert(1)",
      "data:text/html,<b>x</b>",
      "https://example.test/x.png",
      "/Users/a/../../etc/passwd",
      "/Users/a/./x",
      "/Users/%2e%2e/x",
      "/Users/a/x\u0000.png",
      "/Users/a/\u001b[0m.png",
      "/Users/a/‮x.png",
      "x.png",
      "//host/share/x",
      "/Users/a/",
      `/${"a".repeat(4096)}`,
      42,
    ];
    for (const [index, path] of hostile.entries()) {
      clock += 1_000;
      post(open(path, {}, `bad-${index}`));
    }
    expect(openFileInFront).not.toHaveBeenCalled();
    expect(replies).toHaveLength(hostile.length);
    for (const message of replies)
      expect(message).toMatchObject({ error: { code: -32000, message: "Invalid path" } });
  });

  it("opens one file for a flood and refuses the rest", async () => {
    await mount();
    for (let index = 0; index < 20; index++) post(open("/Users/someone/x.png", {}, index));
    expect(openFileInFront).toHaveBeenCalledTimes(1);
    expect(replies.filter((message) => "error" in (message as object))).toHaveLength(19);
  });

  it("refuses where the frame has no thread, or the connection cannot read files", async () => {
    await mount(null);
    post(open("/Users/someone/x.png"));
    expect(replies).toEqual([
      { jsonrpc: "2.0", id: "studio-file-1", error: { code: -32000, message: "Not allowed here" } },
    ]);
    await act(async () => root.unmount());
    container.remove();
    await mount({ ...trusted, canReadFiles: false });
    post(open("/Users/someone/x.png"));
    expect(replies).toEqual([
      { jsonrpc: "2.0", id: "studio-file-1", error: { code: -32000, message: "Policy violation" } },
    ]);
    expect(openFileInFront).not.toHaveBeenCalled();
  });

  it("expands a home path from the thread's folder and refuses one it cannot place", async () => {
    await mount();
    post(open("~/evidence/run.log"));
    expect(openFileInFront.mock.calls[0]![0]).toMatchObject({
      path: "/Users/someone/evidence/run.log",
    });
    await act(async () => root.unmount());
    container.remove();
    await mount({ ...trusted, cwd: "/srv/app" });
    post(open("~/evidence/run.log"));
    expect(replies.at(-1)).toMatchObject({ error: { message: "Invalid path" } });
  });

  it("copies only a validated path, exactly as the link wrote it", async () => {
    await mount();
    const copy = (path: string, id: string) =>
      post({ jsonrpc: "2.0", id, method: "specwithcode/copy-path", params: { path } });
    copy("/Users/someone/work/app/shots/login.png", "copy-1");
    await act(async () => {});
    expect(writeTextToClipboard).toHaveBeenCalledWith(
      "/Users/someone/work/app/shots/login.png",
      "path",
      undefined,
      { preserveBytes: true },
    );
    expect(replies).toEqual([{ jsonrpc: "2.0", id: "copy-1", result: {} }]);
    clock += 1_000;
    copy("/Users/someone/../etc/passwd", "copy-2");
    expect(writeTextToClipboard).toHaveBeenCalledTimes(1);
    expect(replies.at(-1)).toMatchObject({ id: "copy-2", error: { message: "Invalid path" } });
    clock += 1_000;
    copy("~/evidence/run.log", "copy-3");
    await act(async () => {});
    expect(writeTextToClipboard.mock.calls.at(-1)![0]).toBe("~/evidence/run.log");
  });

  it("refuses a network path, which would make the machine sign in to the page's host", async () => {
    await mount();
    post(open("\\\\attacker.example\\share\\x.png"));
    expect(openFileInFront).not.toHaveBeenCalled();
    expect(replies.at(-1)).toMatchObject({ error: { message: "Invalid path" } });
  });
});

describe("HtmlRenderDocument links from reports published before evidence links", () => {
  it("opens a same-server `/Users/…` link as a file instead of a browser tab", async () => {
    const windowOpen = vi.spyOn(window, "open").mockImplementation(() => null);
    await mount();
    post({
      jsonrpc: "2.0",
      id: "studio-link-1",
      method: "ui/open-link",
      params: { url: "https://host.test/Users/someone/shot%20one.png" },
    });
    expect(windowOpen).not.toHaveBeenCalled();
    expect(openFileInFront.mock.calls[0]![0]).toMatchObject({
      path: "/Users/someone/shot one.png",
    });
  });

  it("opens one file for a flood of old-style links and refuses the rest", async () => {
    const windowOpen = vi.spyOn(window, "open").mockImplementation(() => null);
    await mount();
    for (let index = 0; index < 20; index++)
      post({
        jsonrpc: "2.0",
        id: `legacy-${index}`,
        method: "ui/open-link",
        params: { url: `https://host.test/Users/someone/f${index}.png` },
      });
    expect(openFileInFront).toHaveBeenCalledTimes(1);
    expect(windowOpen).not.toHaveBeenCalled();
    expect(replies.filter((message) => "error" in (message as object))).toHaveLength(19);
  });

  it("still sends the server's own pages and other sites to the browser", async () => {
    const windowOpen = vi.spyOn(window, "open").mockImplementation(() => null);
    await mount();
    for (const url of [
      "https://host.test/api/assets/other.html",
      "https://host.test/settings/general",
      "https://example.test/Users/a",
    ])
      post({ jsonrpc: "2.0", id: url, method: "ui/open-link", params: { url } });
    expect(openFileInFront).not.toHaveBeenCalled();
    expect(windowOpen).toHaveBeenCalledTimes(3);
  });
});
