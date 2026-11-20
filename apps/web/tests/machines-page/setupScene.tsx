// `?scene=setup`: linux-mini's Settings > Machines as Anton saw it on November 19, 2026.
// M5 may start work on linux-mini, linux-mini may not start work on M5, and this app has no
// full access to M5, so linux-mini cannot set that direction up itself. m1 has neither
// direction yet. The rows' Set up… and Allow… must each do something visible.
import { EnvironmentId } from "@specweave-studio/contracts";
import type {
  StudioFleetSnapshot,
  StudioWorkGrant,
  StudioWorkGrantsSnapshot,
} from "@specweave-studio/contracts/studioFleet";
import { Button } from "../../src/components/ui/button";
import type { WorkGrantChanges } from "../../src/components/settings/MachineCardDirections";
import { AddForAgentsView, MachineRow } from "../../src/components/settings/MachinesSettings";
import { buildMachineRows } from "../../src/components/settings/machinesSettings.logic";

const mini = EnvironmentId.make("env-mini");
// The fixture's `useEnvironmentScope` refuses ids ending in "-no-access": no full access there.
const m5 = EnvironmentId.make("env-m5-no-access");
const m1 = EnvironmentId.make("env-m1-no-access");
// A machine this app does have full access to, so linux-mini can add it from here.
const m4 = EnvironmentId.make("env-m4-full");
const now = "2026-11-19T23:45:00Z";

const fleet: StudioFleetSnapshot = {
  configured: true,
  connectPermission: "access:write",
  observedAt: now,
  listener: "network",
  machines: [],
} as never;

const workGrants: StudioWorkGrantsSnapshot = {
  durations: true,
  grants: [
    {
      coordinatorEnvironmentId: m5,
      machineLabel: "M5",
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
      endsAt: null,
    } as unknown as StudioWorkGrant,
  ],
  projects: [],
  accounts: [],
} as never;

const rows = buildMachineRows({
  environments: [
    { environmentId: mini, label: "linux-mini", phase: "connected", statusText: "Connected" },
    { environmentId: m5, label: "M5", phase: "connected", statusText: "Connected" },
    { environmentId: m1, label: "m1", phase: "connected", statusText: "Connected" },
    { environmentId: m4, label: "m4", phase: "connected", statusText: "Connected" },
  ],
  primaryEnvironmentId: mini,
  fleet,
  canPair: true,
  hostBlocks: [],
  projects: [
    {
      environmentId: m5,
      id: "first-m5",
      title: "firstproject",
      workspaceRoot: "~/Projects/firstproject",
    },
    { environmentId: m1, id: "greet-m1", title: "greet-anton", workspaceRoot: "~/greet-anton" },
  ] as never,
  workGrants,
});

const changes: WorkGrantChanges = {
  canManage: true,
  pending: null,
  error: null,
  notice: null,
  about: null,
  change: async () => undefined,
};

export function SetupScene() {
  const others = rows.filter((row) => row.environmentId !== mini);
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6" data-scene="setup">
      <ul className="divide-y divide-border/60 rounded-xl border">
        {others.map((row) => (
          <MachineRow
            key={row.environmentId}
            hereLabel="linux-mini"
            primaryEnvironmentId={mini}
            row={row}
            pending={null}
            onConnect={() => undefined}
            durations
            grantChanges={changes}
            allowBack={
              row.canAllowBack ? (
                <div className="min-w-0 space-y-1" data-slot="allow-back">
                  <p className="text-foreground/80">Let {row.label} start work on linux-mini</p>
                  <Button size="xs">Allow {row.label}</Button>
                </div>
              ) : null
            }
            addForAgents={
              row.canAddForAgents ? (
                <AddForAgentsView
                  machineLabel={row.label}
                  hereLabel="linux-mini"
                  allowed={row.environmentId === m4}
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
