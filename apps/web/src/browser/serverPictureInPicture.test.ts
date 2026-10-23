import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const runtime = vi.hoisted(() => ({
  toast: vi.fn(),
  access: vi.fn(),
  client: vi.fn(),
  paint: vi.fn(),
  stopPainter: vi.fn(),
  stopClient: vi.fn(),
}));
vi.mock("~/components/ui/toast", () => ({ toastManager: { add: runtime.toast } }));
vi.mock("~/state/previewStream", () => ({ readPreviewStreamAccess: runtime.access }));
vi.mock("@specweave-studio/client-runtime/preview/server-browser-stream", () => ({
  createPreviewFramePainter: () => ({ paint: runtime.paint, stop: runtime.stopPainter }),
  createPreviewStreamClient: runtime.client,
}));
import { closeServerPictureInPicture, openServerPictureInPicture } from "./serverPictureInPicture";
import type { EnvironmentId } from "@specweave-studio/contracts";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
class FakeVideo extends EventTarget {
  muted = false;
  playsInline = false;
  srcObject: unknown;
  style = { cssText: "" };
  readyState = 1;
  play = vi.fn(() => Promise.resolve());
  remove = vi.fn();
  requestPictureInPicture = vi.fn(async () => {
    doc.pictureInPictureElement = this;
  });
}
let doc: {
  pictureInPictureEnabled: boolean;
  pictureInPictureElement: FakeVideo | null;
  exitPictureInPicture: ReturnType<typeof vi.fn>;
  createElement: ReturnType<typeof vi.fn>;
  body: { append: ReturnType<typeof vi.fn> };
};
let videos: FakeVideo[];
let tracks: Array<{ stop: ReturnType<typeof vi.fn> }>;
const input = (tabId = "tab-a") => ({
  environmentId: "env-test" as EnvironmentId,
  threadId: "thread",
  tabId,
  seed: null,
});
const flush = async () => {
  for (let n = 0; n < 8; n++) await Promise.resolve();
};
beforeEach(() => {
  vi.useFakeTimers();
  videos = [];
  tracks = [];
  runtime.access.mockResolvedValue({ url: "wss://fixture.test" });
  runtime.client.mockImplementation(() => ({ send: vi.fn(), stop: runtime.stopClient }));
  doc = {
    pictureInPictureEnabled: true,
    pictureInPictureElement: null,
    exitPictureInPicture: vi.fn(async () => {
      doc.pictureInPictureElement = null;
    }),
    createElement: vi.fn((tag: string) => {
      if (tag === "video") {
        const video = new FakeVideo();
        videos.push(video);
        return video;
      }
      const track = { stop: vi.fn() };
      tracks.push(track);
      return {
        width: 0,
        height: 0,
        getContext: () => ({ drawImage: vi.fn(), fillRect: vi.fn() }),
        captureStream: () => ({ getTracks: () => [track] }),
      };
    }),
    body: { append: vi.fn() },
  };
  vi.stubGlobal("document", doc);
  vi.stubGlobal("HTMLMediaElement", { HAVE_METADATA: 1 });
});
afterEach(() => {
  closeServerPictureInPicture();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("server live pop-out lifecycle", () => {
  it("does not enter PiP after closing during playback", async () => {
    const play = deferred<void>();
    // Each instance's play can be replaced synchronously during append.
    doc.body.append.mockImplementation((v: FakeVideo) => {
      v.play.mockReturnValue(play.promise);
    });
    const opening = openServerPictureInPicture(input());
    closeServerPictureInPicture();
    play.resolve();
    await opening;
    expect(videos[0]!.requestPictureInPicture).not.toHaveBeenCalled();
    expect(tracks[0]!.stop).toHaveBeenCalledOnce();
    expect(videos[0]!.remove).toHaveBeenCalledOnce();
  });
  it("does not replace a newer live window when older playback finishes", async () => {
    const firstPlay = deferred<void>();
    doc.body.append.mockImplementationOnce((v: FakeVideo) => {
      v.play.mockReturnValue(firstPlay.promise);
    });
    const first = openServerPictureInPicture(input());
    await openServerPictureInPicture(input("tab-b"));
    firstPlay.resolve();
    await first;
    expect(videos[0]!.requestPictureInPicture).not.toHaveBeenCalled();
    expect(doc.pictureInPictureElement).toBe(videos[1]);
    expect(tracks[1]!.stop).not.toHaveBeenCalled();
  });
  it("settles a close even if playback never answers", async () => {
    doc.body.append.mockImplementation((v: FakeVideo) => {
      v.play.mockReturnValue(new Promise(() => {}));
    });
    let settled = false;
    const opening = openServerPictureInPicture(input()).then(() => {
      settled = true;
    });
    closeServerPictureInPicture();
    await flush();
    expect(settled).toBe(true);
    await opening;
  });
  it("bounds metadata startup and releases its resources", async () => {
    doc.body.append.mockImplementation((v: FakeVideo) => {
      v.readyState = 0;
    });
    const opening = openServerPictureInPicture(input());
    const outcome = opening.then(
      () => "opened",
      (error: Error) => error.message,
    );
    await vi.advanceTimersByTimeAsync(10_001);
    expect(await Promise.race([outcome, Promise.resolve("pending")])).toMatch(/within 10 seconds/);
    expect(tracks[0]!.stop).toHaveBeenCalledOnce();
    expect(videos[0]!.requestPictureInPicture).not.toHaveBeenCalled();
  });
  it("reports playback failure and cleans tracks, video and painter", async () => {
    doc.body.append.mockImplementation((v: FakeVideo) => {
      v.play.mockRejectedValue(new Error("Playback refused"));
    });
    await expect(openServerPictureInPicture(input())).rejects.toThrow("Playback refused");
    expect(tracks[0]!.stop).toHaveBeenCalledOnce();
    expect(videos[0]!.remove).toHaveBeenCalledOnce();
    expect(runtime.stopPainter).toHaveBeenCalledOnce();
  });
  it("reports media errors while waiting for metadata", async () => {
    doc.body.append.mockImplementation((v: FakeVideo) => {
      v.readyState = 0;
    });
    const opening = openServerPictureInPicture(input());
    const rejected = expect(opening).rejects.toThrow("could not be loaded");
    await flush();
    videos[0]!.dispatchEvent(new Event("error"));
    await rejected;
    expect(tracks[0]!.stop).toHaveBeenCalledOnce();
  });
  it("reports initial access failure rather than leaving a frozen seed", async () => {
    runtime.access.mockRejectedValueOnce(new Error("Ticket unavailable"));
    await expect(openServerPictureInPicture(input())).rejects.toThrow("Ticket unavailable");
    expect(tracks[0]!.stop).toHaveBeenCalledOnce();
    expect(doc.exitPictureInPicture).toHaveBeenCalledOnce();
  });
  it("cleans an unsupported browser rather than reporting it opened", async () => {
    doc.body.append.mockImplementation((v: FakeVideo) => {
      Object.assign(v, { requestPictureInPicture: undefined });
    });
    await expect(openServerPictureInPicture(input())).rejects.toThrow("does not support");
    expect(tracks[0]!.stop).toHaveBeenCalledOnce();
  });
  it("serializes a late native acknowledgment and cleanup before replacement entry", async () => {
    const entering = deferred<void>();
    const exiting = deferred<void>();
    doc.body.append.mockImplementationOnce((v: FakeVideo) => {
      v.requestPictureInPicture.mockImplementation(async () => {
        await entering.promise;
        doc.pictureInPictureElement = v;
      });
    });
    doc.exitPictureInPicture.mockImplementationOnce(async () => {
      await exiting.promise;
      doc.pictureInPictureElement = null;
    });
    const first = openServerPictureInPicture(input());
    await flush();
    const second = openServerPictureInPicture(input("tab-b"));
    await flush();
    expect(videos[1]!.requestPictureInPicture).not.toHaveBeenCalled();
    entering.resolve();
    await flush();
    expect(videos[1]!.requestPictureInPicture).not.toHaveBeenCalled();
    exiting.resolve();
    await Promise.all([first, second]);
    expect(doc.pictureInPictureElement).toBe(videos[1]);
    expect(tracks[1]!.stop).not.toHaveBeenCalled();
  });
  it("releases a rejected old native entry so its replacement can open", async () => {
    const entering = deferred<void>();
    doc.body.append.mockImplementationOnce((v: FakeVideo) => {
      v.requestPictureInPicture.mockReturnValue(entering.promise);
    });
    const first = openServerPictureInPicture(input());
    await flush();
    const second = openServerPictureInPicture(input("tab-b"));
    entering.reject(new Error("OS refused stale entry"));
    await Promise.all([first, second]);
    expect(doc.pictureInPictureElement).toBe(videos[1]);
  });
  it("reports a failed access refresh and closes only its live window", async () => {
    await openServerPictureInPicture(input());
    runtime.access.mockRejectedValueOnce(new Error("Refresh failed"));
    runtime.client.mock.calls[0]![1].onUnauthorized();
    await vi.advanceTimersByTimeAsync(1000);
    expect(tracks[0]!.stop).toHaveBeenCalledOnce();
    expect(runtime.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Live preview disconnected" }),
    );
  });
  it("leaves on a missing browser host instead of keeping a frozen frame", async () => {
    await openServerPictureInPicture(input());
    runtime.client.mock.calls[0]![1].onHostSetup({ reason: "browser-missing" });
    expect(tracks[0]!.stop).toHaveBeenCalledOnce();
    expect(runtime.stopClient).toHaveBeenCalledOnce();
  });
});
