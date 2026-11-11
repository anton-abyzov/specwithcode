import { describe, expect, it, vi } from "vite-plus/test";
import { parseSiteEvent } from "@specweave-studio/shared/crashReport";

import {
  assetForDownloadLink,
  buildSiteEvent,
  sendSiteEvent,
  siteEventsEndpoint,
  startSiteEvents,
} from "./siteEvents";

class FakeElement {
  dataset: Record<string, string> = {};
  constructor(
    private readonly attrs: Record<string, string>,
    readonly parent: FakeElement | null = null,
  ) {
    for (const [key, value] of Object.entries(attrs)) {
      if (key.startsWith("data-")) {
        const name = key.slice(5).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
        this.dataset[name] = value;
      }
    }
  }
  getAttribute(name: string) {
    return this.attrs[name] ?? null;
  }
  closest(selector: string): FakeElement | null {
    const attr = selector.slice(1, -1);
    let node: FakeElement | null = this;
    while (node) {
      if (attr in node.attrs) return node;
      node = node.parent;
    }
    return null;
  }
}

function harness(doNotTrack: string | null = null) {
  const doc = new EventTarget();
  const sendBeacon = vi.fn(() => true);
  const env = {
    document: doc as unknown as Document,
    navigator: { sendBeacon, doNotTrack } as unknown as Navigator,
    location: { pathname: "/download" } as Location,
  };
  const dispatch = (type: string, target: FakeElement, button = 0) => {
    const event = new Event(type);
    Object.defineProperty(event, "target", { value: target });
    Object.defineProperty(event, "button", { value: button });
    doc.dispatchEvent(event);
  };
  return { env, sendBeacon, dispatch };
}

async function sentBody(mock: ReturnType<typeof vi.fn>, call = 0) {
  const [url, blob] = mock.mock.calls[call] as [string, Blob];
  expect(blob.type).toBe("text/plain");
  return { url, body: JSON.parse(await blob.text()) as unknown };
}

describe("siteEventsEndpoint", () => {
  it("defaults to the relay and keeps only the origin of an override", () => {
    expect(siteEventsEndpoint(undefined)).toBe("https://relay.spec-weave.com/v1/site-events");
    expect(siteEventsEndpoint("https://relay.example.com/x?y=1")).toBe(
      "https://relay.example.com/v1/site-events",
    );
    expect(siteEventsEndpoint("javascript:alert(1)")).toBe(
      "https://relay.spec-weave.com/v1/site-events",
    );
  });
});

describe("assetForDownloadLink", () => {
  it("prefers explicit assets and otherwise derives the file suffix", () => {
    expect(assetForDownloadLink({ asset: "arm64.dmg" }, null)).toBe("arm64.dmg");
    expect(assetForDownloadLink({ trackAsset: "linux-x64.tar.gz" }, null)).toBe("linux-x64.tar.gz");
    expect(
      assetForDownloadLink(
        {},
        "https://github.com/o/r/releases/download/v1.2.3/SpecWithCode-1.2.3-x64.exe",
      ),
    ).toBe("x64.exe");
    expect(assetForDownloadLink({}, "https://github.com/o/r/releases")).toBeUndefined();
  });
});

describe("buildSiteEvent", () => {
  it("produces events the relay accepts", () => {
    const event = buildSiteEvent("download_click", "amd64.deb", "/download");
    expect(event).toEqual({
      v: 1,
      event: "download_click",
      platform: "linux-deb",
      asset: "amd64.deb",
      page: "/download",
    });
    expect(parseSiteEvent(event)).toEqual(event);
    expect(buildSiteEvent("download_click", undefined, "/?q=x")).toEqual({
      v: 1,
      event: "download_click",
      platform: "other",
    });
  });
});

describe("startSiteEvents", () => {
  it("beacons a download click with the card asset", async () => {
    const { env, sendBeacon, dispatch } = harness();
    const stop = startSiteEvents(env, undefined);
    const card = new FakeElement({
      "data-download-track": "",
      "data-asset": "arm64.dmg",
      href: "https://x/a.dmg",
    });
    dispatch("click", new FakeElement({}, card));
    expect(sendBeacon).toHaveBeenCalledTimes(1);
    const { url, body } = await sentBody(sendBeacon);
    expect(url).toBe("https://relay.spec-weave.com/v1/site-events");
    expect(body).toEqual({
      v: 1,
      event: "download_click",
      platform: "mac",
      asset: "arm64.dmg",
      page: "/download",
    });
    stop();
    dispatch("click", card);
    expect(sendBeacon).toHaveBeenCalledTimes(1);
  });

  it("counts install command copies and middle clicks, ignores untracked and same-site links", async () => {
    const { env, sendBeacon, dispatch } = harness();
    startSiteEvents(env, "https://relay.example.com");
    dispatch("copy", new FakeElement({ "data-install-copy": "install.sh" }));
    const { url, body } = await sentBody(sendBeacon);
    expect(url).toBe("https://relay.example.com/v1/site-events");
    expect(body).toMatchObject({
      event: "install_copy",
      platform: "install-script",
      asset: "install.sh",
    });

    dispatch("click", new FakeElement({ href: "https://x/a.dmg" }));
    dispatch("click", new FakeElement({ "data-download-track": "", href: "/download#linux" }));
    dispatch(
      "auxclick",
      new FakeElement({ "data-download-track": "", "data-asset": "x64.exe" }),
      2,
    );
    expect(sendBeacon).toHaveBeenCalledTimes(1);
    dispatch(
      "auxclick",
      new FakeElement({ "data-download-track": "", "data-asset": "x64.exe" }),
      1,
    );
    expect(sendBeacon).toHaveBeenCalledTimes(2);
  });

  it("sends nothing when Do Not Track is on", () => {
    const { env, sendBeacon, dispatch } = harness("1");
    startSiteEvents(env, undefined);
    dispatch("click", new FakeElement({ "data-download-track": "", "data-asset": "x64.exe" }));
    expect(sendBeacon).not.toHaveBeenCalled();
  });
});

describe("sendSiteEvent", () => {
  it("never throws when the beacon fails", () => {
    const env = {
      navigator: {
        sendBeacon: () => {
          throw new Error("blocked");
        },
      },
    } as unknown as Parameters<typeof sendSiteEvent>[0];
    expect(() =>
      sendSiteEvent(
        env,
        "https://x/v1/site-events",
        buildSiteEvent("download_click", "x64.exe", "/"),
      ),
    ).not.toThrow();
  });
});
