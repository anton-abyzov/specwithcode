// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import {
  completeRelayClientInstallDialogClose,
  finishRelayClientInstall,
  readRelayClientInstallDialogState,
  requestRelayClientInstallConfirmation,
  respondToRelayClientInstallConfirmation,
  startRelayClientInstallInline,
} from "../../cloud/relayClientInstallDialog";
import { RelayClientInstallDialog } from "./RelayClientInstallDialog";

// The real dialog animates in a portal. Here only whether it is open matters.
vi.mock("../ui/dialog", () => {
  const Part = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Dialog: ({ open, children }: { open: boolean; children?: ReactNode }) => (
      <div data-testid="dialog" data-open={String(open)}>
        {open ? children : null}
      </div>
    ),
    DialogDescription: Part,
    DialogFooter: Part,
    DialogHeader: Part,
    DialogPanel: Part,
    DialogPopup: Part,
    DialogTitle: Part,
  };
});

let host: HTMLDivElement;
let root: Root;

function resetStore() {
  finishRelayClientInstall();
  completeRelayClientInstallDialogClose();
}

async function mount() {
  await act(async () => {
    root.render(<RelayClientInstallDialog />);
  });
}

const isOpen = () =>
  host.querySelector('[data-testid="dialog"]')?.getAttribute("data-open") === "true";

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  resetStore();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  host.remove();
  resetStore();
});

it("opens for the question and for the install that follows a yes", async () => {
  await mount();
  expect(isOpen()).toBe(false);

  let answer!: Promise<boolean>;
  await act(async () => {
    answer = requestRelayClientInstallConfirmation("2026.5.2");
  });
  expect(isOpen()).toBe(true);
  expect(host.textContent).toContain("Install relay client?");

  await act(async () => {
    respondToRelayClientInstallConfirmation(true);
  });
  await expect(answer).resolves.toBe(true);
  expect(isOpen()).toBe(true);
  expect(host.textContent).toContain("Installing relay client");
});

it("stays shut for an install that setup shows in its own row", async () => {
  await mount();
  await act(async () => {
    startRelayClientInstallInline("2026.5.2");
  });

  expect(readRelayClientInstallDialogState()).toMatchObject({ status: "installing" });
  expect(isOpen()).toBe(false);

  await act(async () => {
    finishRelayClientInstall();
  });
  expect(readRelayClientInstallDialogState()).toEqual({ status: "idle" });
});

it("frees a close that the previous dialog never finished", async () => {
  // Setup's dialog asked, the person said no, and setup closed before the close
  // animation ended: nothing reported the close, so the store is still waiting.
  const answer = requestRelayClientInstallConfirmation("2026.5.2");
  respondToRelayClientInstallConfirmation(false);
  await expect(answer).resolves.toBe(false);
  expect(readRelayClientInstallDialogState().status).toBe("closing");

  await mount();

  expect(readRelayClientInstallDialogState()).toEqual({ status: "idle" });
  expect(isOpen()).toBe(false);
  // The next link can ask again.
  let next!: Promise<boolean>;
  await act(async () => {
    next = requestRelayClientInstallConfirmation("2026.5.2");
  });
  expect(isOpen()).toBe(true);
  await act(async () => {
    respondToRelayClientInstallConfirmation(false);
  });
  await expect(next).resolves.toBe(false);
});
