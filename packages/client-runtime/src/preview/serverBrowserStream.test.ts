import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  createPreviewStreamClient,
  previewStreamControlAction,
  previewStreamControlLabel,
  previewStreamHostSetupMessage,
  type PreviewStreamControl,
} from "./serverBrowserStream.ts";

class FakeSocket extends EventTarget {
  static readonly OPEN = 1;
  static current: FakeSocket;
  readyState = 1;
  binaryType = "";
  readonly sent: string[] = [];
  readonly url: string;
  constructor(url: string) {
    super();
    this.url = url;
    FakeSocket.current = this;
  }
  send(value: string) {
    this.sent.push(value);
  }
  close() {
    this.readyState = 3;
  }
  message(data: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
  control(value: PreviewStreamControl) {
    this.message(JSON.stringify({ type: "control", ...value }));
  }
}

const target = {
  access: {
    httpBase: "http://preview.test/api/preview-stream",
    wsBase: "ws://preview.test/api/preview-stream",
    query: {},
    credentials: true,
  },
  threadId: "thread",
  tabId: "tab",
  maxWidth: 800,
  maxHeight: 600,
};

describe("preview stream control", () => {
  beforeEach(() => vi.stubGlobal("WebSocket", FakeSocket));
  afterEach(() => vi.unstubAllGlobals());
  const connect = () => {
    const onFrame = vi.fn();
    const onControl = vi.fn();
    const client = createPreviewStreamClient(target, {
      onFrame,
      onControl,
      onViewport: vi.fn(),
      onConnectedChange: vi.fn(),
      onUnauthorized: vi.fn(),
    });
    return { client, socket: FakeSocket.current, onFrame, onControl };
  };
  const agent: PreviewStreamControl = {
    canOperate: true,
    controller: "agent",
    generation: 1,
    dialog: null,
  };

  it("marks passive viewers without changing active viewer URLs", () => {
    const { client, socket } = connect();
    expect(new URL(socket.url).searchParams.has("interactive")).toBe(false);
    client.stop();
    const passive = createPreviewStreamClient(
      { ...target, interactive: false },
      {
        onFrame: vi.fn(),
        onViewport: vi.fn(),
        onConnectedChange: vi.fn(),
        onUnauthorized: vi.fn(),
      },
    );
    expect(new URL(FakeSocket.current.url).searchParams.get("interactive")).toBe("false");
    passive.stop();
  });

  it("does not resize or navigate before ownership is granted", () => {
    const { client, socket } = connect();
    expect(client.send({ type: "resize", width: 390, height: 844 })).toBe(false);
    expect(client.send({ type: "navigate", url: "http://example.test" })).toBe(false);
    socket.control(agent);
    expect(client.send({ type: "takeControl" })).toBe(true);
    expect(client.send({ type: "text", text: "premature" })).toBe(false);
    socket.control({ ...agent, controller: "you", generation: 2 });
    expect(client.send({ type: "text", text: "owned" })).toBe(true);
    expect(socket.sent.map((entry) => JSON.parse(entry))).toEqual([
      { type: "takeControl" },
      { type: "text", text: "owned" },
    ]);
    client.stop();
  });

  it("does not grant control from malformed dialog metadata", () => {
    const { client, socket, onControl } = connect();
    socket.message(
      JSON.stringify({
        type: "control",
        ...agent,
        controller: "you",
        dialog: { type: "prompt", message: 42, defaultValue: "" },
      }),
    );
    expect(onControl).not.toHaveBeenCalled();
    expect(client.send({ type: "reload" })).toBe(false);
    client.stop();
  });

  it("keeps read-only frames flowing while refusing takeover and every mutation", () => {
    const { client, socket, onFrame } = connect();
    socket.control({ ...agent, canOperate: false });
    const frame = new ArrayBuffer(3);
    socket.message(frame);
    expect(onFrame).toHaveBeenCalledWith(frame);
    expect(client.send({ type: "takeControl" })).toBe(false);
    expect(client.send({ type: "resize", width: 390, height: 844 })).toBe(false);
    expect(client.send({ type: "reload" })).toBe(false);
    expect(socket.sent).toEqual(['{"type":"ack"}']);
    client.stop();
  });

  it("revokes input immediately on release and exposes pending dialog state", () => {
    const { client, socket, onControl } = connect();
    const owned = {
      ...agent,
      controller: "you" as const,
      dialog: { type: "prompt", message: "Name?", defaultValue: "initial" },
    };
    socket.control(owned);
    expect(onControl).toHaveBeenLastCalledWith(owned);
    expect(client.send({ type: "dialog", accept: true, promptText: "answer" })).toBe(true);
    expect(client.send({ type: "releaseControl" })).toBe(true);
    socket.control({ ...agent, generation: 2 });
    expect(client.send({ type: "text", text: "late input" })).toBe(false);
    expect(client.send({ type: "dialog", accept: false })).toBe(false);
    client.stop();
  });
});

describe("preview stream control copy", () => {
  const control = (controller: PreviewStreamControl["controller"], canOperate = true) =>
    ({ canOperate, controller, generation: 1, dialog: null }) satisfies PreviewStreamControl;

  it("says who is driving the tab", () => {
    expect(previewStreamControlLabel(null)).toBe("Connecting...");
    expect(previewStreamControlLabel(control("agent", false))).toBe("View only");
    expect(previewStreamControlLabel(control("you"))).toBe("You're driving. The agent waits.");
    expect(previewStreamControlLabel(control("agent"))).toBe("The agent is driving");
    expect(previewStreamControlLabel(control("another-viewer"))).toBe("Someone else is driving");
    expect(previewStreamControlLabel(control("unclaimed"))).toBe("Nobody is driving");
  });

  it("offers take over, or hand back while you drive", () => {
    expect(previewStreamControlAction(control("you")).label).toBe("Hand back");
    expect(previewStreamControlAction(control("agent")).label).toBe("Take over");
    expect(previewStreamControlAction(control("agent")).hint).toMatch(/Pause the agent/);
    expect(previewStreamControlAction(control("unclaimed")).label).toBe("Take over");
  });
});

describe("preview stream downloads", () => {
  beforeEach(() => vi.stubGlobal("WebSocket", FakeSocket));
  afterEach(() => vi.unstubAllGlobals());

  it("offers a download at a URL carrying the stream's ticket", () => {
    const onDownload = vi.fn();
    createPreviewStreamClient(
      {
        ...target,
        access: { ...target.access, query: { wsTicket: "ticket" }, credentials: false },
      },
      {
        onFrame: vi.fn(),
        onDownload,
        onViewport: vi.fn(),
        onConnectedChange: vi.fn(),
        onUnauthorized: vi.fn(),
      },
    );
    FakeSocket.current.message(
      JSON.stringify({ type: "download", id: "d1", fileName: "a b.csv", sizeBytes: 3 }),
    );
    expect(onDownload).toHaveBeenCalledExactlyOnceWith({
      fileName: "a b.csv",
      sizeBytes: 3,
      url: "http://preview.test/api/preview-stream/download?threadId=thread&tabId=tab&id=d1&wsTicket=ticket",
    });
  });
});

describe("preview stream agent pointer", () => {
  beforeEach(() => vi.stubGlobal("WebSocket", FakeSocket));
  afterEach(() => vi.unstubAllGlobals());

  it("reports where the agent moves and clicks, ignoring malformed points", () => {
    const onPointer = vi.fn();
    createPreviewStreamClient(target, {
      onFrame: vi.fn(),
      onPointer,
      onViewport: vi.fn(),
      onConnectedChange: vi.fn(),
      onUnauthorized: vi.fn(),
    });
    FakeSocket.current.message(
      JSON.stringify({ type: "pointer", phase: "drag", x: 1, y: 2, sequence: 1 }),
    );
    FakeSocket.current.message(
      JSON.stringify({ type: "pointer", phase: "click", x: 140, y: 50, sequence: 2 }),
    );
    expect(onPointer).toHaveBeenCalledExactlyOnceWith({
      phase: "click",
      x: 140,
      y: 50,
      sequence: 2,
    });
  });
});

describe("preview stream host setup", () => {
  beforeEach(() => vi.stubGlobal("WebSocket", FakeSocket));
  afterEach(() => vi.unstubAllGlobals());
  const closeWith = (reason: string) => {
    const onHostSetup = vi.fn();
    createPreviewStreamClient(target, {
      onFrame: vi.fn(),
      onViewport: vi.fn(),
      onConnectedChange: vi.fn(),
      onUnauthorized: vi.fn(),
      onHostSetup,
    });
    FakeSocket.current.dispatchEvent(
      Object.assign(new Event("close"), { code: 4503, reason, wasClean: true }),
    );
    return onHostSetup.mock.calls[0]?.[0];
  };

  it("keeps the server's command for a setup newer than this client", () => {
    const setup = closeWith(JSON.stringify({ need: "kernel", command: "run-this --once" }));
    expect(setup).toEqual({ need: "other", command: "run-this --once" });
    expect(previewStreamHostSetupMessage(setup)).toBe(
      "This server's browser needs setup on its host. Do this there, then try again:",
    );
  });

  it("passes a known setup through and falls back on a malformed reason", () => {
    expect(
      closeWith(JSON.stringify({ need: "gpu", command: "STUDIO_SERVER_BROWSER_SANDBOX=0" })),
    ).toEqual({ need: "gpu", command: "STUDIO_SERVER_BROWSER_SANDBOX=0" });
    expect(closeWith("not json")).toEqual({
      need: "sandbox",
      command: "sudo specweave-studio browser setup",
    });
  });
});

describe("previewStreamHostSetupMessage", () => {
  it("names the outer sandbox for a GPU process that cannot start", () => {
    expect(
      previewStreamHostSetupMessage({ need: "gpu", command: "STUDIO_SERVER_BROWSER_SANDBOX=0" }),
    ).toBe(
      "Chrome's GPU process cannot start inside the sandbox this server runs in. Start the server outside it, or restart it with this set in its environment, then try again:",
    );
  });
});
