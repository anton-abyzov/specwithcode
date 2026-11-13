import { act } from "react";
import { create, type ReactTestInstance } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { AuthOrchestrationOperateScope, EnvironmentId } from "@specweave-studio/contracts";
import type { StudioFleetWorkersResult } from "@specweave-studio/contracts/studioFleet";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";

const store = vi.hoisted(() => ({ values: new Map<string, unknown>() }));
// Where a link into Settings landed: the id the page is asked to reach, and the elements that took it.
const landing = vi.hoisted(() => ({
  targetId: null as string | null,
  reached: [] as Array<string>,
}));
vi.mock("@clerk/react", () => ({ useAuth: vi.fn(), useUser: vi.fn() }));
vi.mock("../../cloud/primaryCloudLinkState", () => ({ usePrimaryCloudLinkState: vi.fn() }));
vi.mock("../../cloud/publicConfig", () => ({ hasCloudPublicConfig: vi.fn() }));
vi.mock("../clerk/useStudioConnectAuthPrompt", () => ({ useStudioConnectAuthPrompt: vi.fn() }));
vi.mock("../../hooks/useLocalStorage", async () => {
  const { useState } = await import("react");
  return {
    // One value per key, kept across mounts like the real store.
    useLocalStorage: (key: string, initial: unknown) => {
      const [value, setValue] = useState(() => store.values.get(key) ?? initial);
      return [
        value,
        (next: unknown) =>
          setValue((current: unknown) => {
            const resolved = typeof next === "function" ? next(current) : next;
            store.values.set(key, resolved);
            return resolved;
          }),
      ];
    },
  };
});
vi.mock("../../studio/fleet", () => ({
  addVisibleMachineToStudioFleet: vi.fn(),
  allowIncomingStudioFleetWorkers: vi.fn(),
  allowStudioFleetWorkers: vi.fn(),
  joinAccountMachineForWorkers: vi.fn(),
  readStudioFleetMachines: vi.fn(),
  useMachineWorkGrants: vi.fn(),
}));
vi.mock("../../state/environments", () => ({
  useEnvironments: vi.fn(),
  useRelayEnvironmentDiscovery: vi.fn(),
}));
vi.mock("../../connection/catalog", () => ({ environmentCatalog: { register: "register" } }));
vi.mock("../../state/relay", () => ({ relayEnvironmentDiscovery: { refresh: "refresh" } }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: vi.fn() }));
vi.mock("../../state/session", () => ({ useEnvironmentScope: vi.fn() }));
vi.mock("../../studio/machineNickname", () => ({ useMachineNicknames: vi.fn() }));
vi.mock("../../confirmDialog", () => ({ requestConfirmDialog: vi.fn() }));
vi.mock("../../env", () => ({ isElectron: true }));
vi.mock("./settingsLayout", () => ({
  useSettingsSearchTargetId: () => landing.targetId,
  // The real hook scrolls to and focuses the element when it mounts as the target.
  useSettingsSearchTarget: (id: string) => (node: { readonly id: string } | null) => {
    if (node && id === landing.targetId) landing.reached.push(node.id);
  },
}));

import { useAuth, useUser } from "@clerk/react";
import { usePrimaryCloudLinkState } from "../../cloud/primaryCloudLinkState";
import { hasCloudPublicConfig } from "../../cloud/publicConfig";
import { requestConfirmDialog } from "../../confirmDialog";
import { useEnvironments, useRelayEnvironmentDiscovery } from "../../state/environments";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  allowStudioFleetWorkers,
  joinAccountMachineForWorkers,
  readStudioFleetMachines,
  useMachineWorkGrants,
} from "../../studio/fleet";
import { useMachineNicknames } from "../../studio/machineNickname";
import { useStudioConnectAuthPrompt } from "../clerk/useStudioConnectAuthPrompt";
import { AccountJoinCard, AccountJoinCardBody } from "./AccountJoinCard";
import {
  JOIN_CARD_ANCHOR,
  JOIN_CARD_FOLDED_STORAGE_KEY,
  type JoinCardConnect,
} from "./AccountJoinCard.logic";

const here = EnvironmentId.make("m4");
const m1 = EnvironmentId.make("m1");
const m3 = EnvironmentId.make("m3");
const m5 = EnvironmentId.make("m5");
const snapshot = { grants: [], projects: [], accounts: [] } as never;
const signedIn: JoinCardConnect = {
  kind: "signed-in",
  account: "anton@example.com",
  connectOn: true,
};
const allowed = {
  id: "m4",
  workers: {
    status: "allowed",
    access: "full-access",
    expiresAt: null,
    renewable: true,
    problem: null,
  },
} as StudioFleetWorkersResult;

/** A machine this app has saved and connected, that takes a join through the shared account. */
function savedMachine(environmentId: EnvironmentId, label: string, phase = "connected") {
  return {
    environmentId,
    label,
    connection: { phase },
    serverConfig: {
      environment: {
        platform: { os: "darwin" },
        serverVersion: "1.0.243",
        capabilities: { fleetAccountJoinWorkers: true },
      },
    },
  };
}

function discoveredMachine(
  environmentId: EnvironmentId,
  label: string,
  availability: "checking" | "online" | "offline" | "error" = "online",
  descriptor?: { platform: { os: string }; serverVersion: string },
) {
  return [
    environmentId,
    {
      environment: { environmentId, label },
      availability,
      status: descriptor ? Option.some({ descriptor }) : Option.none(),
    },
  ] as const;
}

interface World {
  saved?: ReadonlyArray<ReturnType<typeof savedMachine>>;
  discovered?: ReadonlyArray<ReturnType<typeof discoveredMachine>>;
  refreshing?: boolean;
  offline?: boolean;
  open?: ReturnType<typeof vi.fn>;
}

function world({ saved = [], discovered = [], refreshing = false, offline = false, open }: World) {
  vi.mocked(useEnvironments).mockReturnValue({
    environments: [
      { environmentId: here, label: "M4", connection: { phase: "connected" } },
      ...saved,
    ],
  } as never);
  vi.mocked(useRelayEnvironmentDiscovery).mockReturnValue({
    environments: new Map(discovered),
    refreshing,
    offline,
  } as never);
  vi.mocked(useMachineNicknames).mockReturnValue(
    ((_id: string, label?: string | null) => label ?? "") as never,
  );
  // This app manages access here and holds only a SpecWithCode Connect sign-in elsewhere.
  vi.mocked(useEnvironmentScope).mockImplementation(
    ((environmentId: EnvironmentId, scope: string) =>
      environmentId === here || scope === AuthOrchestrationOperateScope) as never,
  );
  const refreshDiscovery = vi.fn(async () => ({ _tag: "Success" }));
  const opened = open ?? vi.fn(async () => ({ _tag: "Success" }));
  vi.mocked(useAtomCommand).mockImplementation(((command: unknown) =>
    command === "register" ? opened : refreshDiscovery) as never);
  const refreshGrants = vi.fn();
  vi.mocked(useMachineWorkGrants).mockReturnValue({
    snapshot,
    loading: false,
    failed: false,
    refresh: refreshGrants,
  } as never);
  return { refreshDiscovery, refreshGrants, open: opened };
}

/** Everything a reader sees in a rendered node, as one string. */
function textOf(node: ReactTestInstance | string): string {
  return typeof node === "string" ? node : node.children.map(textOf).join("");
}

async function mount(element: React.ReactElement, options?: Parameters<typeof create>[1]) {
  let renderer: ReturnType<typeof create> | null = null;
  await act(async () => {
    renderer = create(element, options);
  });
  const root = () => renderer!.root;
  return {
    root,
    text: () => textOf(root()),
    radio: (environmentId: string) => root().findByProps({ type: "radio", value: environmentId }),
    button: (label: string) =>
      root()
        .findAllByType("button")
        .find((candidate) => [candidate.props.children].flat().join("") === label),
    rerender: (next: React.ReactElement) => renderer!.update(next),
    unmount: () => act(async () => renderer!.unmount()),
  };
}

const body = (
  connect: JoinCardConnect = signedIn,
  props: Partial<React.ComponentProps<typeof AccountJoinCardBody>> = {},
) => <AccountJoinCardBody environmentId={here} snapshot={snapshot} connect={connect} {...props} />;

beforeEach(() => {
  store.values.clear();
  landing.targetId = null;
  landing.reached = [];
  vi.mocked(requestConfirmDialog).mockReset();
  vi.mocked(joinAccountMachineForWorkers).mockReset();
});

describe("the machines the join card lists", () => {
  it("lists the account's machines by name with what each reported, and chooses none by itself", async () => {
    const { refreshDiscovery, open } = world({
      saved: [savedMachine(m1, "MacBook M1")],
      discovered: [
        discoveredMachine(m5, "MacBook Pro (2)", "online", {
          platform: { os: "linux" },
          serverVersion: "1.0.240",
        }),
        discoveredMachine(m3, "Mac mini", "checking"),
      ],
    });
    const view = await mount(body());
    expect(refreshDiscovery).toHaveBeenCalled();
    expect(view.text()).toContain("Let another of your machines run work here");
    expect(
      view
        .root()
        .findAllByProps({ type: "radio" })
        .map((radio) => [radio.props.value, radio.props.checked, radio.props.disabled]),
    ).toEqual([
      ["m1", false, false],
      ["m5", false, false],
      ["m3", false, false],
    ]);
    // A machine that reported nothing shows its state alone: nothing is made up.
    expect(view.root().findAllByType("label").map(textOf)).toEqual([
      "MacBook M1macOS · 1.0.243 · online",
      "MacBook Pro (2)Linux · 1.0.240 · online",
      "Mac minichecking…",
    ]);
    // Nothing is opened or allowed until the owner chooses.
    expect(open).not.toHaveBeenCalled();
    const allow = view.button("Choose a machine");
    expect(allow?.props.disabled).toBe(true);
    await view.unmount();
  });

  it("names the shared account only when every listed machine comes from it", async () => {
    world({ discovered: [discoveredMachine(m5, "M5")] });
    const account = await mount(body());
    expect(account.text()).toContain(
      "These machines are signed in to anton@example.com, like this one.",
    );
    await account.unmount();
    world({ saved: [savedMachine(m1, "M1")], discovered: [discoveredMachine(m5, "M5")] });
    const mixed = await mount(body());
    expect(mixed.text()).not.toContain("These machines are signed in to");
    expect(mixed.text()).toContain("Pick the machine whose agents may start work here.");
    await mixed.unmount();
    // Opened in this app and still on the account's list: the account is still named.
    world({ saved: [savedMachine(m5, "M5")], discovered: [discoveredMachine(m5, "M5")] });
    const opened = await mount(body());
    expect(opened.text()).toContain("These machines are signed in to anton@example.com");
    await opened.unmount();
  });

  it("lists a machine that is not answering but does not let it be chosen", async () => {
    const { open } = world({
      discovered: [discoveredMachine(m5, "M5", "offline"), discoveredMachine(m3, "M3", "error")],
    });
    const view = await mount(body());
    expect(view.radio("m5").props.disabled).toBe(true);
    expect(view.radio("m3").props.disabled).toBe(true);
    expect(view.text().match(/not answering right now/g)).toHaveLength(2);
    // Even a change event that slips through opens nothing.
    await act(async () => view.radio("m5").props.onChange());
    expect(open).not.toHaveBeenCalled();
    expect(view.radio("m5").props.checked).toBe(false);
    await view.unmount();
  });

  it("opens an account machine through Connect when it is chosen", async () => {
    const { open } = world({ discovered: [discoveredMachine(m5, "M5")] });
    const view = await mount(body());
    await act(async () => view.radio("m5").props.onChange());
    expect(open).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        target: expect.objectContaining({ environmentId: m5, label: "M5" }),
      }),
    );
    expect(view.radio("m5").props.checked).toBe(true);
    expect(view.root().findAllByProps({ role: "alert" })).toHaveLength(0);
    await view.unmount();
  });

  it("ignores another choice while a machine is being opened, without taking the keyboard's place", async () => {
    let finish: (result: { _tag: string }) => void = () => {};
    const { open } = world({
      discovered: [discoveredMachine(m5, "M5"), discoveredMachine(m3, "M3")],
      open: vi.fn(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      ),
    });
    const view = await mount(body());
    await act(async () => view.radio("m5").props.onChange());
    expect(view.text()).toContain("Opening M5 through SpecWithCode Connect…");
    // Arrow keys on a radio group choose as they move: the next one must not open too.
    expect(view.radio("m3").props["aria-disabled"]).toBe(true);
    expect(view.radio("m3").props.disabled).toBe(false);
    await act(async () => view.radio("m3").props.onChange());
    expect(open).toHaveBeenCalledTimes(1);
    expect(view.radio("m5").props.checked).toBe(true);
    await act(async () => finish({ _tag: "Success" }));
    expect(view.radio("m3").props["aria-disabled"]).toBe(false);
    await view.unmount();
  });

  it("goes back to no choice when the machine cannot be opened, so it can be chosen again", async () => {
    const { open } = world({
      discovered: [discoveredMachine(m5, "M5")],
      open: vi.fn(async () => ({ _tag: "Failure", cause: Cause.fail("offline") })),
    });
    const view = await mount(body());
    await act(async () => view.radio("m5").props.onChange());
    expect(view.radio("m5").props.checked).toBe(false);
    expect(view.root().findByProps({ role: "alert" }).props.children).toContain(
      "Could not open M5 through SpecWithCode Connect",
    );
    await act(async () => view.radio("m5").props.onChange());
    expect(open).toHaveBeenCalledTimes(2);
    await view.unmount();
  });
});

describe("allowing the chosen machine", () => {
  it("names the chosen machine on the button and says how long it lasts", async () => {
    world({ saved: [savedMachine(m1, "M1"), savedMachine(m3, "M3")] });
    const view = await mount(body());
    expect(view.text()).toContain("Until you stop it, here or on that machine.");
    await act(async () => view.radio("m1").props.onChange());
    expect(view.button("Allow M1")?.props.disabled).toBe(false);
    expect(view.text()).toContain("Until you stop it here or on M1. It renews by itself.");
    expect(view.text()).not.toContain("while both");
    await act(async () => view.radio("m3").props.onChange());
    expect(view.button("Allow M1")).toBeUndefined();
    expect(view.button("Allow M3")?.props.disabled).toBe(false);
    expect(view.text()).toContain("Until you stop it here or on M3. It renews by itself.");
    expect(view.text()).toContain("Not included. Each secret transfer still asks you.");
    await view.unmount();
  });

  it("gives a dated grant its own wording when the account cannot carry the join", async () => {
    world({ saved: [savedMachine(m1, "M1")] });
    // A sign-in that manages access on M1: the older path, whose grant has an end date.
    vi.mocked(useEnvironmentScope).mockReturnValue(true);
    const view = await mount(body());
    await act(async () => view.radio("m1").props.onChange());
    // That machine decides whether the grant renews; the card does not promise either way.
    expect(view.text()).toContain(
      "Until you stop it here or on M1. After Allow, this card says whether it renews by itself or ends on a date.",
    );
    expect(view.text()).not.toContain("It renews by itself.");
    await view.unmount();
  });

  it("keeps the chosen access when the owner picks another machine", async () => {
    world({ saved: [savedMachine(m1, "M1"), savedMachine(m3, "M3")] });
    const view = await mount(body());
    const access = () => view.root().findByProps({ "aria-label": "Most access for incoming work" });
    expect(access().props.value).toBe("full-access");
    await act(async () => view.radio("m1").props.onChange());
    await act(async () => access().props.onChange({ target: { value: "approval-required" } }));
    await act(async () => view.radio("m3").props.onChange());
    expect(access().props.value).toBe("approval-required");
    await view.unmount();
  });

  it("allows through the shared account after one confirmation and shows the done state", async () => {
    const { refreshGrants } = world({ saved: [savedMachine(m1, "M1")] });
    vi.mocked(requestConfirmDialog).mockResolvedValue(true);
    vi.mocked(joinAccountMachineForWorkers).mockResolvedValue(allowed);
    const onDone = vi.fn();
    const view = await mount(body(signedIn, { onDone }));
    await act(async () => view.radio("m1").props.onChange());
    await act(async () => view.button("Allow M1")?.props.onClick());
    expect(requestConfirmDialog).toHaveBeenCalledTimes(1);
    expect(joinAccountMachineForWorkers).toHaveBeenCalledExactlyOnceWith({
      here,
      coordinator: m1,
      coordinatorLabel: "M1",
      access: "full-access",
    });
    expect(onDone).toHaveBeenCalledExactlyOnceWith({
      environmentId: m1,
      label: "M1",
      access: "full-access",
    });
    expect(refreshGrants).toHaveBeenCalled();
    expect(view.text()).toContain("M1 can run work here · Full access · renews by itself");
    expect(view.text()).toContain("On M1: done");
    expect(view.text()).toContain("choose Revoke under Who can run work here");
    // Allowed is not finished: the machine takes no work until it holds a project.
    expect(view.text()).toContain(
      "Next, on M1: this machine can only run a project it has a copy of.",
    );
    // The choice is over: no machine list and no Allow button are left.
    expect(view.root().findAllByProps({ type: "radio" })).toHaveLength(0);
    await view.unmount();
  });

  it("holds the list still while Allow runs, so the choice cannot change under it", async () => {
    world({ saved: [savedMachine(m1, "M1"), savedMachine(m3, "M3")] });
    vi.mocked(requestConfirmDialog).mockResolvedValue(true);
    let finish: (result: StudioFleetWorkersResult) => void = () => {};
    vi.mocked(joinAccountMachineForWorkers).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const onDone = vi.fn();
    const view = await mount(body(signedIn, { onDone }));
    await act(async () => view.radio("m1").props.onChange());
    await act(async () => view.button("Allow M1")?.props.onClick());
    expect(view.button("Setting up…")?.props.disabled).toBe(true);
    // Still focusable, so the keyboard keeps its place, but a change is ignored.
    expect(view.radio("m3").props["aria-disabled"]).toBe(true);
    expect(view.radio("m3").props.disabled).toBe(false);
    await act(async () => view.radio("m3").props.onChange());
    expect(view.radio("m1").props.checked).toBe(true);
    expect(view.radio("m3").props.checked).toBe(false);
    expect(joinAccountMachineForWorkers).toHaveBeenCalledTimes(1);
    await act(async () => finish(allowed));
    expect(onDone).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ environmentId: m1, label: "M1" }),
    );
    expect(view.text()).toContain("M1 can run work here · Full access · renews by itself");
    await view.unmount();
  });

  it("lets another machine be chosen again after an Allow that failed", async () => {
    world({ saved: [savedMachine(m1, "M1"), savedMachine(m3, "M3")] });
    vi.mocked(requestConfirmDialog).mockResolvedValue(true);
    vi.mocked(joinAccountMachineForWorkers).mockRejectedValue(new Error("M1 refused."));
    const view = await mount(body());
    await act(async () => view.radio("m1").props.onChange());
    await act(async () => view.button("Allow M1")?.props.onClick());
    expect(view.root().findByProps({ role: "alert" }).props.children).toBe("M1 refused.");
    expect(view.radio("m3").props["aria-disabled"]).toBe(false);
    await act(async () => view.radio("m3").props.onChange());
    expect(view.button("Allow M3")).toBeDefined();
    await view.unmount();
  });

  it("allows from the first-run card without a second confirmation, and says what the key covers", async () => {
    world({ saved: [savedMachine(m1, "M1")] });
    vi.mocked(joinAccountMachineForWorkers).mockResolvedValue(allowed);
    const onDone = vi.fn();
    const view = await mount(body(signedIn, { variant: "first-run", onDone }));
    await act(async () => view.radio("m1").props.onChange());
    // The card states what the confirmation said, so the press is the decision.
    expect(view.text()).toContain(
      "It also gets a key to manage access, updates and skills on this machine, for a year.",
    );
    await act(async () => view.button("Allow M1")?.props.onClick());
    expect(requestConfirmDialog).not.toHaveBeenCalled();
    expect(joinAccountMachineForWorkers).toHaveBeenCalledOnce();
    expect(onDone).toHaveBeenCalledOnce();
    await view.unmount();
  });

  it("allows nothing when the owner declines the confirmation", async () => {
    world({ saved: [savedMachine(m1, "M1")] });
    vi.mocked(requestConfirmDialog).mockResolvedValue(false);
    const onDone = vi.fn();
    const view = await mount(body(signedIn, { onDone }));
    await act(async () => view.radio("m1").props.onChange());
    await act(async () => view.button("Allow M1")?.props.onClick());
    expect(joinAccountMachineForWorkers).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
    expect(view.button("Allow M1")).toBeDefined();
    await view.unmount();
  });

  it("names the SpecWithCode Connect switch when this machine has no Connect address to hand over", async () => {
    world({ saved: [savedMachine(m1, "M1")] });
    vi.mocked(requestConfirmDialog).mockResolvedValue(true);
    vi.mocked(joinAccountMachineForWorkers).mockRejectedValue(
      Object.assign(new Error("This machine is not linked to SpecWithCode Connect."), {
        reason: "connect_not_linked",
      }),
    );
    const view = await mount(body());
    await act(async () => view.radio("m1").props.onChange());
    await act(async () => view.button("Allow M1")?.props.onClick());
    expect(view.root().findByProps({ role: "alert" }).props.children).toBe(
      "SpecWithCode Connect is off on M4, so M1 has no address to reach it. On M4, turn on the SpecWithCode Connect switch in Settings > Machines, then choose Allow again.",
    );
    expect(view.text()).not.toContain("can run work here ·");
    await view.unmount();
  });

  it("says why a saved machine that is not connected cannot be allowed yet", async () => {
    world({ saved: [savedMachine(m1, "M1", "disconnected")] });
    const view = await mount(body());
    expect(view.text()).toContain("not connected in this app");
    await act(async () => view.radio("m1").props.onChange());
    expect(view.button("Allow M1")?.props.disabled).toBe(true);
    expect(view.text()).toContain("Connect to M1 first.");
    await view.unmount();
  });
});

describe("landing on the card from the account menu", () => {
  // Elements stand in for DOM nodes, so the card's ref has something to reach.
  const nodes: NonNullable<Parameters<typeof create>[1]> = {
    createNodeMock: (element) => ({ id: (element.props as { id?: string }).id ?? "" }),
  };

  it("is not a destination until a link names it", async () => {
    world({ discovered: [discoveredMachine(m5, "M5")] });
    const view = await mount(body(), nodes);
    expect(view.root().findByProps({ id: JOIN_CARD_ANCHOR })).toBeDefined();
    expect(landing.reached).toEqual([]);
    await view.unmount();
  });

  it("is reached when it appears after the page, once who can run work here is known", async () => {
    world({ discovered: [discoveredMachine(m5, "M5")] });
    landing.targetId = JOIN_CARD_ANCHOR;
    const grants = { snapshot: null as typeof snapshot | null, loading: true, failed: false };
    vi.mocked(useMachineWorkGrants).mockImplementation(
      () => ({ ...grants, refresh: vi.fn() }) as never,
    );
    const view = await mount(<AccountJoinCard environmentId={here} />, nodes);
    // Nothing to land on yet: the card is not drawn while the list is being read.
    expect(view.root().findAllByProps({ id: JOIN_CARD_ANCHOR })).toHaveLength(0);
    expect(landing.reached).toEqual([]);
    grants.snapshot = snapshot;
    grants.loading = false;
    await act(async () => view.rerender(<AccountJoinCard environmentId={here} />));
    expect(landing.reached).toContain(JOIN_CARD_ANCHOR);
    expect(view.radio("m5")).toBeDefined();
    await view.unmount();
  });

  it("opens a card that was folded with Not now, and keeps it open", async () => {
    world({ discovered: [discoveredMachine(m5, "M5")] });
    store.values.set(JOIN_CARD_FOLDED_STORAGE_KEY, { environments: [here] });
    landing.targetId = JOIN_CARD_ANCHOR;
    const view = await mount(body(), nodes);
    expect(landing.reached).toContain(JOIN_CARD_ANCHOR);
    expect(view.radio("m5").props.checked).toBe(false);
    expect(store.values.get(JOIN_CARD_FOLDED_STORAGE_KEY)).toEqual({ environments: [] });
    await view.unmount();
  });

  it("leaves a folded card folded when the link points somewhere else", async () => {
    world({ discovered: [discoveredMachine(m5, "M5")] });
    store.values.set(JOIN_CARD_FOLDED_STORAGE_KEY, { environments: [here] });
    landing.targetId = "private-machines-device-code";
    const view = await mount(body(), nodes);
    expect(view.root().findAllByProps({ type: "radio" })).toHaveLength(0);
    expect(landing.reached).toEqual([]);
    await view.unmount();
  });

  it("never unfolds a first-run step, which has no fold", async () => {
    world({ discovered: [discoveredMachine(m5, "M5")] });
    store.values.set(JOIN_CARD_FOLDED_STORAGE_KEY, { environments: [here] });
    landing.targetId = JOIN_CARD_ANCHOR;
    const view = await mount(body(signedIn, { variant: "first-run" }), nodes);
    expect(view.radio("m5")).toBeDefined();
    expect(store.values.get(JOIN_CARD_FOLDED_STORAGE_KEY)).toEqual({ environments: [here] });
    await view.unmount();
  });
});

describe("Not now", () => {
  it("folds the card to one line that opens it again, and remembers it on this device", async () => {
    world({ discovered: [discoveredMachine(m5, "M5")] });
    const view = await mount(body());
    await act(async () => view.button("Not now")?.props.onClick());
    expect(view.root().findAllByProps({ type: "radio" })).toHaveLength(0);
    expect(view.text()).toContain("Let another of your machines run work here");
    expect(store.values.get(JOIN_CARD_FOLDED_STORAGE_KEY)).toEqual({ environments: ["m4"] });
    await view.unmount();
    // A later visit starts folded.
    const again = await mount(body());
    expect(again.root().findAllByProps({ type: "radio" })).toHaveLength(0);
    await act(async () => again.button("Show")?.props.onClick());
    expect(again.radio("m5").props.checked).toBe(false);
    expect(store.values.get(JOIN_CARD_FOLDED_STORAGE_KEY)).toEqual({ environments: [] });
    await again.unmount();
  });

  it("is Skip in a first-run step, which never folds", async () => {
    world({ discovered: [discoveredMachine(m5, "M5")] });
    store.values.set(JOIN_CARD_FOLDED_STORAGE_KEY, { environments: ["m4"] });
    const onSkip = vi.fn();
    const view = await mount(body(signedIn, { variant: "first-run", onSkip }));
    expect(view.radio("m5").props.checked).toBe(false);
    expect(view.button("Not now")).toBeUndefined();
    await act(async () => view.button("Skip")?.props.onClick());
    expect(onSkip).toHaveBeenCalledTimes(1);
    expect(view.radio("m5")).toBeDefined();
    expect(store.values.get(JOIN_CARD_FOLDED_STORAGE_KEY)).toEqual({ environments: ["m4"] });
    await view.unmount();
  });
});

describe("the join card with no machine to list", () => {
  it("asks for the SpecWithCode Connect sign-in and opens it", async () => {
    world({});
    const onSignIn = vi.fn();
    const view = await mount(body({ kind: "signed-out" }, { onSignIn }));
    expect(view.text()).toContain(
      "Sign in to SpecWithCode Connect on this machine. Your other machines on the same account are then listed here.",
    );
    await act(async () => view.button("Sign in to SpecWithCode Connect")?.props.onClick());
    expect(onSignIn).toHaveBeenCalledTimes(1);
    expect(view.button("Check again")).toBeUndefined();
    // Signed out, the card does not speak of an account it cannot see.
    expect(view.text()).not.toContain("your SpecWithCode Connect account are listed");
    // With nothing to choose there is one next step, not a dead Allow form under it.
    expect(view.button("Choose a machine")).toBeUndefined();
    expect(
      view.root().findAllByProps({ "aria-label": "Most access for incoming work" }),
    ).toHaveLength(0);
    // The card can still be put away.
    await act(async () => view.button("Not now")?.props.onClick());
    expect(store.values.get(JOIN_CARD_FOLDED_STORAGE_KEY)).toEqual({ environments: ["m4"] });
    await view.unmount();
  });

  it("waits while the sign-in is read", async () => {
    world({});
    const view = await mount(body({ kind: "loading" }));
    expect(view.text()).toContain("Checking your SpecWithCode Connect sign-in…");
    expect(view.button("Sign in to SpecWithCode Connect")).toBeUndefined();
    await view.unmount();
  });

  it("names the Connect switch when Connect is off on this machine, and shows where it is", async () => {
    world({ discovered: [discoveredMachine(m5, "M5")] });
    const onShowConnectSwitch = vi.fn();
    const off: JoinCardConnect = { ...signedIn, connectOn: false } as JoinCardConnect;
    const view = await mount(body(off, { onShowConnectSwitch }));
    expect(view.text()).toContain(
      "SpecWithCode Connect is off on this machine, so your other machines cannot reach it. Turn on the SpecWithCode Connect switch in Settings > Machines, then choose Allow.",
    );
    await act(async () => view.button("Show the switch")?.props.onClick());
    expect(onShowConnectSwitch).toHaveBeenCalledTimes(1);
    // The machines stay listed: the owner sees what turning the switch on is for.
    expect(view.radio("m5")).toBeDefined();
    await view.unmount();
    const plain = await mount(body(off));
    expect(plain.button("Show the switch")).toBeUndefined();
    await plain.unmount();
  });

  it("says nothing about the switch while its state is unknown or on", async () => {
    world({});
    for (const connectOn of [null, true]) {
      const view = await mount(body({ ...signedIn, connectOn } as JoinCardConnect));
      expect(view.text()).not.toContain("SpecWithCode Connect is off");
      await view.unmount();
    }
  });

  it("says the one next step when the account has no other machine, and checks again", async () => {
    const { refreshDiscovery } = world({});
    const view = await mount(body());
    expect(view.text()).toContain(
      "No other machine is signed in to anton@example.com yet. On the other machine, install SpecWithCode and sign in to SpecWithCode Connect with this account. It is then listed here.",
    );
    refreshDiscovery.mockClear();
    await act(async () => view.button("Check again")?.props.onClick());
    expect(refreshDiscovery).toHaveBeenCalledTimes(1);
    await view.unmount();
    const unnamed = await mount(body({ ...signedIn, account: null } as JoinCardConnect));
    expect(unnamed.text()).toContain(
      "No other machine is on your SpecWithCode Connect account yet.",
    );
    await unnamed.unmount();
  });

  it("does not say there is no other machine when each one is already listed as allowed", async () => {
    world({ saved: [savedMachine(m1, "M1")], discovered: [discoveredMachine(m5, "M5")] });
    const allAllowed = {
      grants: [{ coordinatorEnvironmentId: m1 }, { coordinatorEnvironmentId: m5 }],
      projects: [],
      accounts: [],
    } as never;
    const view = await mount(body(signedIn, { snapshot: allAllowed }));
    expect(view.root().findAllByProps({ type: "radio" })).toHaveLength(0);
    expect(view.text()).toContain(
      "Every other machine this app knows is already listed under Who can run work here in Settings > Machines. Change, revoke or restore it there.",
    );
    expect(view.text()).not.toContain("No other machine");
    await view.unmount();
    // Signed out, signing in may still list more machines: that step comes first.
    const signedOut = await mount(body({ kind: "signed-out" }, { snapshot: allAllowed }));
    expect(signedOut.text()).toContain("Sign in to SpecWithCode Connect on this machine.");
    expect(signedOut.text()).not.toContain("Every other machine");
    await signedOut.unmount();
    // One machine left to allow: it is listed, and nothing claims they all are.
    const oneLeft = await mount(
      body(signedIn, {
        snapshot: {
          grants: [{ coordinatorEnvironmentId: m1 }],
          projects: [],
          accounts: [],
        } as never,
      }),
    );
    expect(oneLeft.radio("m5")).toBeDefined();
    expect(oneLeft.text()).not.toContain("Every other machine");
    await oneLeft.unmount();
  });

  it("says it is still looking while the account's machines are read", async () => {
    world({ refreshing: true });
    const view = await mount(body());
    expect(view.text()).toContain("Looking for your other machines…");
    expect(view.text()).not.toContain("No other machine");
    expect(view.button("Check again")).toBeUndefined();
    await view.unmount();
  });

  it("says SpecWithCode Connect cannot be reached instead of claiming there is no machine", async () => {
    world({ offline: true });
    const view = await mount(body());
    expect(view.text()).toContain("SpecWithCode Connect cannot be reached right now");
    expect(view.text()).not.toContain("No other machine");
    expect(view.button("Check again")).toBeDefined();
    await view.unmount();
  });

  it("points a build without SpecWithCode Connect at the code and join line", async () => {
    world({});
    const settings = await mount(body({ kind: "none" }));
    expect(settings.text()).toContain("open Another account, or no Connect below.");
    // A build without SpecWithCode Connect is not told about a Connect account.
    expect(settings.text()).not.toContain("your SpecWithCode Connect account");
    await settings.unmount();
    const firstRun = await mount(body({ kind: "none" }, { variant: "first-run" }));
    expect(firstRun.text()).toContain(
      "open Settings > Machines, then Another account, or no Connect.",
    );
    await firstRun.unmount();
  });
});

describe("the join card on its own", () => {
  it("reads the sign-in and the Connect switch by itself in a build with SpecWithCode Connect", async () => {
    world({});
    vi.mocked(hasCloudPublicConfig).mockReturnValue(true);
    vi.mocked(useAuth).mockReturnValue({ isLoaded: true, isSignedIn: false } as never);
    vi.mocked(useUser).mockReturnValue({ user: null } as never);
    vi.mocked(usePrimaryCloudLinkState).mockReturnValue({ data: null } as never);
    const openAuthPrompt = vi.fn();
    vi.mocked(useStudioConnectAuthPrompt).mockReturnValue({
      authPrompt: null,
      openAuthPrompt,
      openSetupAuthPrompt: vi.fn(),
    });
    const signedOut = await mount(<AccountJoinCard environmentId={here} />);
    // A pending Clerk session is not "signed out": the card must not ask to sign in again.
    expect(useAuth).toHaveBeenCalledWith({ treatPendingAsSignedOut: false });
    await act(async () => signedOut.button("Sign in to SpecWithCode Connect")?.props.onClick());
    expect(openAuthPrompt).toHaveBeenCalledTimes(1);
    await signedOut.unmount();

    vi.mocked(useAuth).mockReturnValue({ isLoaded: true, isSignedIn: true } as never);
    vi.mocked(useUser).mockReturnValue({
      user: { primaryEmailAddress: { emailAddress: "anton@example.com" } },
    } as never);
    vi.mocked(usePrimaryCloudLinkState).mockReturnValue({
      data: { linked: true, managedTunnelActive: false },
    } as never);
    const off = await mount(<AccountJoinCard environmentId={here} />);
    expect(off.text()).toContain("SpecWithCode Connect is off on this machine");
    expect(off.text()).toContain("No other machine is signed in to anton@example.com yet.");
    await off.unmount();
  });

  it("works in a build without SpecWithCode Connect, where no sign-in is read", async () => {
    world({ saved: [savedMachine(m1, "M1")] });
    vi.mocked(hasCloudPublicConfig).mockReturnValue(false);
    vi.mocked(useAuth).mockClear();
    const view = await mount(<AccountJoinCard environmentId={here} />);
    expect(useAuth).not.toHaveBeenCalled();
    expect(view.radio("m1")).toBeDefined();
    await view.unmount();
  });

  it("shows nothing in Settings until this machine says who may run work here", async () => {
    world({});
    vi.mocked(hasCloudPublicConfig).mockReturnValue(false);
    vi.mocked(useMachineWorkGrants).mockReturnValue({
      snapshot: null,
      loading: true,
      failed: false,
      refresh: vi.fn(),
    } as never);
    const settings = await mount(<AccountJoinCard environmentId={here} />);
    expect(settings.text()).toBe("");
    await settings.unmount();
    // A first-run step is a whole screen: it says what it waits for.
    const firstRun = await mount(<AccountJoinCard environmentId={here} variant="first-run" />);
    expect(firstRun.text()).toContain("Checking who can run work here…");
    await firstRun.unmount();
  });

  it("keeps the done state through a refresh of the grants, also one that fails", async () => {
    world({ saved: [savedMachine(m1, "M1")] });
    vi.mocked(hasCloudPublicConfig).mockReturnValue(false);
    // This app manages access on M1 too, so the older path allows without Connect.
    vi.mocked(useEnvironmentScope).mockReturnValue(true);
    vi.mocked(requestConfirmDialog).mockResolvedValue(true);
    vi.mocked(readStudioFleetMachines).mockResolvedValue([
      { id: "m4-line", environmentId: here, status: "reachable", pairingConfigured: true },
    ] as never);
    vi.mocked(allowStudioFleetWorkers).mockResolvedValue(allowed);
    const grants = { snapshot, loading: false, failed: false, refresh: vi.fn() };
    vi.mocked(useMachineWorkGrants).mockImplementation(() => grants as never);
    const view = await mount(<AccountJoinCard environmentId={here} />);
    await act(async () => view.radio("m1").props.onChange());
    await act(async () => view.button("Allow M1")?.props.onClick());
    expect(view.text()).toContain("M1 can run work here · Full access · renews by itself");
    // The list is read again after Allow.
    grants.loading = true;
    await act(async () => view.rerender(<AccountJoinCard environmentId={here} />));
    expect(view.text()).toContain("M1 can run work here · Full access · renews by itself");
    // That read fails; the last list is still held, and the grant exists.
    grants.loading = false;
    grants.failed = true;
    await act(async () => view.rerender(<AccountJoinCard environmentId={here} />));
    expect(view.text()).toContain("M1 can run work here · Full access · renews by itself");
    expect(view.text()).toContain("On M1: done");
    await view.unmount();
  });
});
