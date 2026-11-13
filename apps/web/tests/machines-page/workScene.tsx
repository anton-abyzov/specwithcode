// `?scene=work`: machine cards with work allowed both ways, one not set up,
// and the "Who can run work here" grant cards (own, stuck on no projects, and
// someone else's). Changes stay local; nothing is saved.
import { EnvironmentId, ProjectId, ProviderInstanceId } from "@specweave-studio/contracts";
import type {
  StudioFleetSnapshot,
  StudioWorkGrant,
  StudioWorkGrantsSnapshot,
} from "@specweave-studio/contracts/studioFleet";
import { MachineRow } from "../../src/components/settings/MachinesSettings";
import { buildMachineRows } from "../../src/components/settings/machinesSettings.logic";
import { MachineWorkGrantsList } from "../../src/components/settings/MachineWorkGrants";

const m4 = EnvironmentId.make("env-m4");
const m5 = EnvironmentId.make("env-m5");
const m1 = EnvironmentId.make("env-m1");
const dana = EnvironmentId.make("env-dana");
const later = "2026-12-13T12:00:00Z";
const soon = "2026-11-20T12:00:00Z";

const fleet: StudioFleetSnapshot = {
  configured: true,
  connectPermission: "access:write",
  observedAt: "2026-11-13T12:00:00Z",
  listener: "network",
  machines: [
    {
      id: "m5" as never,
      label: "M5",
      environmentId: m5,
      url: "https://m5.connect.specwithcode.com",
      transport: "connect",
      status: "reachable",
      pairingConfigured: true,
      workers: {
        status: "allowed",
        access: "full-access",
        expiresAt: later,
        renewable: true,
        problem: null,
      },
    },
    {
      id: "m1" as never,
      label: "M1",
      environmentId: m1,
      url: "https://m1.tailnet.ts.net",
      transport: "tailnet",
      status: "reachable",
      pairingConfigured: true,
      workers: {
        status: "not_allowed",
        access: null,
        expiresAt: null,
        renewable: false,
        problem: null,
      },
    },
  ],
} as never;

const grant = (over: Partial<StudioWorkGrant>): StudioWorkGrant =>
  ({
    coordinatorEnvironmentId: m5,
    machineLabel: "M5",
    projects: { kind: "all" },
    accounts: { kind: "all" },
    owner: "self",
    hopLimit: 2,
    runtimeCap: "full-access",
    expiresAt: later,
    status: "active",
    revokedAt: null,
    interruptAt: null,
    runningThreads: 0,
    legacy: false,
    routines: true,
    kind: "own",
    renews: true,
    ...over,
  }) as StudioWorkGrant;

const workGrants: StudioWorkGrantsSnapshot = {
  grants: [
    grant({}),
    grant({
      coordinatorEnvironmentId: m1,
      machineLabel: "M1",
      projects: { kind: "linked" },
      runtimeCap: null,
      routines: false,
    }),
    grant({
      coordinatorEnvironmentId: dana,
      machineLabel: "Dana's laptop",
      owner: "other",
      kind: "team",
      hopLimit: 1,
      projects: { kind: "listed", projectIds: [ProjectId.make("website")] },
      accounts: { kind: "listed", instanceIds: [ProviderInstanceId.make("claude")] },
      runtimeCap: "auto-accept-edits",
      routines: false,
      expiresAt: soon,
      renews: false,
    }),
  ],
  projects: [
    { id: ProjectId.make("specweave"), title: "specweave", linkedTo: [m5] },
    { id: ProjectId.make("website"), title: "website", linkedTo: [] },
    { id: ProjectId.make("easychamp"), title: "EasyChamp", linkedTo: [m5] },
  ],
  accounts: [
    {
      instanceId: ProviderInstanceId.make("claude"),
      label: "Claude",
      driver: "claudeAgent",
      account: "you@example.com",
      signedIn: true,
    },
    {
      instanceId: ProviderInstanceId.make("codex"),
      label: "Codex",
      driver: "codex",
      account: "you@example.com",
      signedIn: true,
    },
    {
      instanceId: ProviderInstanceId.make("cursor"),
      label: "Cursor",
      driver: "cursor",
      account: null,
      signedIn: false,
    },
  ],
} as never;

const rows = buildMachineRows({
  environments: [
    { environmentId: m4, label: "M4", phase: "connected", statusText: "Connected" },
    { environmentId: m5, label: "M5", phase: "connected", statusText: "Connected" },
    { environmentId: m1, label: "M1", phase: "connected", statusText: "Connected" },
  ],
  primaryEnvironmentId: m4,
  fleet,
  canPair: true,
  hostBlocks: [],
  projects: [],
  workGrants,
});

export function WorkScene() {
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6" data-scene="work">
      <ul className="divide-y divide-border/60 rounded-xl border">
        {rows
          .filter((row) => row.environmentId !== m4)
          .map((row) => (
            <MachineRow
              key={row.environmentId}
              hereLabel="M4"
              row={row}
              pending={null}
              onConnect={() => undefined}
            />
          ))}
      </ul>
      <MachineWorkGrantsList
        snapshot={workGrants}
        loading={false}
        failed={false}
        canManage
        pending={null}
        error={null}
        notice={null}
        onRefresh={() => undefined}
        onChange={() => undefined}
      />
    </div>
  );
}
