// @vitest-environment jsdom
import type { AuthSessionState } from "@specweave-studio/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  linkCode: null as string | null,
  strip: vi.fn(),
  submit: vi.fn(),
  hostedRequest: null as { host: string; token: string; label: string } | null,
  connect: vi.fn(),
}));
vi.mock("../../environments/primary", () => ({
  peekPairingTokenFromUrl: () => mocks.linkCode,
  stripPairingTokenFromUrl: mocks.strip,
  submitServerAuthCredential: mocks.submit,
}));
vi.mock("../../connection/onboarding", () => ({ connectPairing: {} }));
vi.mock("../../hostedPairing", () => ({ readHostedPairingRequest: () => mocks.hostedRequest }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => mocks.connect }));
vi.mock("./DeviceSignInRequestPanel", () => ({
  DeviceSignInRequestPanel: () => <section data-testid="ask-to-sign-in">Ask to sign in</section>,
}));

import {
  HostedPairingRouteSurface,
  PairingPendingSurface,
  PairingRouteSurface,
} from "./PairingRouteSurface";

type Auth = AuthSessionState["auth"];
const withCodes = { bootstrapMethods: ["one-time-token"] } as unknown as Auth;
const desktopOnly = { bootstrapMethods: ["desktop-bootstrap"] } as unknown as Auth;

/** The words a person at this page should never have to read. */
const PLUMBING = /\b(environment|backend|host|secret)s?\b/i;

let root: Root;
let container: HTMLDivElement;
const onAuthenticated = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  mocks.linkCode = null;
  mocks.hostedRequest = null;
  mocks.submit.mockResolvedValue(undefined);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const show = (auth: Auth, initialErrorMessage?: string) =>
  act(async () =>
    root.render(
      <PairingRouteSurface
        auth={auth}
        onAuthenticated={onAuthenticated}
        {...(initialErrorMessage ? { initialErrorMessage } : {})}
      />,
    ),
  );
const text = () => container.textContent ?? "";
const codeSection = () => container.querySelector<HTMLDetailsElement>('[data-testid="pair-code"]')!;
const button = (label: string) =>
  [...container.querySelectorAll("button")].find((element) => element.textContent === label);

describe("the page at a computer's address", () => {
  it("leads with the phone app and says where to sign in to Connect", async () => {
    await show(withCodes);
    const phone = container.querySelector('[data-testid="pair-phone-app"]')!;
    expect(phone.querySelector("h2")?.textContent).toBe("Get the phone app");
    expect(phone.textContent).toContain("sign in to SpecWithCode Connect in the app");
    const link = phone.querySelector("a")!;
    expect(link.textContent).toBe("Get the phone app");
    expect(link.getAttribute("href")).toBe("https://specwithcode.com/get");

    // In page order: the phone app, then asking a signed-in device, then the code.
    const order = [
      phone,
      container.querySelector('[data-testid="ask-to-sign-in"]')!,
      codeSection(),
    ];
    for (const [index, section] of order.entries()) {
      const next = order[index + 1];
      if (next) {
        expect(
          section.compareDocumentPosition(next) & Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();
      }
    }
  });

  it("has no button that signs in to Connect here, where that sign-in cannot load", async () => {
    await show(withCodes);
    const names = [...container.querySelectorAll("button, a")].map(
      (element) => element.textContent,
    );
    expect(names.filter((name) => /sign in to specwithcode connect/i.test(name ?? ""))).toEqual([]);
  });

  it("keeps the code field under I have a pairing code, closed until asked for", async () => {
    await show(withCodes);
    const section = codeSection();
    expect(section.querySelector("summary")?.textContent).toBe("I have a pairing code");
    expect(section.open).toBe(false);
    expect(section.querySelector("#pairing-token")).not.toBeNull();
    expect(section.querySelector("label")?.textContent).toBe("Pairing code");
  });

  it("opens the code field when it is the only way in", async () => {
    await show(desktopOnly);
    expect(container.querySelector('[data-testid="ask-to-sign-in"]')).toBeNull();
    expect(codeSection().open).toBe(true);
    expect(text()).toContain("opened from its desktop app");
  });

  it("opens the code field on an error it has to show", async () => {
    await show(withCodes, "That code has expired.");
    expect(codeSection().open).toBe(true);
    expect(codeSection().textContent).toContain("That code has expired.");
  });

  it("uses the code a pairing link brought, once, and takes it out of the address", async () => {
    mocks.linkCode = "ABCD-1234";
    await show(withCodes);
    expect(mocks.strip).toHaveBeenCalledTimes(1);
    expect(mocks.submit).toHaveBeenCalledTimes(1);
    expect(mocks.submit).toHaveBeenCalledWith("ABCD-1234");
    expect(onAuthenticated).toHaveBeenCalledTimes(1);
    expect(codeSection().open).toBe(true);
  });

  it("shows why a pasted code did not work, with the field open", async () => {
    mocks.submit.mockRejectedValue(new Error("That code was already used."));
    await show(withCodes);
    const section = codeSection();
    const input = section.querySelector<HTMLInputElement>("#pairing-token")!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setValue.call(input, "WRONG");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      section
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(mocks.submit).toHaveBeenCalledWith("WRONG");
    expect(onAuthenticated).not.toHaveBeenCalled();
    expect(section.open).toBe(true);
    expect(section.textContent).toContain("That code was already used.");
    expect(button("Continue")?.disabled).toBe(false);
  });

  it("never says environment, backend, host or secret", async () => {
    await show(withCodes);
    expect(text()).not.toMatch(PLUMBING);
    await show(desktopOnly);
    expect(text()).not.toMatch(PLUMBING);
    await act(async () => root.render(<PairingPendingSurface />));
    expect(text()).toContain("Pairing with this computer");
    expect(text()).not.toMatch(PLUMBING);
  });
});

describe("a pairing link opened on the hosted page", () => {
  it("says computer and address, in plain words, through success", async () => {
    mocks.hostedRequest = { host: "https://box.example:3773", token: "ABCD", label: "Office Mac" };
    mocks.connect.mockResolvedValue({ _tag: "Success", value: undefined });
    await act(async () => root.render(<HostedPairingRouteSurface />));
    expect(mocks.connect).toHaveBeenCalledWith({
      host: "https://box.example:3773",
      pairingCode: "ABCD",
    });
    expect(text()).toContain("Computer paired");
    expect(text()).toContain("Office Mac is saved in this browser.");
    expect(text()).toContain("Address: https://box.example:3773");
    expect(text()).not.toMatch(PLUMBING);
  });

  it("says what is missing from a broken link", async () => {
    await act(async () => root.render(<HostedPairingRouteSurface />));
    expect(text()).toContain("Pairing failed");
    expect(text()).toContain("This pairing link is missing the computer's address or its code.");
    expect(text()).not.toMatch(PLUMBING);
    expect(mocks.connect).not.toHaveBeenCalled();
  });
});
