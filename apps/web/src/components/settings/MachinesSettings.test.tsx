import { act, type ComponentProps, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProjectId, ThreadId } from "@specweave-studio/contracts";
import * as Option from "effect/Option";
import type {
  StudioFleetMachine,
  StudioFleetSnapshot,
} from "@specweave-studio/contracts/studioFleet";

const m4 = EnvironmentId.make("env-m4");
const m3 = EnvironmentId.make("env-m3");
const m1 = EnvironmentId.make("env-m1");

const runtime = vi.hoisted(() => ({
  fleet: null as unknown,
  environments: [] as unknown[],
  projects: [] as unknown[],
  blocks: [] as unknown[],
  grants: null as unknown,
  discovered: new Map<string, unknown>(),
  nicknames: {} as Record<string, string>,
  connect: vi.fn(async () => {}),
  createCredential: vi.fn(),
  // What the fleet roster hands a composed card: its controls and its own extras.
  controls: null as ReactNode,
  card: undefined as { actions: ReactNode; gone: ReactNode } | undefined,
  // The one next step the page read for this machine, and whether this build has Connect.
  step: "add-phone" as "sign-in" | "turn-on" | "add-phone" | "done" | "loading",
  connectKind: "on" as "on" | "unknown" | "unavailable",
  phoneCard: true,
}));

vi.mock("./useSettingsProjectGroups", () => ({ useSettingsProjectGroups: () => [] }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => null }));
vi.mock("./settingsLayout", () => ({
  useSettingsSearchTarget: () => () => undefined,
  useSettingsSearchTargetId: () => null,
  TeamRulesLabel: ({ children }: { children: ReactNode }) => <em>{children}</em>,
  SettingsPageContainer: ({ children }: { children: ReactNode }) => <main>{children}</main>,
  SettingsSection: ({
    title,
    headerAction,
    children,
  }: {
    title: string;
    headerAction?: ReactNode;
    children: ReactNode;
  }) => (
    <section aria-label={title}>
      {headerAction}
      {children}
    </section>
  ),
}));
vi.mock("../ui/button", () => ({
  Button: ({ children, ...props }: ComponentProps<"button">) => (
    <button {...props}>{children}</button>
  ),
}));
vi.mock("../ui/badge", () => ({
  Badge: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../ui/input", () => ({
  Input: (props: ComponentProps<"input">) => <input {...props} />,
}));
vi.mock("../ui/toast", () => ({
  toastManager: { add: vi.fn() },
  stackedThreadToast: (value: unknown) => value,
}));
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children, render }: { children?: ReactNode; render?: ReactNode }) => (
    <>
      {render}
      {children}
    </>
  ),
  TooltipPopup: () => null,
}));
vi.mock("../../confirmDialog", () => ({ requestConfirmDialog: vi.fn(async () => true) }));
vi.mock("./HandoffModeSettings", () => ({ HandoffModeSettings: () => null }));
// Access requests poll every connected machine; they have their own tests.
vi.mock("../away/AwayAccessRequests", () => ({ AwayAccessRequestsAll: () => null }));
vi.mock("./usePrimaryFleet", () => ({ usePrimaryFleet: () => runtime.fleet }));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({ environments: runtime.environments }),
  usePrimaryEnvironmentId: () => null,
  useRelayEnvironmentDiscovery: () => ({
    environments: runtime.discovered,
    refreshing: false,
    offline: false,
  }),
}));
vi.mock("../../connection/catalog", () => ({ environmentCatalog: {} }));
vi.mock("../../state/relay", () => ({ relayEnvironmentDiscovery: {} }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../../state/entities", () => ({
  useProjects: () => runtime.projects,
  useThreadShells: () => [],
  useServerConfigs: () => new Map(),
}));
vi.mock("../../state/session", () => ({
  useEnvironmentScope: () => true,
  readEnvironmentScope: () => true,
}));
vi.mock("../../state/desktopNetworkAccess", () => ({ desktopNetworkAccessStateAtom: null }));
vi.mock("../../studio/fleet", () => ({
  useStudioFleet: () => ({ snapshot: null, loading: false, failed: false, refresh: vi.fn() }),
  useMachineWorkGrants: () => ({
    snapshot: runtime.grants,
    loading: false,
    failed: false,
    refresh: vi.fn(),
  }),
  changeMachineWorkGrant: vi.fn(),
}));
vi.mock("../studio/shell/HostLimits", () => ({ useHostLimitBlocks: () => runtime.blocks }));
vi.mock("../../connection/desktopLocal", () => ({ isThisMachineTarget: () => false }));
vi.mock("../../studio/machineNickname", () => ({
  useMachineNickname: (environmentId: string, label?: string) =>
    runtime.nicknames[environmentId] ?? label ?? "",
  useMachineNicknames: () => (environmentId: string, label?: string | null) =>
    runtime.nicknames[environmentId] ?? label ?? environmentId,
}));
vi.mock("../../studio/machineIdentity", () => {
  const identity = (environmentId: string, name?: string | null) => ({
    environmentId,
    name: name ?? environmentId,
    color: "teal",
    icon: "laptop",
    short: "AB",
    derivedShort: "AB",
  });
  return {
    machineColorProps: (value: { color: string } | null | undefined) =>
      value ? { "data-machine-color": value.color } : {},
    useMachineIdentity: (id: string | null, name?: string | null) => (id ? identity(id, name) : null),
    useMachineIdentities: () => identity,
    useKnownMachineIdentities: () => [],
  };
});
vi.mock("./MachineColor", () => ({ MachineColorButton: () => null }));
vi.mock("./RenameMachineDialog", () => ({ RenameMachineDialog: () => null }));
vi.mock("./AddProjectToMachine", () => ({
  AddProjectToMachine: ({
    environmentId,
    name,
    onChoose,
  }: {
    environmentId: string;
    name: string;
    onChoose: (target: { environmentId: string; source: { id: string } }) => void;
  }) => (
    <button
      type="button"
      data-add-project={name}
      onClick={() => onChoose({ environmentId, source: { id: "p-chosen" } })}
    />
  ),
  AddProjectToMachineDialog: ({
    target,
  }: {
    target: { environmentId: string; source: { id: string } } | null;
  }) =>
    target ? <div data-add-dialog={`${target.source.id} to ${target.environmentId}`} /> : null,
}));

vi.mock("../../environments/primary", () => ({
  createServerPairingCredential: runtime.createCredential,
  readPrimaryEnvironmentTarget: () => ({ target: { httpBaseUrl: "https://m4max.tailnet.ts.net" } }),
}));

vi.mock("./ConnectionsSettings", () => ({
  ConnectionsSettings: ({ additionalMachines, renderMachine, renderLayout }: any) =>
    renderLayout({
      otherMachines: (
        <ul data-part="other-machines">
          {additionalMachines}
          {(runtime.fleet as { snapshot?: StudioFleetSnapshot })?.snapshot?.machines?.map(
            (machine: any) =>
              renderMachine(machine.environmentId, runtime.controls, null, runtime.card),
          )}
        </ul>
      ),
      pairPhone: <div data-part="pair-phone" />,
      thisMachine: <div data-part="this-machine-rows" />,
      savedConnections: <div data-part="saved-connections" />,
      routing: <div data-part="routing" />,
    }),
}));
// The summary, the next step and the phone card read SpecWithCode Connect; they have their own tests.
vi.mock("./MachineSummary", () => ({
  MachineSetupState: ({ children }: { children: (setup: unknown) => ReactNode }) =>
    children({ step: { kind: runtime.step }, connect: { kind: runtime.connectKind } }),
  MachineSummary: ({ rows }: { rows: readonly unknown[] }) => (
    <header data-part="summary" data-rows={rows.length} />
  ),
}));
vi.mock("./PhoneConnectSettings", () => ({
  isPhoneConnectShown: () => runtime.phoneCard,
  PhoneConnectSettings: ({ setup, pairRow }: { setup?: unknown; pairRow?: ReactNode }) => (
    <section data-part="your-phone" data-has-setup={setup ? "yes" : "no"}>
      {pairRow}
    </section>
  ),
}));
vi.mock("./ThisMachineAdvanced", () => ({
  ThisMachineAdvanced: ({ children }: { children: ReactNode }) => (
    <details data-part="advanced">{children}</details>
  ),
}));
import { AddForAgentsView, ConnectBothWaysView, MachinesSettingsPanel } from "./MachinesSettings";

const machine = (
  environmentId: EnvironmentId,
  label: string,
  extra: Partial<StudioFleetMachine> = {},
): StudioFleetMachine => ({
  id: label.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
  environmentId,
  label,
  url: `https://${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.tailnet.ts.net`,
  status: "reachable",
  pairingConfigured: true,
  ...extra,
});
const snapshot: StudioFleetSnapshot = {
  configured: true,
  connectPermission: "access:write",
  observedAt: "2026-10-19T12:00:00Z",
  listener: "network",
  machines: [
    machine(m3, "MacBook Pro", {
      workers: {
        status: "allowed",
        access: "auto",
        expiresAt: null,
        renewable: true,
        problem: null,
      },
    }),
    machine(m1, "M1Max"),
  ],
};
const environment = (environmentId: EnvironmentId, label: string) => ({
  environmentId,
  label,
  entry: {},
  connection: { phase: "connected", error: null },
});
const member = (environmentId: EnvironmentId, projectId: string) => ({
  environmentId,
  projectId: ProjectId.make(projectId),
  coordinatorThreadId: ThreadId.make(`project-coordinator:${projectId}`),
});

function setUp() {
  runtime.grants = null;
  runtime.nicknames = {};
  runtime.step = "add-phone";
  runtime.connectKind = "on";
  runtime.phoneCard = true;
  runtime.fleet = {
    primaryEnvironmentId: m4,
    snapshot,
    loading: false,
    failed: false,
    refresh: vi.fn(),
    canPair: true,
    savedOrigins: new Map(),
    unseen: [snapshot.machines[1]],
    connect: runtime.connect,
  };
  runtime.environments = [environment(m4, "M4MAX"), environment(m3, "MacBook Pro")];
  runtime.projects = [
    {
      environmentId: m3,
      id: "p-m3",
      title: "easychamp",
      workspaceRoot: "/Users/a/easychamp",
      workspaceSettings: {
        kind: "code",
        logicalProject: {
          id: "logical-easychamp",
          title: "EasyChamp",
          coordinatorId: "c",
          members: [member(m4, "p-m4"), member(m3, "p-m3")],
        },
        coordinatorBinding: { epoch: 1, state: "transferred" },
      },
    },
  ];
  runtime.blocks = [
    {
      environmentId: m3,
      providers: [
        {
          key: "codex",
          label: "Codex",
          identity: "someone@example.com",
          sharedWith: ["M4MAX"],
        },
      ],
    },
  ];
}

let rendered: ReactTestRenderer | null = null;
afterEach(async () => {
  if (rendered) await act(async () => rendered!.unmount());
  rendered = null;
  runtime.controls = null;
  runtime.card = undefined;
  vi.clearAllMocks();
});

describe("Settings > Machines", () => {
  it("renders the whole page inside the settings scroll container", () => {
    setUp();
    const html = renderToStaticMarkup(<MachinesSettingsPanel />);
    // SettingsPageContainer is the only scroll area; a plain wrapper leaves the page stuck.
    expect(html.startsWith("<main>")).toBe(true);
    expect(html.endsWith("</main>")).toBe(true);
    expect(html.match(/<main>/g)).toHaveLength(1);
  });

  it("offers to add a project only on a connected machine that holds none", () => {
    setUp();
    // MacBook Pro (m3) is connected and has a project; M1Max is not connected, M4MAX is here.
    expect(renderToStaticMarkup(<MachinesSettingsPanel />)).not.toContain("data-add-project");
    runtime.projects = [];
    const html = renderToStaticMarkup(<MachinesSettingsPanel />);
    expect(html.match(/data-add-project="[^"]*"/g)).toEqual(['data-add-project="MacBook Pro"']);
    expect(html).not.toContain("data-add-dialog");
  });

  it("keeps the add dialog open when the card that opened it changes or leaves", async () => {
    setUp();
    const withProject = runtime.projects;
    runtime.projects = [];
    await act(async () => {
      rendered = create(<MachinesSettingsPanel />);
    });
    const dialogs = () =>
      rendered!.root
        .findAll((node) => typeof node.props["data-add-dialog"] === "string")
        .map((node) => node.props["data-add-dialog"]);
    const prompts = () =>
      rendered!.root.findAll(
        (node) => node.type === "button" && node.props["data-add-project"] !== undefined,
      );
    await act(async () => prompts()[0]!.props.onClick());
    expect(dialogs()).toEqual([`p-chosen to ${m3}`]);

    // The project arrives on the machine: its prompt goes, the dialog stays.
    runtime.projects = withProject;
    await act(async () => rendered!.update(<MachinesSettingsPanel />));
    expect(prompts()).toHaveLength(0);
    expect(dialogs()).toEqual([`p-chosen to ${m3}`]);

    // The machine drops out of the list for a moment, as after a failed check.
    runtime.environments = [environment(m4, "M4MAX")];
    runtime.fleet = {
      ...(runtime.fleet as object),
      snapshot: { ...snapshot, machines: [] },
      unseen: [],
    };
    await act(async () => rendered!.update(<MachinesSettingsPanel />));
    expect(dialogs()).toEqual([`p-chosen to ${m3}`]);
  });

  it("adds no team rules line when no machine has rules", () => {
    setUp();
    const html = renderToStaticMarkup(<MachinesSettingsPanel />);
    expect(html).not.toContain("Team rules");
    expect(html).not.toContain("<em>");
    expect(html).not.toContain("inert");
  });

  it("shows the fingerprint and flags drift once a machine has rules", () => {
    setUp();
    runtime.environments = [
      {
        ...environment(m4, "M4MAX"),
        serverConfig: {
          teamRules: {
            status: "active",
            owner: "Acme",
            fingerprint: "aaaaaaaaaaaa",
            reach: { machines: "same-rules" },
          },
        },
      },
      {
        ...environment(m3, "MacBook Pro"),
        serverConfig: {
          teamRules: { status: "active", owner: "Acme", fingerprint: "aaaaaaaaaaaa" },
        },
      },
    ];
    const html = renderToStaticMarkup(<MachinesSettingsPanel />);
    expect(html).toContain("Team rules");
    expect(html).toContain("rules aaaaaaaa");
    expect(html).toContain("Rules on this machine");
    expect(html).toContain("Same rules");
    // M1Max is reachable with no rules, so same-rules refuses it and its Connect is locked.
    expect(html).toContain("No rules");
    expect(html).toContain("Work refused.");
    expect(html).toContain("Set by Acme");
    expect(html).toContain("M1Max has different rules");
    expect(html).toContain("inert");
  });

  it("replaces Connect both ways with the lock", () => {
    const html = renderToStaticMarkup(
      <ConnectBothWaysView
        machineLabel="MacBook Pro"
        canCreate
        creating={false}
        created={null}
        teamRulesLock={{ setBy: "Set by Acme", message: "Acme's rules turn this off." }}
        onCreate={vi.fn()}
        onDone={vi.fn()}
      />,
    );
    expect(html).toContain("Set by Acme");
    expect(html).not.toContain("one-time link");
  });

  it("shows each machine with visibility, workers, shared projects and accounts", () => {
    setUp();
    const html = renderToStaticMarkup(<MachinesSettingsPanel />);
    expect(html).toContain("M4MAX");
    expect(html).toContain("This machine");
    expect(html).toContain("This app can see it");
    expect(html).toContain("not open in this window");
    expect(html).not.toContain("This app cannot see it");
    expect(html).toContain("Agents on M4MAX can start work on MacBook Pro");
    expect(html).not.toContain('href="/settings/machines"');
    expect(html).toContain("Connection details");
    // One summary line per direction; the access workers there get, in a few words.
    expect(html).toContain('data-slot="machine-work-summary"');
    expect(html).toContain(">Auto<");
    expect(html).toContain("EasyChamp");
    expect(html).toContain("Runs workers only");
    // The row keeps the folder short; the button says it in full.
    expect(html).toContain("~/easychamp");
    expect(html).toContain(
      'aria-label="EasyChamp: Also on M4MAX (This machine). Folder /Users/a/easychamp. Show every copy"',
    );
    expect(html).toContain("someone@example.com");
    expect(html).toContain('<span class="sr-only">also on M4MAX</span>');
    expect(html).toContain("Connect to see its accounts.");
    expect(html).toContain("Make pairing link");
  });

  it("puts a machine's actions and its no-longer-answers line on the card, not under Connection details", () => {
    setUp();
    runtime.controls = <li>route and readiness</li>;
    runtime.card = {
      actions: <button aria-label="More actions for MacBook Pro">…</button>,
      gone: <p>No longer answers.</p>,
    };
    const html = renderToStaticMarkup(<MachinesSettingsPanel />);
    // One machine's card, up to the end of its closed disclosure.
    const start = html.indexOf(
      '<li class="flex min-w-0 flex-col gap-2 px-3 py-2.5 sm:px-4"',
      html.indexOf('data-part="other-machines"'),
    );
    const card = html.slice(start, html.indexOf("</details>", start));
    const details = card.indexOf("<details");
    expect(details).toBeGreaterThan(-1);
    // Both sit before the disclosure, so Remove needs no extra click to find.
    expect(card.indexOf("More actions for MacBook Pro")).toBeGreaterThan(-1);
    expect(card.indexOf("More actions for MacBook Pro")).toBeLessThan(details);
    expect(card.indexOf("No longer answers.")).toBeGreaterThan(-1);
    expect(card.indexOf("No longer answers.")).toBeLessThan(details);
    expect(card.slice(details)).toContain("route and readiness");
    expect(card.slice(details)).not.toContain("More actions for MacBook Pro");
  });

  it("names two other machines as chips, folds the rest into +N and reads them all aloud", () => {
    setUp();
    const m2 = EnvironmentId.make("env-m2");
    runtime.environments = [...runtime.environments, environment(m2, "ministorm")];
    runtime.projects = [
      {
        environmentId: m4,
        id: "p-wide",
        title: "wide",
        workspaceRoot: "/Users/you/Projects/github/specweave-umb",
        workspaceSettings: {
          kind: "code",
          logicalProject: {
            id: "logical-wide",
            title: "Umbrella",
            coordinatorId: "c",
            members: [
              member(m4, "p-wide"),
              member(m3, "p-3"),
              member(m2, "p-2"),
              member(m1, "p-1"),
            ],
          },
        },
      },
    ];
    runtime.blocks = [
      {
        environmentId: m4,
        providers: [
          {
            key: "claude",
            label: "Claude",
            identity: "admin@example.com",
            sharedWith: ["MacBook Pro", "M1Max", "ministorm"],
          },
        ],
      },
    ];
    const html = renderToStaticMarkup(<MachinesSettingsPanel />);
    expect(html).toContain('aria-label="Same account on MacBook Pro, M1Max, ministorm"');
    // Home as "~", and the folder's own name kept whole however narrow the row.
    expect(html).toContain('~/Projects/github/</span><span class="shrink-0">specweave-umb');
    expect(html).toContain(">+1<");
    expect(html).toContain(
      "Umbrella: Also on MacBook Pro (This app can see it); ministorm (This app can see it); M1Max (This app cannot see it). Folder /Users/you/Projects/github/specweave-umb. Show every copy",
    );
    expect(html).not.toContain("Also on MacBook Pro, ministorm");
  });

  it("names each machine by its nickname, keeps the host name beside it and offers Rename", () => {
    setUp();
    runtime.nicknames = { [m3]: "M3" };
    const html = renderToStaticMarkup(<MachinesSettingsPanel />);
    expect(html).toContain("M3");
    expect(html).toContain(" · MacBook Pro");
    expect(html).toContain('aria-label="Rename M3"');
    expect(html).toContain('aria-label="Rename M4MAX"');
  });

  it("lists who can run work on this Mac and says it on that machine's row", () => {
    setUp();
    runtime.grants = {
      grants: [
        {
          coordinatorEnvironmentId: m3,
          machineLabel: "MacBook Pro",
          projects: { kind: "linked" },
          accounts: { kind: "all" },
          owner: "self",
          hopLimit: 2,
          runtimeCap: "auto",
          expiresAt: null,
          status: "active",
          revokedAt: null,
          interruptAt: null,
          runningThreads: 1,
          legacy: false,
        },
      ],
      projects: [{ id: ProjectId.make("p-m4"), title: "easychamp", linkedTo: [m3] }],
      accounts: [],
    };
    const html = renderToStaticMarkup(<MachinesSettingsPanel />);
    expect(html).toContain('aria-label="Who can run work here"');
    expect(html).toContain("Agents on MacBook Pro can start work on M4MAX");
    expect(html).toContain("Projects linked to MacBook Pro: easychamp · Active");
    expect(html).toContain(">Linked projects<");
    expect(html.match(/aria-label="Agents on MacBook Pro can start work on M4MAX/g)).toHaveLength(
      1,
    );
    expect(html).not.toContain("use this machine too");
  });

  it("keeps one order: this machine, your phone, other machines, who can run work here, Advanced", () => {
    setUp();
    runtime.grants = { grants: [], projects: [], accounts: [] };
    const m5 = EnvironmentId.make("env-m5");
    runtime.discovered = new Map([
      [
        m5,
        {
          environment: { environmentId: m5, label: "MacBook Pro (2)" },
          availability: "online",
          status: Option.none(),
        },
      ],
    ]);
    try {
      const html = renderToStaticMarkup(<MachinesSettingsPanel />);
      const at = (mark: string) => {
        expect(html.split(mark)).toHaveLength(2);
        return html.indexOf(mark);
      };
      const order = [
        at('data-part="summary"'),
        at("data-machine-here-details"),
        at('data-part="your-phone"'),
        at('data-part="other-machines"'),
        at('id="machines-join-card"'),
        at('aria-label="Who can run work here"'),
        at('data-part="routing"'),
        at('data-part="advanced"'),
      ];
      expect(order).toEqual([...order].sort((a, b) => a - b));
      // The private QR row sits in the phone card; this machine's rows and saved connections are folded.
      expect(html).toMatch(/data-part="your-phone"[^>]*><div data-part="pair-phone">/);
      expect(html).toMatch(
        /<details data-part="advanced"><div data-part="this-machine-rows"><\/div><div data-part="saved-connections">/,
      );
      // A pending step is the head of the phone card, so the page adds no second step.
      expect(html).not.toContain("You are set");
      expect(html).toContain('data-has-setup="yes"');
      expect(html).toContain("Let another of your machines run work here");
      // A machine of the same Connect account this app never opened is offered by name.
      expect(html).toMatch(/<input type="radio"[^>]* value="env-m5"/);
      expect(html).toContain("MacBook Pro (2)");
      expect(html).not.toContain("Allow another machine to run work here");
    } finally {
      runtime.discovered = new Map();
    }
  });

  it("keeps the same order once a machine may run work here", () => {
    setUp();
    runtime.grants = {
      grants: [
        {
          coordinatorEnvironmentId: m3,
          machineLabel: "MacBook Pro",
          projects: { kind: "all" },
          accounts: { kind: "all" },
          owner: "self",
          hopLimit: 2,
          runtimeCap: "auto",
          expiresAt: null,
          status: "active",
          revokedAt: null,
          interruptAt: null,
          runningThreads: 0,
          legacy: false,
        },
      ],
      projects: [],
      accounts: [],
    };
    const html = renderToStaticMarkup(<MachinesSettingsPanel />);
    const machines = html.indexOf('data-part="other-machines"');
    const card = html.indexOf('id="machines-join-card"');
    const section = html.indexOf('aria-label="Who can run work here"');
    expect(machines).toBeGreaterThan(-1);
    expect(machines).toBeLessThan(card);
    expect(card).toBeLessThan(section);
    expect(html.match(/id="machines-join-card"/g)).toHaveLength(1);
  });

  it("lists this machine under its summary, without a second name line, and not among the others", () => {
    setUp();
    const html = renderToStaticMarkup(<MachinesSettingsPanel />);
    const here = html.slice(
      html.indexOf("data-machine-here-details"),
      html.indexOf('data-part="your-phone"'),
    );
    expect(here).toContain("Projects and accounts on this machine");
    expect(here).toContain('aria-label="M4MAX"');
    // Its name and Rename are the summary's; the card keeps its projects and accounts.
    expect(here).toMatch(/<div class="hidden"><svg/);
    expect(here).toContain(">Projects<");
    const others = html.slice(html.indexOf('data-part="other-machines"'));
    expect(others).not.toContain('aria-label="M4MAX"');
    expect(others).toContain('aria-label="MacBook Pro"');
  });

  it("draws this machine once when the fleet list names it too", () => {
    setUp();
    runtime.fleet = {
      ...(runtime.fleet as object),
      snapshot: { ...snapshot, machines: [machine(m4, "M4MAX"), ...snapshot.machines] },
    };
    const html = renderToStaticMarkup(<MachinesSettingsPanel />);
    expect(html.match(/aria-label="M4MAX"/g)).toHaveLength(1);
    const others = html.slice(html.indexOf('data-part="other-machines"'));
    expect(others).not.toContain('aria-label="M4MAX"');
    expect(others).toContain('aria-label="MacBook Pro"');
  });

  it("adds no done line once no step is left: the summary's facts already say it", () => {
    setUp();
    runtime.step = "done";
    expect(renderToStaticMarkup(<MachinesSettingsPanel />)).not.toContain("You are set");
    runtime.connectKind = "unavailable";
    runtime.phoneCard = false;
    const html = renderToStaticMarkup(<MachinesSettingsPanel />);
    expect(html).not.toContain("You are set");
    // Without the phone card, pairing over the person's own network stands where the card would.
    expect(html).not.toContain('data-part="your-phone"');
    expect(html.indexOf('data-part="pair-phone"')).toBeLessThan(
      html.indexOf('data-part="other-machines"'),
    );
  });

  it("offers letting a connected machine without a grant here use this machine too", () => {
    setUp();
    runtime.grants = { grants: [], projects: [], accounts: [] };
    const html = renderToStaticMarkup(<MachinesSettingsPanel />);
    expect(html).toContain("Agents on MacBook Pro can start work on M4MAX");
    expect(html.match(/>Allow MacBook Pro</g)).toHaveLength(1);
    expect(html).toContain("Not set up yet.");
    expect(html).not.toContain("use this machine too");
    // Never for this machine itself.
    expect(html).not.toContain(">Allow M4MAX<");
  });

  it("shows no allow-back step before the grants load or once that machine holds a grant", () => {
    setUp();
    expect(renderToStaticMarkup(<MachinesSettingsPanel />)).not.toContain(">Allow MacBook Pro<");
    runtime.grants = {
      grants: [
        {
          coordinatorEnvironmentId: m3,
          machineLabel: "MacBook Pro",
          projects: { kind: "linked" },
          accounts: { kind: "all" },
          owner: "self",
          hopLimit: 2,
          runtimeCap: "auto",
          expiresAt: null,
          status: "revoked",
          revokedAt: null,
          interruptAt: null,
          runningThreads: 0,
          legacy: false,
        },
      ],
      projects: [],
      accounts: [],
    };
    expect(renderToStaticMarkup(<MachinesSettingsPanel />)).not.toContain(">Allow MacBook Pro<");
  });

  it("names a coordinator the server sends only by id, never printing the raw id", () => {
    setUp();
    const grant = {
      coordinatorEnvironmentId: m3,
      machineLabel: m3 as string,
      projects: { kind: "linked" as const },
      accounts: { kind: "all" as const },
      owner: "self" as const,
      hopLimit: 2,
      runtimeCap: "auto" as const,
      expiresAt: null,
      status: "active" as const,
      revokedAt: null,
      interruptAt: null,
      runningThreads: 0,
      legacy: false,
    };
    runtime.grants = { grants: [grant], projects: [], accounts: [] };
    runtime.nicknames = { [m3]: "M3" };
    const html = renderToStaticMarkup(<MachinesSettingsPanel />);
    expect(html).toContain("Projects linked to M3 (none yet)");
    expect(html).not.toContain(`Projects linked to ${m3}`);
  });

  it("connects a private machine this app cannot see with the fleet pairing", async () => {
    setUp();
    await act(async () => {
      rendered = create(<MachinesSettingsPanel />);
    });
    const connect = rendered!.root
      .findAllByType("button")
      .find((button) => button.props.children === "Connect");
    expect(connect).toBeDefined();
    await act(async () => connect!.props.onClick());
    expect(runtime.connect).toHaveBeenCalledWith(snapshot.machines[1]);
  });

  it("makes a one-time link for the other machine's app and says where to paste it", async () => {
    setUp();
    runtime.createCredential.mockResolvedValue({
      id: "link",
      credential: "pairing-secret",
      expiresAt: { epochMillis: Date.UTC(2026, 9, 19, 12, 5) },
    });
    await act(async () => {
      rendered = create(<MachinesSettingsPanel />);
    });
    const bothWays = rendered!.root
      .findAllByType("button")
      .find((button) => button.props.children === "Make pairing link");
    await act(async () => bothWays!.props.onClick());
    expect(runtime.createCredential).toHaveBeenCalledWith(
      expect.objectContaining({ label: "App on MacBook Pro" }),
    );
    const input = rendered!.root.findByType("input");
    expect(input.props.value).toBe("https://m4max.tailnet.ts.net/pair#token=pairing-secret");
    expect(JSON.stringify(rendered!.toJSON())).toContain(
      "On MacBook Pro, open Settings > Machines > Advanced > Saved connections > Add connection > Remote link and paste this link.",
    );
  });

  it("falls back to the pairing code when no address another machine can open is known", () => {
    const html = renderToStaticMarkup(
      <ConnectBothWaysView
        machineLabel="MacBook Pro"
        canCreate
        creating={false}
        created={{ link: null, code: "pairing-secret", expiresAt: "12:05 PM" }}
        onCreate={vi.fn()}
        onDone={vi.fn()}
      />,
    );
    expect(html).toContain("enter this machine&#x27;s private address and this pairing code");
    expect(html).toContain("Works once, until 12:05 PM");
  });
});

describe("Add for agents", () => {
  const view = (allowed: boolean, error: string | null = null) =>
    renderToStaticMarkup(
      <AddForAgentsView
        machineLabel="Windows"
        allowed={allowed}
        adding={false}
        error={error}
        onAdd={vi.fn()}
      />,
    );

  it("offers the button when this app can reach both machines", () => {
    const html = view(true);
    expect(html).toContain(">Add Windows<");
    expect(html).toContain("Step 1: add Windows");
  });

  it("names the manual route, with no button, when the connection cannot add it", () => {
    const html = view(false);
    expect(html).not.toContain(">Add Windows<");
    expect(html).toContain("choose Join a main machine");
  });

  it("says what is next once added, with no button to press twice", () => {
    const html = renderToStaticMarkup(
      <AddForAgentsView
        machineLabel="Windows"
        allowed
        adding={false}
        added
        error={null}
        onAdd={vi.fn()}
      />,
    );
    expect(html).toContain("Added Windows");
    expect(html).toContain("Choose Allow on this line after Refresh.");
    expect(html).not.toContain(">Add Windows<");
  });

  it("shows why adding failed", () => {
    expect(view(true, "Machine offline")).toContain("Machine offline");
  });
});
