// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";
import type { OrchestratorCopy } from "../../studio/projectCoordinatorMachine";

const NOW = 1_800_000_000_000;
const state = vi.hoisted(() => ({
  offline: new Set<string>(),
  /** Machines this window may operate, write files and use Git on. */
  writable: new Set<string>(),
  /** Scopes this window is denied, by name, so each required scope is checked. */
  deniedScopes: new Set<string>(),
  /** When each unreachable machine was last seen. */
  lastSeen: new Map<string, number>(),
  takeover: vi.fn(),
  acceptStandby: vi.fn(),
  other: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("@specweave-studio/client-runtime/state/runtime", () => ({
  createEnvironmentRpcCommand: (_runtime: unknown, options: { tag: string }) => options.tag,
  squashAtomCommandFailure: (result: { cause: unknown }) => result.cause,
}));
vi.mock("../../connection/runtime", () => ({ connectionAtomRuntime: null }));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (tag: string) =>
    /takeover/i.test(tag)
      ? state.takeover
      : /acceptStandby/i.test(tag)
        ? state.acceptStandby
        : state.other,
}));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({
    environments: ["m4", "m5", "mini"].map((environmentId) => ({
      environmentId,
      serverConfig: { environment: { capabilities: { coordinatorRearm: true } } },
    })),
  }),
}));
vi.mock("../../state/session", () => ({
  useEnvironmentsWithScope: (_environments: unknown, scope: string) =>
    state.deniedScopes.has(scope) ? new Set<string>() : state.writable,
}));
vi.mock("../../lib/machineLastSeen", () => ({ useMachineLastSeenVersion: () => 0 }));
vi.mock("../settings/useReplacedMachineRecords", () => ({
  useRetiredMachineRecords: () => new Map(),
}));
vi.mock("./useLinkMachines", () => ({
  useLinkMachines: () => ({
    label: (environmentId: string) => environmentId.toUpperCase(),
    connected: (environmentId: string) => !state.offline.has(environmentId),
    takeoverReady: () => true,
  }),
}));
// Settings' own page is not under test: only its "how long gone" reading is used.
vi.mock("./ProjectMachinesSettings", () => ({
  unreachableSince: (environmentId: string, connected: boolean) =>
    connected ? null : (state.lastSeen.get(environmentId) ?? null),
}));
vi.mock("../ui/toast", () => ({ toastManager: { add: state.toast } }));
vi.mock("../ui/dialog", () => {
  const Part = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  return {
    Dialog: ({ open, children }: { open: boolean; children?: React.ReactNode }) =>
      open ? <div role="dialog">{children}</div> : null,
    DialogPopup: Part,
    DialogHeader: Part,
    DialogTitle: ({ children }: { children?: React.ReactNode }) => <h2>{children}</h2>,
    DialogDescription: ({ children }: { children?: React.ReactNode }) => <p>{children}</p>,
    DialogPanel: Part,
    DialogFooter: Part,
  };
});

const { useMakeMain } = await import("./useMakeMain");
const { pendingMainMove, takeMainMove } = await import("../../studio/makeMain");
const { TAKEOVER_UNREACHABLE_MS } = await import("../../studio/projectLink");
type MainSwitch = ReturnType<typeof useMakeMain>;

const ref = (environmentId: string) => ({
  environmentId,
  projectId: "p",
  coordinatorThreadId: "project-coordinator:p",
});
const logicalProject = {
  id: "atlas",
  title: "Atlas",
  coordinatorId: "coordinator:atlas",
  members: ["m4", "m5", "mini"].map(ref),
};
const member = (environmentId: string, main: boolean) =>
  ({
    environmentId,
    id: "p",
    title: "Atlas",
    workspaceRoot: `/${environmentId}/atlas`,
    workspaceSettings: {
      kind: "code",
      logicalProject,
      coordinatorBinding: main
        ? { epoch: 3, state: "active" }
        : { epoch: 3, state: "transferred", successor: ref("m4") },
    },
  }) as unknown as EnvironmentProject;
const members = [member("m4", true), member("m5", false), member("mini", false)];
const copies: OrchestratorCopy[] = members.map((item) => ({
  key: `${item.environmentId}:p`,
  machine: item.environmentId.toUpperCase(),
  folder: item.workspaceRoot,
  role: item.environmentId === "m4" ? "coordinator" : "workers",
  main: item.environmentId === "m4",
  rowRole: item.environmentId === "m4" ? "main" : "copy",
  label: { text: item.environmentId === "m4" ? "Coordinator" : "" },
  canStart: false,
}));

let root: Root, container: HTMLDivElement;
let main: MainSwitch;
const openMove = vi.fn<(key: string) => void>();
const onCheckout = vi.fn<(key: string) => void>();

function Page({ viewing, canMove = true }: { viewing: string; canMove?: boolean }) {
  main = useMakeMain({
    project: members.find((item) => item.environmentId === viewing)!,
    members,
    copies,
    enabled: true,
    openMove: canMove ? openMove : null,
    onCheckout,
  });
  return <>{main.element}</>;
}
const view = (viewing: string, canMove = true) =>
  act(async () => root.render(<Page viewing={viewing} canMove={canMove} />));
const kinds = () => Object.fromEntries(main.offers.map((offer) => [offer.key, offer.kind]));
const dialog = () => container.querySelector('[role="dialog"]');
const press = (text: string) =>
  act(async () =>
    [...container.querySelectorAll("button")].find((b) => b.textContent === text)!.click(),
  );

beforeEach(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.setSystemTime(NOW);
  state.offline = new Set();
  state.deniedScopes = new Set();
  state.writable = new Set(["m4", "m5", "mini"]);
  state.lastSeen = new Map();
  for (const mock of [state.takeover, state.acceptStandby, state.other, state.toast])
    mock.mockReset();
  state.acceptStandby.mockResolvedValue({ _tag: "Success", value: {} });
  openMove.mockReset();
  onCheckout.mockReset();
  takeMainMove("m4:p");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
});

it("offers the switch to every linked copy and never to main", async () => {
  await view("m4");
  expect(kinds()).toEqual({ "m5:p": "move", "mini:p": "move" });
});

it("opens main's own confirmed move when main is the page in view", async () => {
  await view("m4");
  await act(async () => main.run!("m5:p"));
  expect(openMove).toHaveBeenCalledWith("m5:p");
  expect(onCheckout).not.toHaveBeenCalled();
  expect(dialog()).toBeNull();
  expect(state.takeover).not.toHaveBeenCalled();
  expect(state.other).not.toHaveBeenCalled();
});

it("shows main's page from a copy's page, opens the move there and returns when it closes", async () => {
  await view("m5");
  await act(async () => main.run!("m5:p"));
  // Nothing opens on the copy's page: the conversation to move is on main's.
  expect(openMove).not.toHaveBeenCalled();
  expect(onCheckout).toHaveBeenCalledWith("m4:p");
  expect(pendingMainMove("m4:p", NOW)).toMatchObject({
    from: "m4:p",
    to: "m5:p",
    returnTo: "m5:p",
  });
  onCheckout.mockClear();
  await view("m4");
  expect(openMove).toHaveBeenCalledWith("m5:p");
  expect(pendingMainMove("m4:p", NOW)).toBeNull();
  // A page that only unmounts reports "closed" too; only a dialog that opened returns.
  await act(async () => main.moveOpenChange(false));
  expect(onCheckout).not.toHaveBeenCalled();
  await act(async () => main.moveOpenChange(true));
  await act(async () => main.moveOpenChange(false));
  expect(onCheckout).toHaveBeenCalledWith("m5:p");
});

it("says so when main's page cannot open the move, instead of leaving the click with nothing", async () => {
  await view("m5");
  await act(async () => main.run!("m5:p"));
  await view("m4", false);
  expect(openMove).not.toHaveBeenCalled();
  expect(state.toast).toHaveBeenCalledWith(
    expect.objectContaining({
      type: "warning",
      title: "The coordinator cannot be handed off from this machine yet.",
    }),
  );
});

it("refuses a move this window could only read from, with what to do instead", async () => {
  state.writable = new Set(["m5", "mini"]);
  await view("m5");
  const offer = main.offers.find((item) => item.key === "m5:p")!;
  expect(offer.kind).toBe("blocked");
  expect(offer.block).toBe("main-read-only");
  expect(offer.reason?.text).toBe(
    "This window can only read {main}, so it cannot hand the coordinator off from there. Open SpecWithCode on {main}, or connect to it with full access.",
  );
  const after = { continued: vi.fn(), stopped: vi.fn() };
  await act(async () => main.run!("m5:p", after));
  expect(onCheckout).not.toHaveBeenCalled();
  expect(state.toast).toHaveBeenCalledWith(
    expect.objectContaining({
      type: "warning",
      title: "The coordinator cannot continue on M5 yet.",
      description:
        "This window can only read M4, so it cannot hand the coordinator off from there. Open SpecWithCode on M4, or connect to it with full access.",
    }),
  );
  // A refused switch continued nothing.
  expect(after.continued).not.toHaveBeenCalled();
  expect(after.stopped).toHaveBeenCalledTimes(1);
});

it("refuses the move when any one of the three scopes on main is missing", async () => {
  for (const scope of ["orchestration:operate", "filesystem:write", "source-control:write"]) {
    state.deniedScopes = new Set([scope]);
    await view("m5");
    const offer = main.offers.find((item) => item.key === "m5:p")!;
    expect(offer.kind, scope).toBe("blocked");
    state.deniedScopes = new Set();
  }
});

it("stays off, counting down, until the old main has been unreachable for 10 minutes", async () => {
  state.offline = new Set(["m4"]);
  state.lastSeen.set("m4", NOW - 4 * 60_000);
  await view("m5");
  const offer = () => main.offers.find((item) => item.key === "m5:p")!;
  expect(offer().kind).toBe("blocked");
  expect(offer().block).toBe("waiting");
  expect(offer().note).toMatchObject({ text: "in {minutes} min", values: { minutes: "6" } });
  await act(async () => vi.advanceTimersByTime(TAKEOVER_UNREACHABLE_MS - 4 * 60_000));
  expect(offer().kind).toBe("takeover");
  expect(offer().silentMinutes).toBe(10);
});

it("asks once, then takes over from the unreachable main and never starts a second coordinator", async () => {
  state.offline = new Set(["m4"]);
  state.lastSeen.set("m4", NOW - TAKEOVER_UNREACHABLE_MS);
  state.takeover.mockResolvedValue({
    _tag: "Success",
    value: {
      logicalProject,
      coordinatorBinding: { epoch: 4, state: "active" },
      notesWritten: 0,
      replicaFrom: null,
      replayed: false,
      epochClaims: [{ machine: "mini", label: "MINI", outcome: "unreachable" }],
    },
  });
  await view("m5");
  expect(kinds()).toEqual({ "m5:p": "takeover", "mini:p": "takeover" });
  const after = { continued: vi.fn(), stopped: vi.fn() };
  await act(async () => main.run!("m5:p", after));
  // Nothing has run: the old conversation stays behind, so the person confirms first.
  expect(state.takeover).not.toHaveBeenCalled();
  expect(after.continued).not.toHaveBeenCalled();
  expect(after.stopped).not.toHaveBeenCalled();
  expect(dialog()?.querySelector("h2")?.textContent).toBe("Continue the coordinator on M5?");
  expect(dialog()?.querySelector("p")?.textContent).toBe(
    "M4 has been offline for 10 minutes or more. The coordinator starts on M5 from the shared goal, memory and plan. The conversation on M4 stays there as history. Until M4 is back it can still start work on its own machine; then it gives way and lists what it ran meanwhile.",
  );
  await press("Continue here");
  expect(state.takeover).toHaveBeenCalledTimes(1);
  expect(state.takeover.mock.calls[0]![0]).toMatchObject({
    environmentId: "m5",
    input: { projectId: "p", knownEpoch: 3, predecessor: { environmentId: "m4", projectId: "p" } },
  });
  expect(state.other).not.toHaveBeenCalled();
  expect(openMove).not.toHaveBeenCalled();
  // The other reachable copy's standby stands down; the unreachable old main is not asked.
  expect(state.acceptStandby.mock.calls.map((call) => call[0].environmentId)).toEqual(["mini"]);
  expect(state.acceptStandby.mock.calls[0]![0].input).toMatchObject({
    standby: null,
    belowEpoch: 4,
  });
  expect(dialog()).toBeNull();
  expect(state.toast).toHaveBeenCalledWith(
    expect.objectContaining({
      type: "success",
      title: "The coordinator continues on M5",
      description:
        "It starts from the shared goal, memory and plan. The conversation on M4 stays there as history, and M4 gives way when it is back.",
    }),
  );
  expect(state.toast).toHaveBeenCalledWith(
    expect.objectContaining({
      type: "warning",
      title: "The coordinator continues on M5. MINI have not confirmed it yet.",
    }),
  );
  // The caller is told once that the coordinator continues here, and never that it stopped.
  expect(after.continued).toHaveBeenCalledTimes(1);
  expect(after.stopped).not.toHaveBeenCalled();
});

it("shows Starting the coordinator… while the offline switch runs", async () => {
  state.offline = new Set(["m4"]);
  state.lastSeen.set("m4", NOW - TAKEOVER_UNREACHABLE_MS);
  let finish: (value: unknown) => void = () => {};
  state.takeover.mockReturnValue(new Promise((resolve) => (finish = resolve)));
  await view("m5");
  await act(async () => main.run!("m5:p"));
  await press("Continue here");
  const buttons = [...container.querySelectorAll("button")];
  expect(buttons.map((button) => button.textContent)).toEqual([
    "Cancel",
    "Starting the coordinator…",
  ]);
  expect(buttons.every((button) => button.disabled)).toBe(true);
  await act(async () => finish({ _tag: "Failure", cause: new Error("Refused.") }));
  expect(dialog()).toBeNull();
});

it("cancels an offline switch without running anything", async () => {
  state.offline = new Set(["m4"]);
  state.lastSeen.set("m4", NOW - TAKEOVER_UNREACHABLE_MS);
  await view("m5");
  const after = { continued: vi.fn(), stopped: vi.fn() };
  await act(async () => main.run!("m5:p", after));
  await press("Cancel");
  expect(dialog()).toBeNull();
  expect(state.takeover).not.toHaveBeenCalled();
  expect(after.stopped).toHaveBeenCalledTimes(1);
  expect(after.continued).not.toHaveBeenCalled();
});

it("says why when the takeover is refused", async () => {
  state.offline = new Set(["m4"]);
  state.lastSeen.set("m4", NOW - TAKEOVER_UNREACHABLE_MS);
  state.takeover.mockResolvedValue({
    _tag: "Failure",
    cause: new Error("Another machine already took over."),
  });
  await view("m5");
  const after = { continued: vi.fn(), stopped: vi.fn() };
  await act(async () => main.run!("m5:p", after));
  await press("Continue here");
  expect(state.toast).toHaveBeenCalledWith(
    expect.objectContaining({
      type: "error",
      title: "The coordinator stayed on M4",
      description: "Another machine already took over.",
    }),
  );
  expect(dialog()).toBeNull();
  expect(after.stopped).toHaveBeenCalledTimes(1);
  expect(after.continued).not.toHaveBeenCalled();
});

it("tells the caller nothing continued when the switch only opens the confirmed move", async () => {
  await view("m4");
  const after = { continued: vi.fn(), stopped: vi.fn() };
  await act(async () => main.run!("m5:p", after));
  expect(openMove).toHaveBeenCalledWith("m5:p");
  expect(after.stopped).toHaveBeenCalledTimes(1);
  expect(after.continued).not.toHaveBeenCalled();
});

it("tells the caller nothing continued for a machine without the switch", async () => {
  await view("m5");
  const after = { continued: vi.fn(), stopped: vi.fn() };
  await act(async () => main.run!("m1:p", after));
  expect(after.stopped).toHaveBeenCalledTimes(1);
  expect(after.continued).not.toHaveBeenCalled();
});

it("tells an earlier caller it stopped when a second switch replaces its confirm", async () => {
  state.offline = new Set(["m4"]);
  state.lastSeen.set("m4", NOW - TAKEOVER_UNREACHABLE_MS);
  await view("m5");
  const first = { continued: vi.fn(), stopped: vi.fn() };
  const second = { continued: vi.fn(), stopped: vi.fn() };
  await act(async () => main.run!("m5:p", first));
  await act(async () => main.run!("mini:p", second));
  expect(first.stopped).toHaveBeenCalledTimes(1);
  expect(second.stopped).not.toHaveBeenCalled();
  expect(dialog()?.querySelector("h2")?.textContent).toBe("Continue the coordinator on MINI?");
});

it("offers nothing for a project that never moves", async () => {
  function Off() {
    main = useMakeMain({
      project: members[1]!,
      members,
      copies,
      enabled: false,
      openMove,
      onCheckout,
    });
    return null;
  }
  await act(async () => root.render(<Off />));
  expect(main.offers).toEqual([]);
  expect(main.run).toBeNull();
});
