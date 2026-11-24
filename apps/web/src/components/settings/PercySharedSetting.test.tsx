import type { ReactNode } from "react";
import { act, createContext, useContext } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

// Fictional machines: Studio is the window's own, Laptop is reachable, Tower is not.
type Access = "granted" | "denied" | "signed-out" | "unknown";
const mocks = vi.hoisted(() => ({
  ownId: "studio" as string | null,
  shared: { enabled: false, machines: [] as string[] },
  aideEnabled: true,
  ownAccess: "granted" as Access,
  otherAccess: new Map<string, Access>(),
  environments: [] as Array<{
    environmentId: string;
    label: string;
    connection: { phase: string };
  }>,
  projects: [] as unknown[],
  // Machines the relay lists under the window's Connect account.
  accountMachines: [] as string[],
  discoveryRefreshing: false,
  status: vi.fn(),
  set: vi.fn(),
  undo: vi.fn(),
  preview: vi.fn(),
}));

vi.mock("~/hooks/useSettings", () => ({
  usePrimarySettings: (
    selector: (settings: { personalAssistantShared: unknown; aideEnabled: boolean }) => unknown,
  ) => selector({ personalAssistantShared: mocks.shared, aideEnabled: mocks.aideEnabled }),
}));
vi.mock("../../state/environments", () => ({
  usePrimaryEnvironmentId: () => mocks.ownId,
  useEnvironments: () => ({ environments: mocks.environments }),
  useRelayEnvironmentDiscovery: () => ({
    environments: new Map(mocks.accountMachines.map((id) => [id, { environment: {} }])),
    refreshing: mocks.discoveryRefreshing,
  }),
}));
vi.mock("../../state/session", () => ({
  useEnvironmentScopeAccess: () => mocks.ownAccess,
  useEnvironmentsScopeAccess: () => mocks.otherAccess,
}));
vi.mock("../../state/entities", () => ({ useProjects: () => mocks.projects }));
vi.mock("../../studio/personalShareCommands", () => ({
  setPersonalSharedCommand: { name: "set" },
  personalShareStatusCommand: { name: "status" },
  undoPersonalShareCommand: { name: "undo" },
  personalLinkPreviewCommand: { name: "preview" },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: { name: "set" | "status" | "undo" | "preview" }) => mocks[command.name],
}));
vi.mock("@specweave-studio/client-runtime/state/runtime", () => ({
  squashAtomCommandFailure: (result: { error: unknown }) => result.error,
}));
vi.mock("../../studio/machineNickname", () => ({
  useMachineNicknames: () => (environmentId: string, label?: string | null) =>
    label ?? environmentId,
}));
vi.mock("./settingsLayout", () => ({
  SettingsRow: (props: {
    id?: string;
    title: ReactNode;
    description?: ReactNode;
    status?: ReactNode;
    control?: ReactNode;
    children?: ReactNode;
  }) => (
    <section id={props.id}>
      <h3 data-title>{props.title}</h3>
      <p data-description>{props.description}</p>
      <div data-status>{props.status}</div>
      {props.control}
      {props.children}
    </section>
  ),
}));
vi.mock("./settingsSearch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./settingsSearch")>();
  return { searchableSetting: actual.searchableSetting };
});
vi.mock("../ui/switch", () => ({
  Switch: (props: {
    checked: boolean;
    disabled?: boolean;
    onCheckedChange: (checked: boolean) => void;
    "aria-label": string;
  }) => (
    <button
      type="button"
      role="switch"
      aria-checked={props.checked}
      aria-label={props["aria-label"]}
      disabled={props.disabled}
      onClick={() => props.onCheckedChange(!props.checked)}
    />
  ),
}));
vi.mock("../ui/checkbox", () => ({
  Checkbox: (props: {
    checked: boolean;
    disabled?: boolean;
    onCheckedChange?: (checked: boolean) => void;
    "aria-label": string;
  }) => (
    <button
      type="button"
      role="checkbox"
      aria-checked={props.checked}
      aria-label={props["aria-label"]}
      disabled={props.disabled}
      onClick={() => props.onCheckedChange?.(!props.checked)}
    />
  ),
}));
vi.mock("../ui/radio-group", () => {
  const Group = createContext<{ value: string; change: (value: string) => void }>({
    value: "",
    change: () => {},
  });
  return {
    RadioGroup: (props: {
      value: string;
      onValueChange: (value: string) => void;
      children: ReactNode;
    }) => (
      <Group.Provider value={{ value: props.value, change: props.onValueChange }}>
        <div role="radiogroup">{props.children}</div>
      </Group.Provider>
    ),
    Radio: (props: { value: string; disabled?: boolean }) => {
      const group = useContext(Group);
      return (
        <button
          type="button"
          role="radio"
          value={props.value}
          disabled={props.disabled}
          aria-checked={group.value === props.value}
          onClick={() => group.change(props.value)}
        />
      );
    },
  };
});
vi.mock("../ui/dialog", () => {
  const Box = (name: string) => (props: { children?: ReactNode }) => (
    <div data-dialog-part={name}>{props.children}</div>
  );
  return {
    Dialog: Box("dialog"),
    DialogPopup: Box("popup"),
    DialogHeader: Box("header"),
    DialogTitle: Box("title"),
    DialogDescription: Box("description"),
    DialogPanel: Box("panel"),
    DialogFooter: Box("footer"),
  };
});
vi.mock("../ui/input", () => ({
  Input: (props: { value: string; onChange: (event: { target: { value: string } }) => void }) => (
    <input value={props.value} onChange={props.onChange} />
  ),
}));
vi.mock("../ui/button", () => ({
  Button: ({
    children,
    variant: _variant,
    size: _size,
    ...rest
  }: {
    children?: ReactNode;
    variant?: string;
    size?: string;
    disabled?: boolean;
    onClick?: () => void;
  }) => (
    <button type="button" {...rest}>
      {children}
    </button>
  ),
}));
vi.mock("../ui/table", () => {
  const cell = (Tag: "table" | "thead" | "tbody" | "tr" | "th" | "td") =>
    function Cell({
      className: _className,
      ...props
    }: {
      className?: string;
      children?: ReactNode;
    }) {
      return <Tag {...props} />;
    };
  return {
    Table: cell("table"),
    TableHeader: cell("thead"),
    TableBody: cell("tbody"),
    TableRow: cell("tr"),
    TableHead: cell("th"),
    TableCell: cell("td"),
  };
});

import { PERCY_SHARED_SETTING_ID } from "../../studio/personalShare";
import { PercySharedSetting } from "./PercySharedSetting";

const success = <T,>(value: T) => ({ _tag: "Success" as const, value });
const failure = (message: string) => ({ _tag: "Failure" as const, error: new Error(message) });

const statusOf = (overrides: Record<string, unknown> = {}) => ({
  enabled: false,
  environmentId: "studio",
  machineLabel: "Studio",
  connectLinked: true,
  linkId: "logical:percy:fixture",
  projectId: "percy-studio",
  assistantName: "Percy",
  linked: false,
  members: [],
  routineOwner: false,
  start: false,
  machines: [],
  restorePoints: [],
  refusal: null,
  ...overrides,
});

// Two links and one undo since the second: r3 is the newest copy.
const POINTS = [
  { id: "r1", savedAt: "2026-11-20T10:00:00.000Z", reason: "before-link", memoryFileCount: 4 },
  { id: "r2", savedAt: "2026-11-24T10:00:00.000Z", reason: "before-link", memoryFileCount: 9 },
  { id: "r3", savedAt: "2026-11-25T10:00:00.000Z", reason: "before-undo", memoryFileCount: 9 },
];

const environment = (environmentId: string, label: string, phase = "connected") => ({
  environmentId,
  label,
  connection: { phase },
});

const assistant = (environmentId: string, title: string, members = 1) => ({
  id: `percy-${environmentId}`,
  environmentId,
  title,
  createdAt: "2026-01-01T00:00:00.000Z",
  workspaceSettings: {
    kind: "personal",
    archived: false,
    ...(members > 1
      ? {
          logicalProject: {
            id: "logical:percy:fixture",
            members: Array.from({ length: members }, (_, index) => ({
              environmentId: `m${index}`,
              projectId: `p${index}`,
            })),
          },
        }
      : {}),
  },
});

let renderer: ReactTestRenderer;
const render = async () => {
  await act(async () => {
    renderer = create(<PercySharedSetting />);
  });
};
const text = (node: ReactTestInstance | string): string =>
  typeof node === "string" ? node : node.children.map(text).join("");
// Host elements only: a mocked component carries the same props as the element it renders.
const within = (root: ReactTestInstance, props: Record<string, unknown>) =>
  root.findAll(
    (node) =>
      typeof node.type === "string" &&
      Object.entries(props).every(([key, value]) => node.props[key] === value),
  );
const all = (props: Record<string, unknown>) => within(renderer.root, props);
const one = (props: Record<string, unknown>) => {
  const found = all(props);
  if (found.length !== 1) throw new Error(`${found.length} elements with ${JSON.stringify(props)}`);
  return found[0]!;
};
const click = async (node: ReactTestInstance) => {
  await act(async () => {
    node.props.onClick();
  });
};
const toggle = () => one({ role: "switch" });
const pageText = () => text(renderer.root);

describe("PercySharedSetting", () => {
  beforeEach(() => {
    mocks.ownId = "studio";
    mocks.shared = { enabled: false, machines: [] };
    mocks.aideEnabled = true;
    mocks.ownAccess = "granted";
    mocks.otherAccess = new Map([
      ["laptop", "granted"],
      ["tower", "granted"],
    ]);
    mocks.environments = [
      environment("studio", "Studio"),
      environment("laptop", "Laptop"),
      environment("tower", "Tower", "offline"),
    ];
    mocks.projects = [];
    mocks.accountMachines = ["laptop", "tower", "desktop"];
    mocks.discoveryRefreshing = false;
    for (const call of [mocks.status, mocks.set, mocks.undo, mocks.preview]) call.mockReset();
    // The machine remembers its switch: a later read answers what the last change saved.
    let saved = statusOf();
    mocks.status.mockImplementation(async () => success(saved));
    mocks.set.mockImplementation(
      async ({ environmentId, input }: { environmentId: string; input: { enabled: boolean } }) => {
        if (environmentId === "studio") saved = statusOf({ enabled: input.enabled });
        return success(statusOf({ enabled: input.enabled }));
      },
    );
    mocks.undo.mockResolvedValue(success(statusOf()));
    mocks.preview.mockResolvedValue(failure("not read"));
  });

  it("names the window's own machine, says what the switch does, and anchors the sidebar's link", async () => {
    await render();
    expect(text(one({ "data-title": true }))).toBe("Use my Percy on Studio");
    expect(one({ id: PERCY_SHARED_SETTING_ID })).toBeTruthy();
    const description = text(one({ "data-description": true }));
    expect(description).toContain(
      "kept the same on every machine of your Connect account that has this switch on",
    );
    expect(description).toContain("Chats started on Studio can be listed and opened");
    expect(description).toContain("Gmail, Calendar and Drive access stays with each machine.");
    expect(mocks.status).toHaveBeenCalledWith({ environmentId: "studio", input: {} });
  });

  it("is disabled with the reason for a session without settings write, and asks the machine nothing", async () => {
    mocks.ownAccess = "denied";
    await render();
    expect(toggle().props.disabled).toBe(true);
    expect(text(one({ "data-percy-shared-note": true }))).toBe(
      "This connection cannot change settings on Studio. Turn it on in the app on Studio.",
    );
    expect(mocks.status).not.toHaveBeenCalled();
    await click(toggle());
    expect(mocks.set).not.toHaveBeenCalled();
  });

  it("says so while the window is signed out of the machine or has none of its own", async () => {
    mocks.ownAccess = "signed-out";
    await render();
    expect(toggle().props.disabled).toBe(true);
    expect(pageText()).toContain("This window is signed out of Studio.");
    mocks.ownId = null;
    await render();
    expect(toggle().props.disabled).toBe(true);
    expect(pageText()).toContain("This window has no machine of its own.");
  });

  it("turning it on asks first, then calls each reachable machine through its own session", async () => {
    await render();
    await click(toggle());
    // Nothing is saved until the owner confirms.
    expect(mocks.set).not.toHaveBeenCalled();
    const boxes = all({ role: "checkbox" });
    expect(boxes.map((box) => [box.props["aria-label"], box.props["aria-checked"]])).toEqual([
      ["Studio", true],
      ["Laptop", true],
      ["Tower", true],
    ]);
    // Tower does not answer this window: the owner turns it on there.
    expect(all({ "data-share-manual": true }).map(text)).toEqual([
      "Turn it on in Settings on Tower",
    ]);
    await click(one({ "data-share-confirm": true }));
    expect(mocks.set.mock.calls.map(([call]) => call)).toEqual([
      // No assistant anywhere: this machine makes the first one, and the link starts here.
      {
        environmentId: "studio",
        input: { enabled: true, machines: ["laptop", "tower"], start: true },
      },
      {
        environmentId: "laptop",
        input: { enabled: true, machines: ["studio", "tower"], start: false },
      },
    ]);
    expect(toggle().props["aria-checked"]).toBe(true);
    expect(all({ "data-dialog-part": "popup" })).toHaveLength(0);
  });

  it("keeps the machines another machine confirmed there when turning it on from here", async () => {
    // Laptop confirmed Win on its own; this window does not know Win.
    const studio = statusOf();
    mocks.status.mockImplementation(async ({ environmentId }: { environmentId: string }) =>
      success(
        environmentId === "laptop"
          ? statusOf({
              environmentId: "laptop",
              machines: [{ environmentId: "win", label: "Win", state: "offline" }],
            })
          : studio,
      ),
    );
    await render();
    await click(toggle());
    await click(one({ "data-share-confirm": true }));
    expect(mocks.status).toHaveBeenCalledWith({ environmentId: "laptop", input: {} });
    expect(mocks.set.mock.calls.map(([call]) => [call.environmentId, call.input.machines])).toEqual(
      [
        ["studio", ["laptop", "tower"]],
        ["laptop", ["win", "studio", "tower"]],
      ],
    );
  });

  it("leaves another machine as it is when its list cannot be read, and says so", async () => {
    const studio = statusOf();
    mocks.status.mockImplementation(async ({ environmentId }: { environmentId: string }) =>
      environmentId === "laptop" ? failure("no answer") : success(studio),
    );
    await render();
    await click(toggle());
    await click(one({ "data-share-confirm": true }));
    expect(mocks.set.mock.calls.map(([call]) => call.environmentId)).toEqual(["studio"]);
    expect(text(one({ "data-percy-shared-error": true }))).toBe(
      "It is on here. These machines did not take it: Laptop: no answer",
    );
  });

  it("ticks by default only a machine listed under the window's Connect account or joined", async () => {
    // Desktop is connected here, yet the relay does not list it under this
    // account: a team member's machine, a LAN or an SSH pairing. Guest is
    // on another account. Mini is not listed, but this machine's server
    // reports it joined.
    mocks.accountMachines = ["laptop"];
    mocks.environments = [
      environment("studio", "Studio"),
      environment("laptop", "Laptop"),
      environment("desktop", "Desktop"),
      environment("guest", "Guest"),
    ];
    mocks.otherAccess = new Map([
      ["laptop", "granted"],
      ["desktop", "granted"],
      ["guest", "granted"],
    ]);
    const studio = success(
      statusOf({
        machines: [
          { environmentId: "guest", label: "Guest", state: "other_account" },
          { environmentId: "mini", label: "Mini", state: "joined" },
        ],
      }),
    );
    mocks.status.mockImplementation(async ({ environmentId }: { environmentId: string }) =>
      environmentId === "studio" ? studio : success(statusOf({ environmentId })),
    );
    await render();
    await click(toggle());
    const box = (label: string) => one({ role: "checkbox", "aria-label": label });
    expect(box("Laptop").props["aria-checked"]).toBe(true);
    expect(box("Mini").props["aria-checked"]).toBe(true);
    expect(box("Desktop").props["aria-checked"]).toBe(false);
    expect(box("Desktop").props.disabled).toBeFalsy();
    expect(box("Guest").props["aria-checked"]).toBe(false);
    expect(box("Guest").props.disabled).toBe(true);
    expect(
      text(one({ "data-share-candidate": "desktop" })).includes(
        "Not listed under your Connect account",
      ),
    ).toBe(true);
    expect(all({ "data-share-not-account": true })).toHaveLength(1);
    expect(text(one({ "data-share-candidate": "guest" }))).toContain(
      "Signed in to another Connect account",
    );
    await click(one({ "data-share-confirm": true }));
    expect(mocks.set.mock.calls.map(([call]) => [call.environmentId, call.input.machines])).toEqual(
      [
        ["studio", ["laptop", "mini"]],
        ["laptop", ["studio", "mini"]],
      ],
    );
  });

  it("lets the owner tick a machine not listed under the account, knowingly", async () => {
    mocks.accountMachines = [];
    await render();
    await click(toggle());
    expect(
      all({ role: "checkbox" }).map((box) => [box.props["aria-label"], box.props["aria-checked"]]),
    ).toEqual([
      ["Studio", true],
      ["Laptop", false],
      ["Tower", false],
    ]);
    await click(one({ role: "checkbox", "aria-label": "Laptop" }));
    await click(one({ "data-share-confirm": true }));
    expect(mocks.set.mock.calls.map(([call]) => [call.environmentId, call.input.machines])).toEqual(
      [
        ["studio", ["laptop"]],
        ["laptop", ["studio"]],
      ],
    );
  });

  it("keeps the account's machines ticked while the relay list is read again", async () => {
    mocks.accountMachines = ["laptop"];
    await render();
    await click(toggle());
    expect(one({ role: "checkbox", "aria-label": "Laptop" }).props["aria-checked"]).toBe(true);
    // A refresh empties the list until it answers.
    mocks.accountMachines = [];
    mocks.discoveryRefreshing = true;
    await act(async () => {
      renderer.update(<PercySharedSetting />);
    });
    expect(one({ role: "checkbox", "aria-label": "Laptop" }).props["aria-checked"]).toBe(true);
  });

  it("leaves out a machine the owner unticked", async () => {
    await render();
    await click(toggle());
    await click(one({ role: "checkbox", "aria-label": "Tower" }));
    await click(one({ "data-share-confirm": true }));
    expect(mocks.set.mock.calls.map(([call]) => call.input.machines)).toEqual([
      ["laptop"],
      ["studio"],
    ]);
  });

  it("offers Start from with the most memory files leading, and Percy as the name when names differ", async () => {
    mocks.projects = [assistant("studio", "Percy"), assistant("laptop", "PercyLaptop")];
    mocks.preview.mockImplementation(async ({ environmentId }: { environmentId: string }) =>
      success({ memoryFileCount: environmentId === "laptop" ? 21 : 4 }),
    );
    await render();
    await click(toggle());
    expect(mocks.preview.mock.calls.map(([call]) => call)).toEqual([
      { environmentId: "studio", input: { projectId: "percy-studio" } },
      { environmentId: "laptop", input: { projectId: "percy-laptop" } },
    ]);
    const radios = all({ role: "radio" });
    expect(radios.map((radio) => [radio.props.value, radio.props["aria-checked"]])).toEqual([
      ["studio", false],
      ["laptop", true],
    ]);
    expect(pageText()).toContain("21 memory files");
    expect(renderer.root.findByType("input").props.value).toBe("Percy");
    await click(one({ "data-share-confirm": true }));
    expect(mocks.set.mock.calls.map(([call]) => call)).toEqual([
      {
        environmentId: "studio",
        input: { enabled: true, machines: ["laptop", "tower"], start: false },
      },
      {
        environmentId: "laptop",
        input: { enabled: true, machines: ["studio", "tower"], start: true, name: "Percy" },
      },
    ]);
  });

  it("follows the owner's Start from choice and name", async () => {
    mocks.projects = [assistant("studio", "Percy"), assistant("laptop", "Percy")];
    await render();
    await click(toggle());
    await click(one({ role: "radio", value: "laptop" }));
    await act(async () => {
      renderer.root.findByType("input").props.onChange({ target: { value: "Ada" } });
    });
    await click(one({ "data-share-confirm": true }));
    expect(
      mocks.set.mock.calls.map(([call]) => [call.environmentId, call.input.start, call.input.name]),
    ).toEqual([
      ["studio", false, undefined],
      ["laptop", true, "Ada"],
    ]);
  });

  it("never starts from a machine the window cannot change: its radio says to choose it there", async () => {
    // Tower has the most memory files, but this window cannot change its settings.
    mocks.otherAccess = new Map([
      ["laptop", "granted"],
      ["tower", "denied"],
    ]);
    mocks.environments = [
      environment("studio", "Studio"),
      environment("laptop", "Laptop"),
      environment("tower", "Tower"),
    ];
    mocks.projects = [
      assistant("studio", "Percy"),
      assistant("laptop", "Percy"),
      assistant("tower", "Percy"),
    ];
    mocks.preview.mockImplementation(async ({ environmentId }: { environmentId: string }) =>
      success({ memoryFileCount: { studio: 2, laptop: 5, tower: 30 }[environmentId] ?? 0 }),
    );
    await render();
    await click(toggle());
    const radios = all({ role: "radio" });
    expect(
      radios.map((radio) => [radio.props.value, radio.props["aria-checked"], radio.props.disabled]),
    ).toEqual([
      ["studio", false, false],
      ["laptop", true, false],
      ["tower", false, true],
    ]);
    expect(all({ "data-share-start-elsewhere": true }).map(text)).toEqual([
      "Choose it in Settings on Tower",
    ]);
    await click(one({ "data-share-confirm": true }));
    expect(
      mocks.set.mock.calls.map(([call]) => [call.environmentId, call.input.start, call.input.name]),
    ).toEqual([
      ["studio", false, undefined],
      ["laptop", true, "Percy"],
    ]);
  });

  it("asks nothing about a start when a link already exists", async () => {
    mocks.projects = [assistant("laptop", "Percy", 2), assistant("tower", "Percy", 2)];
    await render();
    await click(toggle());
    expect(all({ role: "radio" })).toHaveLength(0);
    await click(one({ "data-share-confirm": true }));
    expect(mocks.set.mock.calls[0]![0]).toEqual({
      environmentId: "studio",
      input: { enabled: true, machines: ["laptop", "tower"] },
    });
  });

  it("stops when this machine refuses, and keeps the confirmation open with the reason", async () => {
    mocks.set.mockResolvedValue(failure("Sign in to SpecWithCode Connect first."));
    await render();
    await click(toggle());
    await click(one({ "data-share-confirm": true }));
    expect(mocks.set).toHaveBeenCalledTimes(1);
    expect(all({ "data-dialog-part": "popup" })).toHaveLength(1);
    expect(pageText()).toContain("Sign in to SpecWithCode Connect first.");
  });

  it("names a machine that did not take it, after turning it on here", async () => {
    mocks.set.mockImplementation(async ({ environmentId }: { environmentId: string }) =>
      environmentId === "laptop"
        ? failure("needs an update")
        : success(statusOf({ enabled: true })),
    );
    await render();
    await click(toggle());
    // This machine took it, so the read after the change says on.
    mocks.status.mockResolvedValue(success(statusOf({ enabled: true })));
    await click(one({ "data-share-confirm": true }));
    expect(text(one({ "data-percy-shared-error": true }))).toBe(
      "It is on here. These machines did not take it: Laptop: needs an update",
    );
    expect(toggle().props["aria-checked"]).toBe(true);
  });

  it("turning it off needs no confirmation and is saved on this machine only", async () => {
    mocks.shared = { enabled: true, machines: ["laptop"] };
    mocks.status.mockResolvedValue(success(statusOf({ enabled: true })));
    await render();
    expect(toggle().props["aria-checked"]).toBe(true);
    await click(toggle());
    expect(mocks.set.mock.calls.map(([call]) => call)).toEqual([
      { environmentId: "studio", input: { enabled: false } },
    ]);
    expect(toggle().props["aria-checked"]).toBe(false);
  });

  it("lists each machine's state in plain words, the routine runner and when each machine was last checked", async () => {
    mocks.shared = { enabled: true, machines: ["laptop", "desktop", "tower"] };
    mocks.environments = [
      environment("studio", "Studio"),
      environment("laptop", "Laptop"),
      environment("desktop", "Desktop"),
    ];
    mocks.otherAccess = new Map([
      ["laptop", "granted"],
      ["desktop", "granted"],
    ]);
    mocks.projects = [
      {
        ...assistant("studio", "Percy", 2),
        workspaceSettings: {
          ...assistant("studio", "Percy", 2).workspaceSettings,
          coordinatorBinding: { routineOwner: false },
        },
      },
      {
        ...assistant("laptop", "Percy", 2),
        workspaceSettings: {
          ...assistant("laptop", "Percy", 2).workspaceSettings,
          coordinatorBinding: { routineOwner: true },
        },
      },
    ];
    const studioStatus = success(
      statusOf({
        enabled: true,
        linked: true,
        machines: [
          {
            environmentId: "laptop",
            label: "Laptop",
            state: "joined",
            lastSyncedAt: new Date().toISOString(),
          },
          { environmentId: "desktop", label: "Desktop", state: "switch_off" },
          { environmentId: "tower", label: "Tower", state: "offline" },
          { environmentId: "mini", label: "Mini", state: "older_version" },
          { environmentId: "guest", label: "Guest", state: "other_account" },
          { environmentId: "old", label: "Old", state: "legacy_grant" },
          { environmentId: "slow", label: "Slow", state: "waiting" },
          { environmentId: "far", label: "Far", state: "switch_off" },
        ],
      }),
    );
    // Desktop confirmed Win on its own; Gone is not added there.
    mocks.status.mockImplementation(async ({ environmentId }: { environmentId: string }) =>
      environmentId === "desktop"
        ? success(
            statusOf({
              environmentId: "desktop",
              machines: [
                { environmentId: "win", label: "Win", state: "waiting" },
                { environmentId: "gone", label: "Gone", state: "not_confirmed" },
              ],
            }),
          )
        : studioStatus,
    );
    await render();
    const rows = all({ "data-share-machine": "laptop" });
    expect(rows).toHaveLength(1);
    const states = Object.fromEntries(
      renderer.root
        .findAll(
          (node) =>
            typeof node.type === "string" && typeof node.props["data-share-machine"] === "string",
        )
        .map((row) => [
          row.props["data-share-machine"],
          text(within(row, { "data-share-state": true })[0]!),
        ]),
    );
    expect(states).toEqual({
      studio: "On",
      laptop: "On",
      desktop: "Off",
      tower: "Offline",
      mini: "Needs an update",
      guest: "Signed in to another Connect account",
      old: "Not one of your own machines' grants",
      slow: "Waiting for Slow to answer",
      far: "Off",
    });
    expect(text(one({ "data-share-machine": "laptop" }))).toContain("Runs the shared routines");
    // The exchange time is the last check with that machine, never a claim that memory matches.
    expect(text(one({ "data-share-machine": "laptop" }))).toContain(
      "Last checked with Laptop just now",
    );
    expect(text(one({ "data-share-machine": "studio" }))).toContain(
      "Last checked with your other machines just now",
    );
    expect(text(renderer.root)).not.toContain("Memory in step");
    expect(text(one({ "data-share-machine": "studio" }))).toContain("(this machine)");
    // Desktop answers this window: its switch can be turned on from here. Far does not.
    expect(
      within(one({ "data-share-machine": "desktop" }), { "data-share-turn-on": true }),
    ).toHaveLength(1);
    expect(text(one({ "data-share-machine": "far" }))).toContain("Turn it on in Settings on Far");
    await click(
      within(one({ "data-share-machine": "desktop" }), { "data-share-turn-on": true })[0]!,
    );
    // Desktop keeps what it confirmed and adds only this machine.
    expect(mocks.status).toHaveBeenCalledWith({ environmentId: "desktop", input: {} });
    expect(mocks.set.mock.calls.map(([call]) => call)).toEqual([
      {
        environmentId: "desktop",
        input: { enabled: true, machines: ["win", "studio"] },
      },
      {
        environmentId: "studio",
        input: { enabled: true, machines: ["laptop", "tower", "desktop"] },
      },
    ]);
  });

  it("says the way out when the machine is not signed in to Connect or Percy is off", async () => {
    mocks.status.mockResolvedValue(success(statusOf({ refusal: "not_connected" })));
    await render();
    expect(toggle().props.disabled).toBe(true);
    expect(text(one({ "data-percy-shared-note": true }))).toBe(
      "Sign in to SpecWithCode Connect on Studio first: Percy belongs to your Connect account.",
    );
    mocks.status.mockResolvedValue(success(statusOf({ refusal: "assistant_off" })));
    await render();
    expect(toggle().props.disabled).toBe(true);
    expect(text(one({ "data-percy-shared-note": true }))).toBe(
      "Turn the personal assistant on above first.",
    );
  });

  it("hides Undo without a restore point, and says what it does before calling it", async () => {
    mocks.status.mockResolvedValue(success(statusOf({ enabled: true })));
    await render();
    expect(all({ "data-percy-shared-undo": "undo-merge" })).toHaveLength(0);
    expect(all({ "data-percy-shared-undo": "put-back" })).toHaveLength(0);

    // On, with an earlier undo kept: the merge is what is undone now.
    mocks.status.mockResolvedValue(success(statusOf({ enabled: true, restorePoints: POINTS })));
    await render();
    const button = one({ "data-percy-shared-undo": "undo-merge" });
    expect(text(button)).toBe("Undo the merge on Studio…");
    await click(button);
    expect(mocks.undo).not.toHaveBeenCalled();
    const said = text(one({ "data-dialog-part": "description" }));
    // The newest copy saved before a link, in the reader's own date format.
    expect(said).toContain(
      new Date("2026-11-24T10:00:00.000Z").toLocaleDateString(undefined, { dateStyle: "long" }),
    );
    expect(said).toContain("turns the switch off");
    expect(said).toContain(
      "A copy of the current state is kept: Settings then offers to put it back",
    );
    expect(said).toContain("No chat is touched");
    await click(one({ "data-percy-shared-undo-confirm": true }));
    expect(mocks.undo).toHaveBeenCalledWith({
      environmentId: "studio",
      input: { restorePointId: "r2" },
    });
    expect(all({ "data-dialog-part": "popup" })).toHaveLength(0);
  });

  it("after an undo, offers to put back what was there before it, and sends that copy", async () => {
    // The switch is off and the newest copy was saved before the undo.
    mocks.status.mockResolvedValue(success(statusOf({ enabled: false, restorePoints: POINTS })));
    await render();
    expect(all({ "data-percy-shared-undo": "undo-merge" })).toHaveLength(0);
    const button = one({ "data-percy-shared-undo": "put-back" });
    expect(text(button)).toBe("Put back what was there before the undo…");
    await click(button);
    expect(text(one({ "data-dialog-part": "title" }))).toBe(
      "Put back what was there before the undo on Studio?",
    );
    const said = text(one({ "data-dialog-part": "description" }));
    expect(said).toContain(
      new Date("2026-11-25T10:00:00.000Z").toLocaleDateString(undefined, { dateStyle: "long" }),
    );
    expect(said).toContain("just before the undo");
    expect(said).toContain("The switch stays off");
    expect(text(one({ "data-percy-shared-undo-confirm": true }))).toBe("Put it back");
    await click(one({ "data-percy-shared-undo-confirm": true }));
    expect(mocks.undo).toHaveBeenCalledWith({
      environmentId: "studio",
      input: { restorePointId: "r3" },
    });
  });
});
