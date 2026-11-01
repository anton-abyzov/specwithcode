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

let renderer: ReactTestRenderer | null = null;
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
});

function render(onUseConnect?: () => void) {
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
        {...(onUseConnect ? { onUseConnect } : {})}
        onGenerate={() => {}}
        onCopyAddress={() => {}}
        onCopyCode={() => {}}
      />,
    );
  });
  return renderer!;
}

const text = (r: ReactTestRenderer) => JSON.stringify(r.toJSON());
const button = (r: ReactTestRenderer, label: string) =>
  r.root.find(
    (node) => node.type === "button" && JSON.stringify(node.props.children) === `"${label}"`,
  );

it("leads with Connect and hides the Tailscale address until the fallback is chosen", () => {
  const onUseConnect = vi.fn();
  const r = render(onUseConnect);
  expect(text(r)).toContain("Add your iPhone with SpecWithCode Connect");
  expect(text(r)).toContain("For a second iPhone");
  expect(text(r)).not.toContain("tailnet-example");
  expect(text(r)).not.toContain("Tailscale on your iPhone");

  act(() => button(r, "Go to SpecWithCode Connect").props.onClick());
  expect(onUseConnect).toHaveBeenCalledOnce();

  act(() => button(r, "Use a private QR code instead").props.onClick());
  expect(text(r)).toContain("Pair with a private QR code");
  expect(text(r)).toContain("tailnet-example");
  expect(text(r)).not.toContain("Add your iPhone with SpecWithCode Connect");
});

it("goes straight to the QR pairing where Connect is not available", () => {
  const r = render();
  expect(text(r)).toContain("Pair with a private QR code");
  expect(text(r)).toContain("tailnet-example");
});
