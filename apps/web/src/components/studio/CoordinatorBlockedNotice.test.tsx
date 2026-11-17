// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { MainOffer } from "../../studio/makeMain";
import type { OrchestratorCopy } from "../../studio/projectCoordinatorMachine";
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

const copy = (key: string, machine: string, main: boolean): OrchestratorCopy => ({
  key,
  machine,
  folder: `/${machine}/atlas`,
  role: main ? "coordinator" : "workers",
  main,
  label: main ? { text: "Main" } : { text: "Copy" },
  canStart: false,
});
const offer = (extra: Partial<MainOffer> = {}): MainOffer => ({
  key: "m5:copy",
  machine: "M5",
  main: "M4",
  kind: "move",
  reason: null,
  note: null,
  ...extra,
});
const buttons = () => [...container.querySelectorAll("button")];
const texts = () => buttons().map((button) => button.textContent);
const note = (name: string) => container.querySelector(`[data-${name}]`)?.textContent ?? null;

async function show(props: Partial<Parameters<typeof CoordinatorBlockedNotice>[0]> = {}) {
  await act(async () =>
    root.render(
      <CoordinatorBlockedNotice
        text="Main for Atlas is M4. This copy takes work from there."
        coordinator={{ key: "m4:main", machine: "M4" }}
        projectTitle="Atlas"
        current="m5:copy"
        copies={[copy("m4:main", "M4", true), copy("m5:copy", "M5", false)]}
        onOpen={() => {}}
        mainOffer={offer()}
        onMakeMain={() => {}}
        {...props}
      />,
    ),
  );
}

it("names main for the project, and offers to write there or make this machine main", async () => {
  const onOpen = vi.fn();
  const onMakeMain = vi.fn();
  await show({ onOpen, onMakeMain });
  expect(container.querySelector("p")?.textContent).toBe(
    "Main for Atlas is M4. This copy takes work from there.",
  );
  expect(texts()).toEqual(["Write to M4's coordinator", "Make M5 main"]);
  // Writing opens main's page, and the box says so before the click.
  expect(note("write-to-main-note")).toBe(
    "Write opens M4's page for this project, where its coordinator answers. Nothing is sent from here.",
  );
  expect(note("make-main-note")).toBe(
    "Making M5 main moves the coordinator and its conversation here from M4, which becomes a copy.",
  );
  await act(async () => buttons()[0]!.click());
  expect(onOpen).toHaveBeenCalledWith("m4:main");
  await act(async () => buttons()[1]!.click());
  expect(onMakeMain).toHaveBeenCalledWith("m5:copy");
});

it("never offers to run a second coordinator here", async () => {
  await show({ hadConversation: true });
  expect(container.querySelector("p")?.textContent).toBe(
    "Main for Atlas is M4. This copy takes work from there. The conversation here is kept as history.",
  );
  expect(texts().some((text) => /again|start/i.test(text ?? ""))).toBe(false);
});

it("keeps Make main off with the time it unlocks while the old main was just lost", async () => {
  const onMakeMain = vi.fn();
  await show({
    onMakeMain,
    mainOffer: offer({
      kind: "blocked",
      reason: {
        text: "{main} must be unreachable for 10 minutes before {machine} can become main. That unlocks in {minutes} min.",
        values: { main: "M4", machine: "M5", minutes: "4" },
      },
      note: { text: "in {minutes} min", values: { minutes: "4" } },
    }),
  });
  expect(buttons()[1]?.disabled).toBe(true);
  expect(note("make-main-note")).toBe(
    "M4 must be unreachable for 10 minutes before M5 can become main. That unlocks in 4 min.",
  );
  await act(async () => buttons()[1]!.click());
  expect(onMakeMain).not.toHaveBeenCalled();
});

it("says what a read-only window must do instead of opening a move that would be refused", async () => {
  await show({
    mainOffer: offer({
      kind: "blocked",
      reason: {
        text: "This window can only read {main}, so it cannot move main from there. Open SpecWithCode on {main}, or connect to it with full access, to make {machine} main.",
        values: { main: "M4", machine: "M5" },
      },
      note: { text: "read-only on {main}", values: { main: "M4" } },
    }),
  });
  expect(buttons()[1]?.disabled).toBe(true);
  expect(note("make-main-note")).toBe(
    "This window can only read M4, so it cannot move main from there. Open SpecWithCode on M4, or connect to it with full access, to make M5 main.",
  );
});

it("says the old conversation stays behind before an offline switch", async () => {
  await show({ mainOffer: offer({ kind: "takeover" }) });
  expect(buttons()[1]?.disabled).toBe(false);
  expect(
    container.querySelector("[data-make-main-note]")?.getAttribute("data-make-main-note"),
  ).toBe("takeover");
  expect(note("make-main-note")).toBe(
    "M4 has been unreachable for 10 minutes or more. Making M5 main starts from the shared goal, memory and plan; the conversation on M4 stays there as history.",
  );
});

it("offers no switch where the copy has none, and no write before choices load", async () => {
  await show({ mainOffer: null, onOpen: null });
  expect(texts()).toEqual([]);
  expect(container.textContent).toBe("Main for Atlas is M4. This copy takes work from there.");
  await show({ onMakeMain: null });
  expect(texts()).toEqual(["Write to M4's coordinator"]);
});

it("names no machine it does not know", async () => {
  await show({ coordinator: { key: "m4:main", machine: null }, mainOffer: null });
  expect(container.querySelector("p")?.textContent).toBe(
    "Main for Atlas is on another machine. This copy takes work from there.",
  );
  expect(texts()).toEqual(["Write to main's coordinator"]);
});

it("says any other reason plainly, with no actions", async () => {
  await show({ text: "Reconnect its machine to send messages.", coordinator: null });
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
    "M5 became main while M4 was unreachable. It started from the shared goal, memory and plan; the earlier conversation stays on M4 as history.",
  );
  await act(async () => buttons()[0]!.click());
  expect(container.querySelector("[data-offline-switch]")).toBeNull();
  // Put away for that switch on a later visit too; a later switch is said again.
  await render("m5:copy:op-1");
  expect(container.querySelector("[data-offline-switch]")).toBeNull();
  await render("m5:copy:op-2", null);
  expect(container.querySelector("[data-offline-switch] p")?.textContent).toBe(
    "M5 became main while the old main was unreachable. It started from the shared goal, memory and plan; the earlier conversation stays on the old machine as history.",
  );
});

it("says Send goes to main's coordinator when the box routes there", async () => {
  await show({ routesToMain: true });
  expect(note("routes-to-main")).toBe(
    "Send delivers your message to M4's coordinator and opens its page, where the answer comes.",
  );
  // "Nothing is sent from here" would be false now.
  expect(note("write-to-main-note")).toBeNull();
  expect(texts()).toEqual(["Write to M4's coordinator", "Make M5 main"]);
});
