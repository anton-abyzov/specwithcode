import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";

import { PhoneSetupDialog } from "./PhoneSetupDialog";

const { passthrough } = vi.hoisted(() => ({
  passthrough: ({ children }: { children?: unknown }) => children as ReactNode,
}));
vi.mock("../ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children?: ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogDescription: passthrough,
  DialogFooter: passthrough,
  DialogHeader: passthrough,
  DialogPanel: passthrough,
  DialogPopup: passthrough,
  DialogTitle: passthrough,
}));
vi.mock("../ui/qr-code", () => ({ QRCodeSvg: () => null }));
vi.mock("../ui/button", () => ({
  Button: ({ children, onClick }: { children?: ReactNode; onClick?: () => void }) => (
    <button onClick={onClick}>{children}</button>
  ),
}));

const tailnetAddress = {
  httpBaseUrl: "https://mac.tailnet-example.ts.net/",
  hint: "tailnet",
} as never;
const wifiAddress = { httpBaseUrl: "http://192.168.1.20:8319/", hint: "same-network" } as never;

let renderer: ReactTestRenderer | null = null;
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
});

type Props = Parameters<typeof PhoneSetupDialog>[0];

function render(props: Partial<Props> = {}) {
  act(() => {
    renderer = create(
      <PhoneSetupDialog
        open
        onOpenChange={() => {}}
        address={tailnetAddress}
        code={null}
        canPair
        isCreating={false}
        error={null}
        hasAccessControls
        onShowAccessSettings={() => {}}
        onGenerate={() => {}}
        onCopyAddress={() => {}}
        onCopyCode={() => {}}
        {...props}
      />,
    );
  });
  return renderer!;
}

const text = (r: ReactTestRenderer) => JSON.stringify(r.toJSON());
const buttons = (r: ReactTestRenderer) =>
  r.root.findAllByType("button").map((node) => String(node.props.children));
const button = (r: ReactTestRenderer, label: string) =>
  r.root.find((node) => node.type === "button" && node.props.children === label);

it("opens straight at the pairing steps, with no screen about Connect first", () => {
  const r = render();
  expect(text(r)).toContain("Pair over your own network");
  expect(text(r)).toContain("tailnet-example");
  expect(text(r)).toContain("Install Tailscale on your phone");
  expect(buttons(r)).toEqual(["Copy computer address", "Generate pairing code"]);
});

it("says phone, never one kind of phone, a browser's name or tailnet", () => {
  for (const address of [tailnetAddress, wifiAddress, null]) {
    const r = render({ address });
    // The address itself may carry the word; the copy around it must not.
    const copy = text(r).replaceAll("tailnet-example", "");
    expect(copy).not.toMatch(/iPhone|Safari|tailnet/);
    expect(copy).toContain("phone");
    act(() => r.unmount());
  }
});

it("names what to turn on and offers the button that does it", () => {
  const onTurnOnNetworkAccess = vi.fn();
  const onShowAccessSettings = vi.fn();
  const r = render({ address: null, onTurnOnNetworkAccess, onShowAccessSettings });
  expect(text(r)).toContain("Your phone needs an address for this computer.");
  expect(text(r)).toContain("Network access, for a phone on the same Wi-Fi or network.");
  expect(text(r)).toContain("Tailscale HTTPS, for a phone on your Tailscale network, anywhere.");
  expect(buttons(r)).toEqual(["Set up Tailscale HTTPS", "Turn on Network access"]);
  act(() => button(r, "Turn on Network access").props.onClick());
  expect(onTurnOnNetworkAccess).toHaveBeenCalledTimes(1);
  act(() => button(r, "Set up Tailscale HTTPS").props.onClick());
  expect(onShowAccessSettings).toHaveBeenCalledTimes(1);
});

it("shows where the switches are when it cannot turn one on itself", () => {
  const r = render({ address: null });
  expect(buttons(r)).toEqual(["Show Network access and Tailscale HTTPS"]);
});

it("says where to go in a window that has no such switches", () => {
  const r = render({ address: null, hasAccessControls: false });
  expect(text(r)).toContain("Open SpecWithCode on this computer");
  expect(buttons(r)).toEqual([]);
});

it("shows the code to scan once one is made, and offers its link", () => {
  const onCopyCode = vi.fn();
  const r = render({
    code: {
      status: "ready",
      url: "https://mac.tailnet-example.ts.net/pair#token=x",
      expiresAt: "4:05 PM",
    },
    onCopyCode,
  });
  expect(text(r)).toContain("Scan with your phone");
  expect(text(r)).toContain("expires at 4:05 PM");
  act(() => button(r, "Copy pairing link").props.onClick());
  expect(onCopyCode).toHaveBeenCalledTimes(1);
});

it("asks for a new code when the old one ran out or the address changed", () => {
  let r = render({ code: { status: "expired" } });
  expect(text(r)).toContain("This code expired.");
  expect(buttons(r)).toContain("Generate new code");
  act(() => r.unmount());
  r = render({ code: { status: "route-changed" } });
  expect(text(r)).toContain("The computer address changed.");
});

it("cannot make a code in a window without leave to", () => {
  const r = render({ canPair: false });
  expect(text(r)).toContain("This window cannot create pairing codes.");
  expect(buttons(r)).toEqual(["Copy computer address"]);
});
