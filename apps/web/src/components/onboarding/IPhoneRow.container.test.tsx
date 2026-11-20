// The row with its permission poll and desktop bridge, as the Access step mounts it (1395).

import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const permissions = vi.hoisted(() => ({
  current: {
    status: { screenRecording: true, accessibility: true },
    error: null as string | null,
    retry: () => {},
  },
}));
vi.mock("../computerUse/ComputerUsePermissions", () => ({
  useComputerUsePermissions: () => permissions.current,
}));

import { IPhoneRow } from "./IPhoneRow";

let renderer: ReactTestRenderer;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  permissions.current = {
    status: { screenRecording: true, accessibility: true },
    error: null,
    retry: () => {},
  };
});
afterEach(async () => {
  await act(() => renderer?.unmount());
  vi.unstubAllGlobals();
});

const mount = async () => {
  await act(() => {
    renderer = create(<IPhoneRow open onOpenChange={() => {}} />);
  });
};
const text = () => JSON.stringify(renderer.toJSON());
const press = (label: string) =>
  act(() =>
    renderer.root
      .findAll((node) => typeof node.type !== "string" && node.props.onClick)
      .find((node) => [node.props.children].flat(2).includes(label))!
      .props.onClick(),
  );
const alerts = () =>
  renderer.root.findAll((node) => node.type === "span" && node.props.role === "alert");
const FAILED = "Could not open iPhone Mirroring. Open it from the Applications folder.";

describe("IPhoneRow", () => {
  it("says it could not check when the poll failed after granting", async () => {
    const retry = vi.fn();
    permissions.current = {
      status: { screenRecording: true, accessibility: true },
      error: "Could not check permissions. Trying again automatically.",
      retry,
    };
    await mount();
    expect(text()).toContain("Could not check the Mac's permissions.");
    expect(text()).not.toContain("Ready to try");
    await press("Retry");
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["answers false", () => Promise.resolve(false)],
    ["rejects", () => Promise.reject(new Error("no"))],
  ])(
    "says so when opening iPhone Mirroring %s, and clears it on a press that opens",
    async (_name, fails) => {
      const open = vi.fn(fails);
      vi.stubGlobal("window", { desktopBridge: { openIphoneMirroring: open } });
      await mount();
      expect(alerts()).toEqual([]);
      await press("Open iPhone Mirroring");
      expect(open).toHaveBeenCalledTimes(1);
      expect(alerts()).toHaveLength(1);
      expect(text()).toContain(FAILED);
      open.mockImplementation(() => Promise.resolve(true));
      await press("Open iPhone Mirroring");
      expect(open).toHaveBeenCalledTimes(2);
      expect(alerts()).toEqual([]);
    },
  );
});
