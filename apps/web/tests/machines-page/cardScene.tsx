// `?scene=card`: the shorter machine card (1326) in each state of its two direction rows:
// allowed with a time limit, allowed until stopped, ended, stopped with threads still
// running, and never set up. Buttons act locally; nothing is saved.
import { EnvironmentId, ProjectId, ThreadId } from "@specweave-studio/contracts";
import type {
  StudioFleetSnapshot,
  StudioWorkGrant,
  StudioWorkGrantsSnapshot,
} from "@specweave-studio/contracts/studioFleet";
import type { WorkGrantChanges } from "../../src/components/settings/MachineCardDirections";
import { AddForAgentsView, MachineRow } from "../../src/components/settings/MachinesSettings";
import { buildMachineRows } from "../../src/components/settings/machinesSettings.logic";

const m4 = EnvironmentId.make("env-m4");
const m5 = EnvironmentId.make("env-m5");
const m1 = EnvironmentId.make("env-m1");
const mini = EnvironmentId.make("env-mini");
const dana = EnvironmentId.make("env-dana");
const fresh = EnvironmentId.make("env-fresh");
const nov20 = "2026-11-20T17:00:00Z";
const nov12 = "2026-11-12T17:00:00Z";
const now = "2026-11-13T21:30:00Z";

const allowed = {
  status: "allowed",
  access: "full-access",
  expiresAt: null,
  renewable: true,
  problem: null,
} as const;
const machine = (id: EnvironmentId, label: string, workers: unknown) => ({
  id: label as never,
  label,
  environmentId: id,
  url: `https://${label.toLowerCase()}.connect.specwithcode.com`,
  transport: "connect",
  status: "reachable",
  pairingConfigured: true,
  workers,
});

const fleet: StudioFleetSnapshot = {
  configured: true,
  connectPermission: "access:write",
  observedAt: now,
  listener: "network",
  machines: [
    machine(m5, "m5", allowed),
    machine(m1, "m1", { ...allowed, status: "not_allowed", access: null }),
    machine(mini, "linux-mini", allowed),
    machine(dana, "dana-laptop", { ...allowed, status: "revoked", access: null }),
  ],
} as never;

const grant = (over: Partial<StudioWorkGrant>): StudioWorkGrant =>
  ({
    coordinatorEnvironmentId: m5,
    machineLabel: "m5",
    projects: { kind: "all" },
    accounts: { kind: "all" },
    owner: "self",
    hopLimit: 2,
    runtimeCap: "full-access",
    expiresAt: null,
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
  durations: true,
  grants: [
    grant({ endsAt: nov20 }),
    grant({ coordinatorEnvironmentId: m1, machineLabel: "m1", endsAt: null }),
    grant({
      coordinatorEnvironmentId: mini,
      machineLabel: "linux-mini",
      status: "revoked",
      ended: true,
      endsAt: nov12,
      revokedAt: nov12,
    }),
    grant({
      coordinatorEnvironmentId: dana,
      machineLabel: "dana-laptop",
      status: "revoked",
      revokedAt: now,
      interruptAt: "2026-11-13T21:32:00Z",
      runningThreads: 2,
    }),
  ],
  projects: [],
  accounts: [],
} as never;

const member = (environmentId: EnvironmentId, id: string) => ({
  environmentId,
  projectId: ProjectId.make(id),
  coordinatorThreadId: ThreadId.make(`project-coordinator:${id}`),
});
// m5 holds seven projects, so its card shows five and "Show 2 more".
const titles = ["specweave", "vskill", "website", "easychamp", "football-sim", "notes", "blog"];
const projects = titles.flatMap((title, index) => [
  {
    environmentId: m5,
    id: `${title}-m5`,
    title,
    workspaceRoot: `/Users/anton/Projects/${title}`,
    workspaceSettings: {
      kind: "code",
      coordinatorBinding: { epoch: 1, state: index === 1 ? "transferred" : "active" },
      logicalProject: {
        id: `logical-${title}`,
        title,
        coordinatorId: "c",
        members: [member(m5, `${title}-m5`), member(m4, `${title}-m4`)],
      },
    },
  },
  {
    environmentId: m4,
    id: `${title}-m4`,
    title,
    workspaceRoot: `/Users/anton/Projects/${title}`,
    workspaceSettings: {
      kind: "code",
      coordinatorBinding: {
        epoch: index === 1 ? 2 : 0,
        state: index === 1 ? "active" : "transferred",
      },
      logicalProject: {
        id: `logical-${title}`,
        title,
        coordinatorId: "c",
        members: [member(m5, `${title}-m5`), member(m4, `${title}-m4`)],
      },
    },
  },
]);

const rows = buildMachineRows({
  environments: [
    { environmentId: m4, label: "m4", phase: "connected", statusText: "Connected" },
    { environmentId: m5, label: "m5", phase: "connected", statusText: "Connected" },
    { environmentId: m1, label: "m1", phase: "connected", statusText: "Connected" },
    { environmentId: mini, label: "linux-mini", phase: "connected", statusText: "Connected" },
    { environmentId: dana, label: "dana-laptop", phase: "connected", statusText: "Connected" },
    { environmentId: fresh, label: "m3", phase: "connected", statusText: "Connected" },
  ],
  primaryEnvironmentId: m4,
  fleet,
  canPair: true,
  hostBlocks: [],
  projects: projects as never,
  workGrants,
});

const changes = (about: EnvironmentId | null, notice: string | null): WorkGrantChanges => ({
  canManage: true,
  pending: null,
  error: null,
  notice,
  about,
  change: async () => undefined,
});

export function CardScene() {
  const others = rows.filter((row) => row.environmentId !== m4);
  const notice = changes(
    dana,
    "dana-laptop can no longer start work here. Its 2 running threads stop at 9:32 PM.",
  );
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6" data-scene="card">
      <ul className="divide-y divide-border/60 rounded-xl border">
        {others.map((row) => (
          <MachineRow
            key={row.environmentId}
            hereLabel="m4"
            row={row}
            pending={null}
            onConnect={() => undefined}
            grantChanges={notice}
            durations
            workersControl={<p className="text-muted-foreground">Full access</p>}
            allowBack={
              row.environmentId === fresh ? (
                <p className="text-muted-foreground">Let m3 start work here: setup</p>
              ) : null
            }
            addForAgents={
              row.environmentId === fresh ? (
                <AddForAgentsView
                  machineLabel="m3"
                  hereLabel="m4"
                  allowed
                  adding={false}
                  error={null}
                  onAdd={() => undefined}
                />
              ) : null
            }
          />
        ))}
      </ul>
    </div>
  );
}
