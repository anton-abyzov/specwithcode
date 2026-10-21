import { act, type ComponentProps, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProjectId, ThreadId } from "@specweave-studio/contracts";
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
  nicknames: {} as Record<string, string>,
  connect: vi.fn(async () => {}),
  createCredential: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => null }));
vi.mock("./settingsLayout", () => ({
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
vi.mock("./HandoffModeSettings", () => ({ HandoffModeSettings: () => null }));
vi.mock("./usePrimaryFleet", () => ({ usePrimaryFleet: () => runtime.fleet }));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({ environments: runtime.environments }),
}));
vi.mock("../../state/entities", () => ({
  useProjects: () => runtime.projects,
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
}));
vi.mock("./RenameMachineDialog", () => ({ RenameMachineDialog: () => null }));
vi.mock("../../environments/primary", () => ({
  createServerPairingCredential: runtime.createCredential,
  readPrimaryEnvironmentTarget: () => ({ target: { httpBaseUrl: "https://m4max.tailnet.ts.net" } }),
}));

import { ConnectBothWaysView, MachinesSettingsPanel } from "./MachinesSettings";

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
  vi.clearAllMocks();
});

describe("Settings > Machines", () => {
  it("shows each machine with visibility, workers, shared projects and accounts", () => {
    setUp();
    const html = renderToStaticMarkup(<MachinesSettingsPanel />);
    expect(html).toContain("M4MAX");
    expect(html).toContain("This machine");
    expect(html).toContain("This app can see it");
    expect(html).toContain("This app cannot see it");
    expect(html).toContain("Workers allowed");
    expect(html).toContain("EasyChamp");
    expect(html).toContain("Runs workers");
    expect(html).toContain("/Users/a/easychamp");
    expect(html).toContain("someone@example.com · also on M4MAX");
    expect(html).toContain("Connect to see its accounts.");
    expect(html).toContain("Connect both ways");
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
    expect(html).toContain('aria-label="Who can run work on this Mac"');
    expect(html).toContain("May run work here");
    expect(html).toContain("Projects linked to MacBook Pro: easychamp · Active · 1 running thread");
    expect(html.match(/May run work here/g)).toHaveLength(1);
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
      .find((button) => button.props.children === "Connect both ways");
    await act(async () => bothWays!.props.onClick());
    expect(runtime.createCredential).toHaveBeenCalledWith(
      expect.objectContaining({ label: "App on MacBook Pro" }),
    );
    const input = rendered!.root.findByType("input");
    expect(input.props.value).toBe("https://m4max.tailnet.ts.net/pair#token=pairing-secret");
    expect(JSON.stringify(rendered!.toJSON())).toContain(
      "On MacBook Pro, open Settings > Connections > Add environment > Remote link and paste this link.",
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
