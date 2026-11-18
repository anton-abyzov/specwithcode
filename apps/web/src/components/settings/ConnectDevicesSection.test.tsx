import type { ConnectDevicesSnapshot } from "@specweave-studio/contracts/connectDevices";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  approveOutcomeMessage,
  connectDeviceDetails,
  connectDeviceName,
  noticeMessage,
  translateDeviceRefusal,
  isCompleteApprovalCode,
  makeSeenNotices,
  takeUnseenNotices,
} from "../../studio/connectDevices.logic";
import {
  ConnectDevicesList,
  type ConnectDevicesListActions,
  DeviceWaitingCard,
  WaitingBadge,
} from "../devices/ConnectDeviceViews";

const actions: ConnectDevicesListActions = {
  onApprove: vi.fn(async () => null),
  onDeny: vi.fn(async () => undefined),
  onRemove: vi.fn(async () => undefined),
  onConfirmReview: vi.fn(async () => undefined),
  onRepair: vi.fn(async () => undefined),
};

const snapshot = (overrides: Partial<ConnectDevicesSnapshot> = {}): ConnectDevicesSnapshot => ({
  machine: "m4",
  health: "ok",
  devices: [
    {
      key: "jkt:laptop",
      kind: "connect",
      label: "Anton's MacBook",
      deviceType: "desktop",
      approvedAt: "2026-11-13T15:00:00.000Z",
      approvedBy: "this machine",
      keptByUpdate: false,
    },
  ],
  pending: [
    {
      id: "request-1",
      kind: "phone",
      label: "Anton's iPhone",
      deviceType: "mobile",
      askedAt: "2026-11-13T15:10:00.000Z",
      expiresAt: "2026-11-13T15:20:00.000Z",
    },
  ],
  needsReview: false,
  notices: [],
  canApprove: true,
  canRepair: true,
  ...overrides,
});

describe("device approval copy", () => {
  it("accepts a code typed with spaces, a dash or lower case, and nothing short", () => {
    expect(isCompleteApprovalCode("k7q-x2m")).toBe(true);
    expect(isCompleteApprovalCode("K7Q X2M")).toBe(true);
    expect(isCompleteApprovalCode("K7QX2")).toBe(false);
    // 0, 1, I, L and O are never in a code.
    expect(isCompleteApprovalCode("K7QX2O")).toBe(false);
  });

  it("names the device by its own name, never the label every Connect window shared", () => {
    expect(connectDeviceName({ label: "Anton's iPhone", kind: "phone" })).toBe("Anton's iPhone");
    expect(connectDeviceName({ label: "M5", kind: "connect", named: true })).toBe("M5");
    // Rows from before 1327 and machines that still send the link's label.
    expect(
      connectDeviceName({
        label: "SpecWithCode Connect connect",
        kind: "connect",
        system: "macOS",
      }),
    ).toBe("A Mac");
    expect(
      connectDeviceName({ label: "A Mac", kind: "connect", named: false, system: "Linux" }),
    ).toBe("A Linux computer");
    expect(
      connectDeviceName({ label: "Phone", kind: "phone", deviceType: "mobile", system: "iOS" }),
    ).toBe("An iPhone");
    // A device calling itself "this machine" must not read as the owner.
    expect(connectDeviceName({ label: "This machine", kind: "connect", system: "macOS" })).toBe(
      "A Mac",
    );
  });

  it("tells devices apart by system, app and first seen", () => {
    expect(
      connectDeviceDetails(
        { system: "macOS", app: "SpecWithCode 1.0.338", firstSeenAt: "2026-11-17T15:00:00.000Z" },
        undefined,
        "en-US",
      ),
    ).toBe("macOS · SpecWithCode 1.0.338 · First seen November 17, 2026");
    expect(connectDeviceDetails({})).toBe("");
    expect(
      connectDeviceDetails(
        { system: "iOS", askedAt: "2026-11-17T15:05:00.000Z" },
        undefined,
        "en-US",
      ),
    ).toMatch(/^iOS · Asked at \d{1,2}:05/);
  });

  it("says the machine's refusals in this window's words", () => {
    const tx = (english: string, values?: Readonly<Record<string, string | number>>) =>
      `T:${english.replace(/\{(\w+)\}/g, (_m, name: string) => String(values?.[name]))}`;
    for (const message of [
      "Open SpecWithCode on m4 and type this code: K7QX2M",
      "m4 turned this device away. Ask again tomorrow, or approve it in SpecWithCode on m4.",
      "Too many devices are waiting for approval on m4. Try again in a few minutes.",
      "m4 no longer lets this device in. Approve it again in SpecWithCode on m4.",
      "The device list on m4 is damaged. Open SpecWithCode on m4 to repair it.",
    ])
      expect(translateDeviceRefusal(message, tx)).toMatch(/^T:/);
    expect(translateDeviceRefusal("Something else.", tx)).toBe("Something else.");
  });

  it("says an approval notice in this window's words", () => {
    const notice = {
      id: "n1",
      at: "2026-11-17T15:00:00.000Z",
      message: "New device approved on m4 by this machine.",
      machine: "m4",
      approvedBy: "this machine",
    };
    expect(noticeMessage(notice)).toBe("New device approved on m4 by this machine");
    const tx = (english: string, values?: Readonly<Record<string, string | number>>) =>
      english === "this machine"
        ? "эта машина"
        : `RU:${english.replace(/\{(\w+)\}/g, (_m, name: string) => String(values?.[name]))}`;
    expect(noticeMessage(notice, tx)).toBe("RU:New device approved on m4 by эта машина");
    // A machine from before the parts were sent keeps its own sentence.
    expect(noticeMessage({ id: "n2", at: notice.at, message: "Old text." })).toBe("Old text.");
  });

  it("explains a refused code, including a device typing its own", () => {
    expect(approveOutcomeMessage({ status: "approved" }, "m4")).toBeNull();
    expect(approveOutcomeMessage({ status: "self" }, "m4")).toBe(
      "A device cannot approve itself. Type this code on another device or on the machine.",
    );
    expect(approveOutcomeMessage({ status: "not-found" }, "m4")).toMatch(/asked for m4/);
    expect(approveOutcomeMessage({ status: "paused" }, "m4")).toMatch(/on m4 itself/);
  });
});

describe("the waiting device", () => {
  it("never puts something that looks like a real code in the empty code box", () => {
    // The pop-up and the list share one code form.
    const html = renderToStaticMarkup(
      <ConnectDevicesList snapshot={snapshot()} actions={actions} />,
    );
    const placeholder = /placeholder="([^"]*)"/.exec(html)?.[1];
    expect(placeholder).toBe("6 characters");
    expect(placeholder).not.toMatch(/^[A-Z0-9]{6}$/);
  });

  it("says where to go and shows the code large with Copy", () => {
    const html = renderToStaticMarkup(<DeviceWaitingCard machine="m4" code="K7QX2M" />);
    expect(html).toContain("Open SpecWithCode on m4 and type this code:");
    expect(html).toMatch(/data-device-waiting-code[^>]*>K7QX2M</);
    expect(html).toContain("text-3xl");
    expect(html).toContain("Copy");
  });
});

describe("Devices that can use this machine", () => {
  it("shows 1 device waiting with a code box, Allow and Deny", () => {
    expect(renderToStaticMarkup(<WaitingBadge count={1} />)).toContain("1 device waiting");
    expect(renderToStaticMarkup(<WaitingBadge count={2} />)).toContain("2 devices waiting");
    expect(renderToStaticMarkup(<WaitingBadge count={0} />)).toBe("");
    const html = renderToStaticMarkup(
      <ConnectDevicesList snapshot={snapshot()} actions={actions} />,
    );
    expect(html).toContain("Anton&#x27;s iPhone is waiting to use m4.");
    expect(html).toContain('data-device-code-form="request-1"');
    expect(html).toContain(">Allow<");
    expect(html).toContain(">Deny<");
  });

  it("lists approved devices with who approved them and a Remove button", () => {
    const html = renderToStaticMarkup(
      <ConnectDevicesList snapshot={snapshot({ pending: [] })} actions={actions} />,
    );
    expect(html).toContain("Anton&#x27;s MacBook");
    expect(html).toMatch(/Approved November 13, 2026 by this machine/);
    expect(html).toContain(">Remove<");
    expect(html).not.toContain("data-device-code-form");
  });

  it("names a kept row from its session, never as SpecWithCode Connect connect (1327)", () => {
    const kept = snapshot({
      pending: [],
      needsReview: true,
      devices: [
        {
          key: "jkt:m5",
          kind: "connect",
          label: "SpecWithCode Connect connect",
          deviceType: "desktop",
          system: "macOS",
          app: "SpecWithCode 1.0.338",
          firstSeenAt: "2026-11-16T15:00:00.000Z",
          approvedAt: "2026-11-17T15:00:00.000Z",
          approvedBy: "the update",
          keptByUpdate: true,
        },
      ],
    });
    const html = renderToStaticMarkup(<ConnectDevicesList snapshot={kept} actions={actions} />);
    expect(html).not.toContain("SpecWithCode Connect connect");
    expect(html).toContain("A Mac");
    expect(html).toContain("macOS · SpecWithCode 1.0.338 · First seen");
  });

  it("flags devices the update kept until the owner confirms the list once", () => {
    const kept = snapshot({
      pending: [],
      needsReview: true,
      devices: [{ ...snapshot().devices[0]!, keptByUpdate: true, approvedBy: "the update" }],
    });
    const html = renderToStaticMarkup(<ConnectDevicesList snapshot={kept} actions={actions} />);
    expect(html).toContain("Kept by the update. Check this list.");
    expect(html).toContain("The list is right");
    const confirmed = renderToStaticMarkup(
      <ConnectDevicesList snapshot={{ ...kept, needsReview: false }} actions={actions} />,
    );
    expect(confirmed).not.toContain("The list is right");
    expect(confirmed).toContain("Kept by the update");
  });

  it("offers Repair on a damaged list only to this machine's own app", () => {
    const damaged = snapshot({ health: "damaged", devices: [], pending: [], canApprove: false });
    const owner = renderToStaticMarkup(<ConnectDevicesList snapshot={damaged} actions={actions} />);
    expect(owner).toContain("The device list on m4 is damaged");
    expect(owner).toContain(">Repair<");
    const device = renderToStaticMarkup(
      <ConnectDevicesList snapshot={{ ...damaged, canRepair: false }} actions={actions} />,
    );
    expect(device).not.toContain(">Repair<");
  });

  it("hides Allow, Deny and Remove from a caller that may not change the list", () => {
    const html = renderToStaticMarkup(
      <ConnectDevicesList snapshot={snapshot({ canApprove: false })} actions={actions} />,
    );
    expect(html).not.toContain(">Allow<");
    expect(html).not.toContain(">Remove<");
  });
});

describe("New device approved notices on other devices", () => {
  const approvedByLaptop = {
    id: "notice-1",
    at: "2026-11-13T15:12:00.000Z",
    message: "New device approved on m4 by Anton's MacBook.",
  };
  const approvedByOwner = {
    id: "notice-2",
    at: "2026-11-13T15:14:00.000Z",
    message: "New device approved on m4 by this machine.",
  };

  it("shows each notice once, however often the list is polled", () => {
    const first = takeUnseenNotices([], [approvedByLaptop]);
    expect(first.fresh.map((notice) => notice.message)).toEqual([
      "New device approved on m4 by Anton's MacBook.",
    ]);
    const again = takeUnseenNotices(first.seen, [approvedByLaptop]);
    expect(again.fresh).toEqual([]);
    expect(again.seen).toBe(first.seen);
    const next = takeUnseenNotices(again.seen, [
      approvedByLaptop,
      approvedByOwner,
      approvedByOwner,
    ]);
    expect(next.fresh.map((notice) => notice.id)).toEqual(["notice-2"]);
    expect(next.seen).toEqual(["notice-1", "notice-2"]);
  });

  it("keeps only the newest seen ids", () => {
    const many = Array.from({ length: 5 }, (_, index) => ({
      ...approvedByOwner,
      id: `n-${index}`,
    }));
    expect(takeUnseenNotices([], many, 3).seen).toEqual(["n-2", "n-3", "n-4"]);
  });
});

describe("approval notices when storage cannot save", () => {
  it("shows each notice once per session when localStorage refuses to save", () => {
    const storage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    const take = makeSeenNotices(() => storage);
    const notice = { id: "n1", at: "2026-11-13T15:00:00.000Z", message: "New device approved" };
    expect(take("env-1", [notice])).toEqual([notice]);
    // The next poll returns the same notice: it is not shown again.
    expect(take("env-1", [notice])).toEqual([]);
    expect(take("env-2", [notice])).toEqual([notice]);
  });

  it("keeps seen notices across reloads when storage works", () => {
    const saved = new Map<string, string>();
    const storage = {
      getItem: (key: string) => saved.get(key) ?? null,
      setItem: (key: string, value: string) => void saved.set(key, value),
    };
    const notice = { id: "n1", at: "2026-11-13T15:00:00.000Z", message: "New device approved" };
    expect(makeSeenNotices(() => storage)("env-1", [notice])).toEqual([notice]);
    expect(makeSeenNotices(() => storage)("env-1", [notice])).toEqual([]);
  });
});
