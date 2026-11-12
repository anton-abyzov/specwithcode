import type { EnvironmentId } from "@specweave-studio/contracts";
import { act, type ReactNode } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("~/state/environments", () => ({ useEnvironment: () => ({ label: "m4.local" }) }));
vi.mock("~/studio/machineNickname", () => ({ useMachineNickname: () => "M4" }));
vi.mock("./settingsLayout", () => ({ scrollToSettingsTarget: vi.fn() }));
vi.mock("../ui/qr-code", () => ({
  QRCodeSvg: ({ value }: { value: string }) => <svg data-qr={value} />,
}));
vi.mock("../ui/dialog", () => {
  const Pass = ({ children }: { children?: ReactNode }) => <>{children}</>;
  return {
    Dialog: ({ open, children }: { open: boolean; children?: ReactNode }) =>
      open ? <div data-dialog>{children}</div> : null,
    DialogPopup: Pass,
    DialogHeader: Pass,
    DialogPanel: Pass,
    DialogTitle: Pass,
    DialogDescription: Pass,
  };
});
vi.mock("./MachineSummary", () => ({
  NEXT_STEP_FRAME_CLASS: "frame",
  MachineNextStepHead: ({ setup }: { setup: { step: { kind: string } } }) => (
    <div data-next-step={setup.step.kind} />
  ),
  MachineSetupState: ({ children }: { children: (setup: unknown) => ReactNode }) =>
    children(ownSetup),
}));

import { AddDeviceDialog } from "./AddDeviceDialog";
import type { MachineSetup } from "./MachineSummary";

const nothing = () => undefined;
const base = {
  connectLocked: false,
  lock: null,
  error: null,
  retry: nothing,
  busy: false,
  signIn: nothing,
  turnOn: nothing,
  dismissPhoneStep: nothing,
};
const done: MachineSetup = {
  ...base,
  connect: { kind: "on", account: "sam@example.com" },
  phones: 2,
  step: { kind: "done" },
};
const ownSetup: MachineSetup = { ...done, phones: 0, step: { kind: "add-phone" } };
const here = "env-m4" as EnvironmentId;

let renderer: ReactTestRenderer | null = null;
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
});

function textOf(node: ReactTestInstance | string): string {
  return typeof node === "string" ? node : node.children.map(textOf).join("");
}

function show(props: Partial<Parameters<typeof AddDeviceDialog>[0]> = {}) {
  const onOpenChange = vi.fn();
  const onShowFallback = vi.fn();
  act(() => {
    renderer = create(
      <AddDeviceDialog
        environmentId={here}
        open
        onOpenChange={onOpenChange}
        onShowFallback={onShowFallback}
        {...props}
      />,
    );
  });
  const root = renderer!.root;
  const attr = (name: string) =>
    root.findAll((node) => typeof node.type === "string" && node.props[name] !== undefined);
  return {
    root,
    onOpenChange,
    onShowFallback,
    text: () => textOf(root),
    qr: () => attr("data-qr").map((node) => node.props["data-qr"]),
    choices: () =>
      root
        .findAll((node) => node.type === "button" && node.props.role === "radio")
        .map((node) => [textOf(node), node.props["aria-checked"]]),
    press: (label: string) => {
      const button = root
        .findAll((node) => node.type === "button")
        .find((node) => textOf(node).startsWith(label));
      if (!button) throw new Error(`No button "${label}"`);
      act(() => button.props.onClick());
    },
    has: (name: string) => attr(name).length > 0,
  };
}

describe("Add a device or machine", () => {
  it("asks one question, a phone or a computer, and starts on the phone", () => {
    const view = show({ setup: done });
    expect(view.text()).toContain("Add a device or machine");
    expect(view.choices()).toEqual([
      ["A phoneiPhone or Android", true],
      ["A computerMac, Windows or Linux", false],
    ]);
    expect(view.qr()).toEqual(["https://specwithcode.com/get"]);
    expect(view.text()).toContain("Sign in as sam@example.com.");
  });

  it("folds finished setup into one line instead of a checklist", () => {
    const view = show({ setup: done });
    expect(view.has("data-add-device-ready")).toBe(true);
    expect(view.text()).toContain(
      "M4 is on SpecWithCode Connect as sam@example.com. 2 phones linked.",
    );
    expect(view.has("data-next-step")).toBe(false);
  });

  it("switches to a computer: the download code and Allow on the new machine", () => {
    const view = show({ setup: done });
    view.press("A computer");
    expect(view.choices().map(([, checked]) => checked)).toEqual([false, true]);
    expect(view.qr()).toEqual(["https://specwithcode.com/download"]);
    expect(view.text()).toContain("Pick M4 as the main machine and press Allow there.");
    expect(view.text()).not.toContain("phones linked");
  });

  it("opens on the kind it is asked for", () => {
    const view = show({ setup: done, initialChoice: "computer" });
    expect(view.qr()).toEqual(["https://specwithcode.com/download"]);
  });

  it("closes and hands each fallback its place in Settings > Machines", () => {
    let view = show({ setup: done });
    view.press("Pair with a private QR code");
    expect(view.onOpenChange).toHaveBeenCalledWith(false);
    expect(view.onShowFallback).toHaveBeenCalledWith("phone-connect");
    act(() => renderer?.unmount());
    view = show({ setup: done, initialChoice: "computer" });
    view.press("Use a join line");
    expect(view.onShowFallback).toHaveBeenCalledWith("private-machines-add");
  });

  it("shows the Connect step and no code while this machine is signed out", () => {
    const view = show({
      setup: {
        ...base,
        connect: { kind: "signed-out" },
        phones: null,
        step: { kind: "sign-in", canAct: true },
      },
    });
    expect(view.has("data-next-step")).toBe(true);
    expect(view.qr()).toEqual([]);
    expect(view.text()).toContain("once M4 is on SpecWithCode Connect");
  });

  it("offers only the fallback in a build without Connect", () => {
    const view = show({
      setup: { ...base, connect: { kind: "unavailable" }, phones: null, step: { kind: "done" } },
    });
    expect(view.qr()).toEqual([]);
    expect(view.text()).toContain("This build pairs phones over your own network.");
    view.press("A computer");
    expect(view.text()).toContain("This build adds computers with a join line or a code.");
  });

  it("reads its own setup when none is handed in, and draws nothing while closed", () => {
    expect(show().qr()).toEqual(["https://specwithcode.com/get"]);
    act(() => renderer?.unmount());
    expect(show({ open: false }).text()).toBe("");
    act(() => renderer?.unmount());
    expect(show({ environmentId: null }).text()).toBe("");
  });
});
