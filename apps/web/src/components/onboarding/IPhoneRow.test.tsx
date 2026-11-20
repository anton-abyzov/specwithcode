import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  IPHONE_MIRRORING_SUPPORT_URL,
  iphoneRowState,
  IPhoneRowView,
  openIphoneMirroring,
  type IPhoneRowState,
} from "./IPhoneRow";

describe("iphoneRowState", () => {
  it.each([
    ["Mac apps allowed", { screenRecording: true, accessibility: true }, "ready"],
    ["neither", { screenRecording: false, accessibility: false }, "needs-mac-apps"],
    ["Accessibility missing", { screenRecording: true, accessibility: false }, "needs-mac-apps"],
    ["Screen Recording missing", { screenRecording: false, accessibility: true }, "needs-mac-apps"],
  ] as const)("%s", (_name, status, state) => {
    expect(iphoneRowState({ status, error: null })).toBe(state);
  });

  it("a failed check wins over an earlier granted answer", () => {
    const status = { screenRecording: true, accessibility: true };
    expect(iphoneRowState({ status, error: "Could not check permissions." })).toBe(
      "could-not-check",
    );
  });
});

let renderer: ReactTestRenderer;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});
afterEach(async () => {
  await act(() => renderer?.unmount());
  vi.unstubAllGlobals();
});

const view = async (
  state: IPhoneRowState,
  { open = false, examples = [] as readonly string[] } = {},
) => {
  const onOpenChange = vi.fn();
  const onOpenMirroring = vi.fn();
  const onRetry = vi.fn();
  await act(() => {
    renderer = create(
      <IPhoneRowView
        state={state}
        open={open}
        onOpenChange={onOpenChange}
        onOpenMirroring={onOpenMirroring}
        onRetry={onRetry}
        examples={examples}
      />,
    );
  });
  return { onOpenChange, onOpenMirroring, onRetry };
};
const text = () => JSON.stringify(renderer.toJSON());
const buttons = () =>
  renderer.root.findAll((node) => typeof node.type !== "string" && node.props.onClick);
const button = (label: string) =>
  buttons().find((node) => [node.props.children].flat(2).includes(label))!;
const bodyHidden = () =>
  renderer.root.find(
    (node) => typeof node.type === "string" && node.props["data-slot"] === "access-row-body",
  ).props.hidden;

describe("IPhoneRowView", () => {
  it("says what it is for and that it needs Mac apps first", async () => {
    await view("needs-mac-apps");
    expect(text()).toContain("Your iPhone");
    expect(text()).toContain("Agents can work in apps on your iPhone through iPhone Mirroring.");
    expect(text()).toContain("Needs Mac apps first");
    expect(text()).not.toContain("Ready to try");
    expect(bodyHidden()).toBe(true);
  });

  it("is ready to try once Mac apps are allowed", async () => {
    await view("ready");
    expect(text()).toContain("Ready to try");
    expect(text()).not.toContain("Needs Mac apps first");
  });

  it("says it could not check, with Retry, instead of Ready to try", async () => {
    const { onRetry } = await view("could-not-check");
    expect(text()).toContain("Could not check the Mac's permissions.");
    expect(text()).not.toContain("Ready to try");
    await act(() => button("Retry").props.onClick());
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("Show opens the body and Hide closes it", async () => {
    const { onOpenChange } = await view("ready");
    await act(() => button("Show").props.onClick());
    expect(onOpenChange).toHaveBeenCalledWith(true);
    await act(() => renderer.unmount());
    const opened = await view("ready", { open: true });
    expect(bodyHidden()).toBe(false);
    await act(() => button("Hide").props.onClick());
    expect(opened.onOpenChange).toHaveBeenCalledWith(false);
  });

  it("open, it shows the button, the three steps, the stop line and the limits", async () => {
    await view("needs-mac-apps", { open: true });
    for (const line of [
      "Open iPhone Mirroring and enter your iPhone's passcode once.",
      "Allow Mac apps above.",
      "Ask an agent, and approve the access card for iPhone Mirroring the first time.",
      "Tell the agent where to stop. These examples do.",
      "One Mac and one iPhone at a time.",
      "Not available in the EU.",
      "Latin text only.",
      "It pauses when you pick the phone up.",
    ]) {
      expect(text()).toContain(line);
    }
    const link = renderer.root.find(
      (node) => node.type === "a" && node.props.href === IPHONE_MIRRORING_SUPPORT_URL,
    );
    expect(link.props.target).toBe("_blank");
    expect(text()).not.toMatch(/asks? (you )?before posting/i);
  });

  it("Open iPhone Mirroring calls with no argument", async () => {
    const { onOpenMirroring } = await view("ready", { open: true });
    await act(() => button("Open iPhone Mirroring").props.onClick());
    expect(onOpenMirroring).toHaveBeenCalledTimes(1);
    expect(onOpenMirroring.mock.calls[0]).toEqual([]);
  });

  it("lists the proven examples under Tried with, and nothing when there are none", async () => {
    await view("ready", { open: true });
    expect(text()).not.toContain("Tried with");
    await act(() => renderer.unmount());
    await view("ready", { open: true, examples: ["Walk through my app."] });
    expect(text()).toContain("Tried with");
    expect(text()).toContain("Walk through my app.");
  });
});

describe("openIphoneMirroring", () => {
  it("calls the desktop bridge with no argument", async () => {
    const open = vi.fn(() => Promise.resolve(true));
    vi.stubGlobal("window", { desktopBridge: { openIphoneMirroring: open } });
    await expect(openIphoneMirroring()).resolves.toBe(true);
    expect(open.mock.calls).toEqual([[]]);
  });

  it("is false without the bridge or when the call fails", async () => {
    vi.stubGlobal("window", { desktopBridge: undefined });
    await expect(openIphoneMirroring()).resolves.toBe(false);
    vi.stubGlobal("window", {
      desktopBridge: { openIphoneMirroring: () => Promise.reject(new Error("no")) },
    });
    await expect(openIphoneMirroring()).resolves.toBe(false);
  });
});
