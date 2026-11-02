import { EnvironmentId, ProjectId, ThreadId } from "@specweave-studio/contracts";
import { createRoot } from "react-dom/client";
import {
  AddForAgentsView,
  MachineRow,
  type MachineRowModel,
} from "../../src/components/settings/MachinesSettings";
import { buildMachineRows } from "../../src/components/settings/machinesSettings.logic";
import { TooltipProvider } from "../../src/components/ui/tooltip";
import "./fixture.css";

const params = new URLSearchParams(location.search);
document.documentElement.classList.toggle("dark", params.get("theme") === "dark");

const m4 = EnvironmentId.make("env-m4");
const windows = EnvironmentId.make("env-windows");
const m3 = EnvironmentId.make("env-m3");
const member = (environmentId: EnvironmentId, id: string) => ({
  environmentId,
  projectId: ProjectId.make(id),
  coordinatorThreadId: ThreadId.make(`project-coordinator:${id}`),
});
const shared = (
  environmentId: EnvironmentId,
  title: string,
  folder: string,
  extra: Record<string, unknown> = {},
) => ({
  environmentId,
  id: `${title}-${environmentId}`,
  title,
  workspaceRoot: folder,
  workspaceSettings: {
    ...extra,
    logicalProject: {
      id: `logical-${title}`,
      title,
      members: [member(environmentId, `${title}-a`), member(m3, `${title}-b`)],
    },
  },
});
const solo = (
  environmentId: EnvironmentId,
  title: string,
  folder: string,
  extra: Record<string, unknown> = {},
) => ({ environmentId, id: title, title, workspaceRoot: folder, workspaceSettings: extra });

const rows = buildMachineRows({
  environments: [
    { environmentId: m4, label: "M4", phase: "connected", statusText: "Connected" },
    { environmentId: windows, label: "PRCTY-AABYZOV", phase: "connected", statusText: "Connected" },
  ],
  primaryEnvironmentId: m4,
  fleet: {
    configured: true,
    connectPermission: "access:write",
    observedAt: "2026-11-02T12:00:00Z",
    listener: "network",
    machines: [],
  },
  canPair: true,
  hostBlocks: [],
  projects: [
    shared(m4, "specweave", "/Users/me/Projects/github/specweave-umb/repositories/specweave"),
    shared(m4, "hello-handoff", "/Users/me/Projects/hello-handoff"),
    shared(m4, "swc-demo-skills", "/Users/me/Projects/swc-demo-skills", {
      coordinatorBinding: { state: "transferred" },
    }),
    solo(
      m4,
      "EasyChamp with a very long project name that must not push the labels",
      "/Users/me/ec",
    ),
    solo(m4, "website", "/Users/me/Projects/website"),
    shared(m4, "1164 handoff UI check", "/Users/me/.t/ui", { origin: "automated" }),
    shared(m4, "1164 handoff live check", "/Users/me/.t/live", { origin: "automated" }),
    solo(m4, "old-site", "/Users/me/Projects/old-site", { archived: true }),
    solo(windows, "windows-app", "C:\\Users\\me\\Documents\\Projects\\windows-app\\source\\main"),
  ] as never,
});

const row = (index: number): MachineRowModel => rows[index]!;

createRoot(document.getElementById("root")!).render(
  <TooltipProvider>
    <main className="min-h-screen bg-background p-4 text-foreground sm:p-8">
      <ul className="mx-auto max-w-3xl divide-y divide-border/60 rounded-xl border">
        <MachineRow row={row(0)} pending={null} onConnect={() => undefined} />
        <MachineRow
          row={row(1)}
          pending={null}
          onConnect={() => undefined}
          addForAgents={
            <AddForAgentsView
              machineLabel="PRCTY-AABYZOV"
              allowed
              adding={false}
              error={null}
              onAdd={() => undefined}
            />
          }
        />
      </ul>
    </main>
  </TooltipProvider>,
);
