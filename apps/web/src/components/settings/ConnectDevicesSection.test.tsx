import type { ConnectDevicesSnapshot } from "@specweave-studio/contracts/connectDevices";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  approveOutcomeMessage,
  describeConnectDevice,
  isCompleteApprovalCode,
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

  it("names the device and what it is", () => {
    expect(describeConnectDevice({ label: "Anton's iPhone", kind: "phone" })).toBe(
      "Anton's iPhone (phone)",
    );
    expect(describeConnectDevice({ label: "Work laptop", kind: "connect" })).toBe(
      "Work laptop (computer)",
    );
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
    expect(html).toContain("Anton&#x27;s iPhone (phone)");
    expect(html).toContain("is waiting to use m4.");
    expect(html).toContain('data-device-code-form="request-1"');
    expect(html).toContain(">Allow<");
    expect(html).toContain(">Deny<");
  });

  it("lists approved devices with who approved them and a Remove button", () => {
    const html = renderToStaticMarkup(
      <ConnectDevicesList snapshot={snapshot({ pending: [] })} actions={actions} />,
    );
    expect(html).toContain("Anton&#x27;s MacBook (computer)");
    expect(html).toMatch(/Approved November 13, 2026 by this machine/);
    expect(html).toContain(">Remove<");
    expect(html).not.toContain("data-device-code-form");
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
