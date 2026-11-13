// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { setLocalePreference } from "../../i18n";
import { composerHostStatus, type HostAdmissionContext } from "../../studio/projectWorkspaceModel";
import { ComposerHostStatus, syncedAgoPhrase } from "./ComposerHostStatus";

const NOW = Date.parse("2026-11-13T18:00:00Z");
const remote: HostAdmissionContext = {
  isThisDevice: false,
  graceElapsed: true,
  machineLabel: "linux-box",
};
const here: HostAdmissionContext = { isThisDevice: true, graceElapsed: true };

describe("composerHostStatus", () => {
  it("says a dropped machine is offline once, with what happens next", () => {
    const status = composerHostStatus({ phase: "reconnecting" }, remote);
    expect(status).toMatchObject({
      tone: "offline",
      headline: "{machine} is offline",
      machine: "linux-box",
      progress: "Reconnecting…",
      action: null,
      showsSync: true,
      keepsDraft: true,
    });
    expect(status.detail.join(" ")).not.toContain("cannot take messages");
    expect(composerHostStatus({ phase: "error" }, remote).progress).toBeNull();
  });
  it("names each state a host passes through", () => {
    const states = (["connecting", "reconnecting", "offline", "error"] as const).map(
      (phase) => composerHostStatus({ phase }, remote).headline,
    );
    expect(states).toEqual([
      "Connecting to {machine}…",
      "{machine} is offline",
      "This device is offline",
      "{machine} is offline",
    ]);
    expect(
      composerHostStatus({ phase: "error", blockedReason: "authentication" }, remote),
    ).toMatchObject({
      tone: "signed-out",
      headline: "Signed out of {machine}",
      action: "Reload the page to sign in again.",
    });
  });
  it("keeps this machine busy, never offline, and quiet inside the grace", () => {
    expect(composerHostStatus({ phase: "reconnecting" }, here).headline).toBe(
      "SpecWithCode on this machine is busy",
    );
    expect(
      composerHostStatus({ phase: "reconnecting" }, { ...here, graceElapsed: false }),
    ).toMatchObject({ headline: "Catching up…", detail: [] });
    expect(composerHostStatus({ phase: "error" }, here).action).toBe(
      "Quit and reopen the app to continue.",
    );
  });
  it("falls back to this host when the machine has no name", () => {
    const status = composerHostStatus(
      { phase: "reconnecting" },
      { isThisDevice: false, graceElapsed: true },
    );
    expect(status).toMatchObject({
      headline: "This host is offline",
      machine: null,
      showsSync: false,
      keepsDraft: false,
      detail: ["If this does not clear, reload the page.", "Nothing is sent to another machine."],
    });
  });
});

describe("syncedAgoPhrase", () => {
  it("says how old the copy is in the interface language", () => {
    expect(syncedAgoPhrase(null, NOW, "en")).toEqual({ phrase: "Never synced on this device." });
    expect(syncedAgoPhrase(NOW - 20_000, NOW, "en")).toEqual({ phrase: "Synced just now." });
    expect(syncedAgoPhrase(NOW - 12 * 60_000, NOW, "en")).toEqual({
      phrase: "Last synced {age}.",
      age: "12 minutes ago",
    });
    expect(syncedAgoPhrase(NOW - 3 * 3_600_000, NOW, "de").age).toBe("vor 3 Stunden");
  });
});

let root: Root, container: HTMLDivElement;
beforeEach(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  setLocalePreference("en");
});

async function show(phase: string, context = remote, lastSyncedAt: number | null = NOW) {
  await act(async () =>
    root.render(
      <ComposerHostStatus
        status={composerHostStatus({ phase }, context)}
        now={NOW}
        lastSyncedAt={lastSyncedAt}
      />,
    ),
  );
}
const toggle = () => container.querySelector<HTMLButtonElement>(".sws-host-status-toggle");

describe("ComposerHostStatus", () => {
  it("shows one short line, with the rest behind Details, opened in place", async () => {
    await show("reconnecting");
    expect(container.querySelectorAll("[data-host-status]")).toHaveLength(1);
    expect(container.querySelector("[role=status]")?.textContent).toContain(
      "linux-box is offline · Reconnecting…",
    );
    expect(container.querySelector("[data-host-status-detail]")).toBeNull();
    expect(toggle()?.getAttribute("aria-expanded")).toBe("false");
    await act(async () => toggle()!.click());
    const detail = container.querySelector("[data-host-status-detail]");
    expect(detail?.textContent).toBe(
      "Synced just now. This page shows the copy synced here, read-only. Nothing is sent to another machine.",
    );
    expect(toggle()?.getAttribute("aria-expanded")).toBe("true");
    expect(toggle()?.getAttribute("aria-controls")).toBe(detail?.id);
    await act(async () => toggle()!.click());
    expect(container.querySelector("[data-host-status-detail]")).toBeNull();
  });
  it("gives the machine's name its own element, titled in full only when cut off", async () => {
    const name = "build-server-for-the-specwithcode-release-train-and-nightly-e2e-01";
    await show("error", { ...remote, machineLabel: name });
    const machine = container.querySelector<HTMLElement>("[data-machine-name]")!;
    expect(machine.textContent).toBe(name);
    // Nothing on the line carries a title by default: a native tooltip would open
    // under the pointer, over the message box.
    expect(container.querySelectorAll("[title]")).toHaveLength(0);
    const hover = () => machine.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
    Object.defineProperty(machine, "scrollWidth", { configurable: true, value: 400 });
    Object.defineProperty(machine, "clientWidth", { configurable: true, value: 120 });
    await act(async () => hover());
    expect(machine.getAttribute("title")).toBe(name);
    Object.defineProperty(machine, "scrollWidth", { configurable: true, value: 120 });
    await act(async () => hover());
    expect(machine.hasAttribute("title")).toBe(false);
  });
  it("moves through reconnecting, connected and back without a second line", async () => {
    await show("reconnecting");
    await show("connecting");
    expect(container.querySelector("[role=status]")?.textContent).toContain(
      "Connecting to linux-box…",
    );
    // Connecting has no detail to show, so no Details button.
    expect(toggle()).toBeNull();
    await act(async () => root.render(null));
    expect(container.querySelector("[data-host-status]")).toBeNull();
    await show("error");
    expect(container.querySelectorAll("[data-host-status]")).toHaveLength(1);
  });
  it("puts the action on the line when the person must act", async () => {
    await act(async () =>
      root.render(
        <ComposerHostStatus
          status={composerHostStatus({ phase: "error", blockedReason: "authentication" }, remote)}
          now={NOW}
          lastSyncedAt={NOW}
        />,
      ),
    );
    expect(container.querySelector("[role=status]")?.textContent).toContain(
      "Signed out of linux-box · Reload the page to sign in again.",
    );
    expect(toggle()).toBeNull();
  });
  it("speaks the interface language", async () => {
    setLocalePreference("de");
    await show("reconnecting", remote, NOW - 3 * 3_600_000);
    expect(container.querySelector("[role=status]")?.textContent).toContain(
      "linux-box ist offline · Verbinde neu…",
    );
    await act(async () => toggle()!.click());
    expect(container.querySelector("[data-host-status-detail]")?.textContent).toContain(
      "Zuletzt synchronisiert vor 3 Stunden.",
    );
  });
});
