// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { MainOffer } from "../../studio/makeMain";
import { coordinatorBoxState } from "../../studio/coordinatorBoxState";
import { CoordinatorBlockedNotice, OfflineSwitchNotice } from "./CoordinatorBlockedNotice";

let root: Root, container: HTMLDivElement;
beforeEach(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

const offer = (extra: Partial<MainOffer> = {}): MainOffer => ({
  key: "m5:copy",
  machine: "M5",
  main: "M4",
  kind: "move",
  reason: null,
  note: null,
  block: null,
  ...extra,
});
/** The box on M5 while the coordinator for Atlas is on M4, by the page's own rule. */
const box = (over: Partial<Parameters<typeof coordinatorBoxState>[0]> = {}) =>
  coordinatorBoxState({
    project: "Atlas",
    machine: "M4",
    routes: true,
    machineConnected: true,
    mayOperate: true,
    hasFiles: false,
    movedTo: null,
    offer: offer(),
    ...over,
  });
const buttons = () => [...container.querySelectorAll("button")];
const texts = () => buttons().map((button) => button.textContent);
const part = (name: string) => container.querySelector(`[data-${name}]`);
const line = () => part("box-line")?.textContent ?? null;
const continueNote = () => part("continue-here-note")?.textContent ?? null;
const continueButton = () => part("continue-here") as HTMLButtonElement | null;

async function show(props: Partial<Parameters<typeof CoordinatorBlockedNotice>[0]> = {}) {
  await act(async () =>
    root.render(
      <CoordinatorBlockedNotice
        text="The coordinator is on another machine. Send opens it there."
        box={box()}
        coordinatorKey="m4:main"
        onContinue={() => {}}
        {...props}
      />,
    ),
  );
}

it("says where the coordinator is, and offers Continue here beside it", async () => {
  const onContinue = vi.fn();
  await show({ onContinue });
  const status = container.querySelector("[data-workers-only]");
  expect(status?.getAttribute("data-workers-only")).toBe("m4:main");
  expect(status?.getAttribute("data-box-state")).toBe("routes");
  expect(line()).toBe("The coordinator for Atlas is on M4. Send opens it there.");
  // Send is the message box's own button: the notice has no write button of its own.
  expect(texts()).toEqual(["Continue here"]);
  expect(continueNote()).toBe(
    "Continue here syncs M5, then moves the coordinator conversation here from M4.",
  );
  await act(async () => continueButton()!.click());
  expect(onContinue).toHaveBeenCalledTimes(1);
});

it("never names a role or offers to run a second coordinator here", async () => {
  await show({ hadConversation: true });
  expect(line()).toBe(
    "The coordinator for Atlas is on M4. Send opens it there. The conversation here is kept as history.",
  );
  expect(texts().some((text) => /again|start|main|copy|write/i.test(text ?? ""))).toBe(false);
  expect(container.textContent).not.toMatch(/\bmain\b|this copy/i);
});

it("keeps Continue here greyed with the time it unlocks while the old machine was just lost", async () => {
  const onContinue = vi.fn();
  await show({
    onContinue,
    box: box({
      routes: false,
      machineConnected: false,
      offer: offer({
        kind: "blocked",
        block: "waiting",
        reason: {
          text: "{main} must be silent for 10 minutes before the coordinator can continue on {machine}. That unlocks in {minutes} min.",
          values: { main: "M4", machine: "M5", minutes: "4" },
        },
        note: { text: "in {minutes} min", values: { minutes: "4" } },
      }),
    }),
  });
  expect(part("workers-only")?.getAttribute("data-box-state")).toBe("waiting");
  expect(line()).toBe("M4 is not answering. Continue here unlocks in 4 min.");
  expect(continueButton()?.disabled).toBe(true);
  expect(continueNote()).toBe("in 4 min");
  await act(async () => continueButton()!.click());
  expect(onContinue).not.toHaveBeenCalled();
});

it("says what a read-only window must do, with Continue here greyed for the same reason", async () => {
  await show({
    box: box({
      routes: false,
      mayOperate: false,
      offer: offer({
        kind: "blocked",
        block: "main-read-only",
        reason: {
          text: "This window can only read {main}, so it cannot hand the coordinator off from there. Open SpecWithCode on {main}, or connect to it with full access.",
          values: { main: "M4", machine: "M5" },
        },
        note: { text: "read-only on {main}", values: { main: "M4" } },
      }),
    }),
  });
  expect(line()).toBe(
    "This window can only read M4, so it cannot send there. Open SpecWithCode on M4, or connect to it with full access.",
  );
  expect(continueButton()?.disabled).toBe(true);
  expect(continueNote()).toBe("read-only on M4");
});

it("says the old conversation stays readable before continuing a silent coordinator here", async () => {
  await show({
    box: box({
      routes: false,
      machineConnected: false,
      offer: offer({ kind: "takeover", silentMinutes: 12 }),
    }),
  });
  expect(part("workers-only")?.getAttribute("data-box-state")).toBe("silent");
  expect(line()).toBe(
    "M4 has been offline for 12 minutes. Continue here: the coordinator starts on M5 from the shared goal, memory and plan. Its conversation on M4 stays readable there, and M4 gives way when it is back.",
  );
  // The box's own button is the primary "Continue here and send": no second button here.
  expect(continueButton()).toBeNull();
});

it("keeps Continue here pressable while files keep Send off or the machine refused a message", async () => {
  await show({ box: box({ hasFiles: true }) });
  expect(line()).toBe(
    "Files stay on this machine. Remove them to send the text, or open Atlas on M4 to attach them there.",
  );
  expect(continueButton()?.disabled).toBe(false);
  await show({ box: box({ refused: "The coordinator is paused." }) });
  expect(line()).toBe("M4 did not take the message: The coordinator is paused. Nothing was sent.");
  expect(continueButton()?.disabled).toBe(false);
  await show({ box: box({ machine: "linux-mini", movedTo: "linux-mini" }) });
  expect(line()).toBe("The coordinator moved to linux-mini. Nothing was sent.");
});

it("offers no Continue here where the machine shown has none, or before choices load", async () => {
  await show({ box: box({ offer: null }) });
  expect(texts()).toEqual([]);
  expect(container.textContent).toBe("The coordinator for Atlas is on M4. Send opens it there.");
  await show({ onContinue: null });
  expect(texts()).toEqual([]);
});

it("names no machine it does not know", async () => {
  await show({ box: box({ machine: null, routes: false, offer: null }) });
  expect(line()).toBe(
    "The coordinator for Atlas is on another machine that this window cannot reach.",
  );
  expect(texts()).toEqual([]);
});

it("says any other reason plainly, with no actions", async () => {
  await show({ text: "Reconnect its machine to send messages.", box: null });
  expect(container.querySelector("[data-workers-only]")).toBeNull();
  expect(texts()).toEqual([]);
  expect(container.querySelector("[role='status']")?.textContent).toBe(
    "Reconnect its machine to send messages.",
  );
});

it("says after an offline switch that the old conversation stays on the old machine, until put away", async () => {
  const render = (id: string, previous: string | null = "M4") =>
    act(async () =>
      root.render(<OfflineSwitchNotice key={id} id={id} machine="M5" previous={previous} />),
    );
  await render("m5:copy:op-1");
  expect(container.querySelector("[data-offline-switch] p")?.textContent).toBe(
    "The coordinator continued on M5 while M4 was offline. It started from the shared goal, memory and plan; the earlier conversation stays on M4 as history.",
  );
  await act(async () => buttons()[0]!.click());
  expect(container.querySelector("[data-offline-switch]")).toBeNull();
  // Put away for that switch on a later visit too; a later switch is said again.
  await render("m5:copy:op-1");
  expect(container.querySelector("[data-offline-switch]")).toBeNull();
  await render("m5:copy:op-2", null);
  expect(container.querySelector("[data-offline-switch] p")?.textContent).toBe(
    "The coordinator continued on M5 while its old machine was offline. It started from the shared goal, memory and plan; the earlier conversation stays on the old machine as history.",
  );
});
