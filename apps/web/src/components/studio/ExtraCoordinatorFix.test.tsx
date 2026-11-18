// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { ExtraCoordinatorFix } from "./ExtraCoordinatorFix";

const state = vi.hoisted(() => ({
  problems: {} as Record<string, string | null>,
  unlinks: [] as Array<Record<string, unknown>>,
  reply: { text: "M5 has its own coordinator again.", error: false } as {
    text: string;
    error: boolean;
  } | null,
  toasts: [] as Array<Record<string, unknown>>,
  closed: 0,
}));
vi.mock("@specweave-studio/client-runtime/state/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@specweave-studio/client-runtime/state/runtime")>()),
  createEnvironmentRpcCommand: (_runtime: unknown, options: { tag: string }) => options.tag,
}));
vi.mock("./useLinkMachines", () => ({
  useLinkMachines: () => ({
    label: (id: string) => ({ m4: "M4", m5: "M5", m1: "M1" })[id] ?? "Machine",
    state: (id: string) => (state.problems[id] ? "offline" : "ready"),
    problem: (id: string) => state.problems[id] ?? null,
    connected: (id: string) => !state.problems[id],
  }),
}));
// The guard is the real one; only the unlink itself is replaced.
vi.mock("./useUnlinkMember", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./useUnlinkMember")>()),
  useUnlinkMember: () => ({
    busy: false,
    unlink: async (input: Record<string, unknown>) => {
      state.unlinks.push(input);
      return state.reply;
    },
  }),
}));
vi.mock("../ui/toast", () => ({
  toastManager: { add: (toast: Record<string, unknown>) => state.toasts.push(toast) },
}));

const ref = (environmentId: string, projectId: string) => ({
  environmentId,
  projectId,
  coordinatorThreadId: `project-coordinator:${projectId}`,
});
const roster = {
  id: "logical:1",
  title: "EasyChamp",
  coordinatorId: "coordinator:logical:1",
  members: [ref("m4", "main"), ref("m5", "side"), ref("m1", "plain")],
};
const copy = (environmentId: string, id: string, binding: Record<string, unknown>) => ({
  environmentId,
  id,
  title: "EasyChamp",
  workspaceRoot: `/${environmentId}/EasyChamp`,
  workspaceSettings: {
    kind: "code",
    logicalProject: roster,
    coordinatorBinding: { epoch: 0, ...binding },
  },
});
const main = copy("m4", "main", { state: "active" });
const side = copy("m5", "side", { state: "active", epoch: 2, operationId: "op-start" });
const plain = copy("m1", "plain", { state: "transferred", successor: ref("m4", "main") });

let root: Root, container: HTMLDivElement;
const text = () => document.body.textContent ?? "";
const dialog = () => document.querySelector<HTMLElement>("[data-extra-coordinator-fix]")!;
const click = (element: HTMLElement) => act(async () => element.click());
const render = (shared: Array<Record<string, unknown>> = [main, side, plain]) =>
  act(async () =>
    root.render(
      <ExtraCoordinatorFix
        member={side as never}
        coordinator={main as never}
        shared={shared as never}
        projectTitle="EasyChamp"
        onClose={() => state.closed++}
      />,
    ),
  );

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  state.problems = {};
  state.unlinks = [];
  state.reply = { text: "M5 has its own coordinator again.", error: false };
  state.toasts = [];
  state.closed = 0;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

it("says what is so and offers one action, the unlink", async () => {
  await render();
  expect(dialog().getAttribute("data-extra-coordinator-fix")).toBe("explain");
  expect(text()).toContain("Extra coordinator on M5");
  expect(text()).toContain(
    "M5 also runs a coordinator for EasyChamp. The project's coordinator is on M4.",
  );
  expect(text()).toContain(
    "To make M5 part of this project again, link it afterwards. Linking makes it give way to the coordinator on M4.",
  );
  const actions = [...dialog().querySelectorAll<HTMLButtonElement>("button")]
    .map((node) => node.textContent?.trim())
    .filter((label) => label !== "Cancel" && label !== "Close" && label !== "");
  expect(actions).toEqual(["Unlink EasyChamp on M5"]);
  const unlink = dialog().querySelector<HTMLButtonElement>("[data-fix-unlink]")!;
  expect(unlink.disabled).toBe(false);
  expect(dialog().querySelector("[data-fix-refused]")).toBeNull();
});

it("asks to confirm and calls nothing until the confirm is pressed", async () => {
  await render();
  await click(dialog().querySelector<HTMLButtonElement>("[data-fix-unlink]")!);
  expect(state.unlinks).toEqual([]);
  expect(dialog().getAttribute("data-extra-coordinator-fix")).toBe("confirm");
  expect(text()).toContain("Unlink EasyChamp on M5?");
  expect(text()).toContain(
    "It becomes its own project again, with an active coordinator and a copy of this project's notes. M4 stops sending it work. Threads and files stay where they are.",
  );

  // Cancel steps back to the explanation without unlinking.
  const cancel = [...dialog().querySelectorAll<HTMLButtonElement>("button")].find(
    (node) => node.textContent?.trim() === "Cancel",
  )!;
  await click(cancel);
  expect(dialog().getAttribute("data-extra-coordinator-fix")).toBe("explain");
  expect(state.unlinks).toEqual([]);
  expect(state.closed).toBe(0);

  await click(dialog().querySelector<HTMLButtonElement>("[data-fix-unlink]")!);
  await click(dialog().querySelector<HTMLButtonElement>("[data-fix-confirm]")!);
  expect(state.unlinks).toEqual([{ member: side, coordinator: main, shared: [main, side, plain] }]);
  expect(state.toasts).toEqual([{ type: "success", title: "M5 has its own coordinator again." }]);
  expect(state.closed).toBe(1);
});

it("keeps the dialog open and returns to the explanation when the unlink fails", async () => {
  state.reply = { text: "Update SpecWithCode on M5 to unlink it.", error: true };
  await render();
  await click(dialog().querySelector<HTMLButtonElement>("[data-fix-unlink]")!);
  await click(dialog().querySelector<HTMLButtonElement>("[data-fix-confirm]")!);
  expect(state.toasts).toEqual([
    { type: "error", title: "Update SpecWithCode on M5 to unlink it." },
  ]);
  expect(state.closed).toBe(0);
  expect(dialog().getAttribute("data-extra-coordinator-fix")).toBe("explain");
});

it("greys the action and names the machine that still follows this coordinator", async () => {
  const follows = copy("m1", "plain", { state: "transferred", successor: ref("m5", "side") });
  await render([main, side, follows]);
  const unlink = dialog().querySelector<HTMLButtonElement>("[data-fix-unlink]")!;
  expect(unlink.textContent?.trim()).toBe("Unlink EasyChamp on M5");
  expect(unlink.disabled).toBe(true);
  expect(dialog().querySelector("[data-fix-refused]")?.textContent).toBe(
    "M1 still follows the coordinator on M5. Continue the coordinator on another machine first.",
  );
  await click(unlink);
  expect(dialog().getAttribute("data-extra-coordinator-fix")).toBe("explain");
  expect(state.unlinks).toEqual([]);
});

it("greys the action with the machine's problem while it cannot be reached", async () => {
  state.problems = { m5: "Connect M5 first." };
  await render();
  expect(dialog().querySelector<HTMLButtonElement>("[data-fix-unlink]")!.disabled).toBe(true);
  expect(dialog().querySelector("[data-fix-refused]")?.textContent).toBe("Connect M5 first.");
  expect(state.unlinks).toEqual([]);
});

it("offers no unlink for a machine that cannot leave from here, only the project's settings", async () => {
  // Alone in its list: the shape the settings' guard refuses, so no unlink is offered.
  const alone = {
    ...side,
    workspaceSettings: {
      ...side.workspaceSettings,
      logicalProject: { ...roster, members: [ref("m5", "side")] },
    },
  };
  let opened = 0;
  await act(async () =>
    root.render(
      <ExtraCoordinatorFix
        member={alone as never}
        coordinator={main as never}
        shared={[main, alone] as never}
        projectTitle="EasyChamp"
        onOpenSettings={() => opened++}
        onClose={() => state.closed++}
      />,
    ),
  );
  expect(dialog().querySelector("[data-fix-unlink]")).toBeNull();
  expect(dialog().querySelector("[data-fix-refused]")?.textContent).toBe(
    "M5 cannot be unlinked from this window.",
  );
  const settings = dialog().querySelector<HTMLButtonElement>("[data-fix-settings]")!;
  expect(settings.textContent?.trim()).toBe("Open project settings");
  await click(settings);
  expect(opened).toBe(1);
  expect(state.closed).toBe(1);
  expect(state.unlinks).toEqual([]);
});
