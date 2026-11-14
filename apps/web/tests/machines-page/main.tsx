import { EnvironmentId, ProjectId, ThreadId } from "@specweave-studio/contracts";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ManagedUpdatesView } from "../../src/components/settings/ManagedUpdatesSection";
import { UpdatePausePolicyView } from "../../src/components/settings/UpdatePausePolicyRow";
import {
  AddForAgentsView,
  MachineRow,
  type MachineRowModel,
} from "../../src/components/settings/MachinesSettings";
import { buildMachineRows } from "../../src/components/settings/machinesSettings.logic";
import { TooltipProvider } from "../../src/components/ui/tooltip";
import { AddDevicePage, MachinesPage } from "./page";
import { SendScene } from "./sendScene";
import { WorkScene } from "./workScene";
import "./fixture.css";

const params = new URLSearchParams(location.search);
document.documentElement.classList.toggle("dark", params.get("theme") === "dark");
// `?platform=windows` or `linux`: the system whose fonts, corners and key names the page follows.
document.documentElement.dataset.platform = params.get("platform") ?? "macos";

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

// `?scene=update-pause-off` and `?scene=update-pause-on`: the update cards of a
// Mac and of a Linux worker (no update agent) with "Pause running work for
// updates" in that position. The switches flip locally; nothing is saved.
// `?scene=update-pause-old`: the Linux worker's release predates the setting.
const scene = params.get("scene");
const updateStatus = {
  environmentId: m4,
  installationId: "m4-desktop",
  support: "supported",
  localAutomation: "enabled",
  remoteConsent: "not-enrolled",
  revision: 1,
  operation: "waiting-for-quiet",
  currentVersion: "1.0.242",
  availableVersion: "1.0.243",
  checkedAt: "2026-11-11T19:00:00Z",
} as const;

function UpdateCard(props: {
  label: string;
  local: boolean;
  os: "darwin" | "linux";
  support: "supported" | "unsupported";
}) {
  const [checked, setChecked] = useState(scene === "update-pause-on");
  return (
    <ManagedUpdatesView
      label={props.label}
      reachable
      status={{
        ...updateStatus,
        support: props.support,
        currentVersion: props.os === "linux" ? "1.0.236" : updateStatus.currentVersion,
      }}
      error={false}
      canManage
      canCheck
      pending={false}
      local={props.local}
      onAllow={() => undefined}
      onRevoke={() => undefined}
      onCheck={() => undefined}
      onRefresh={() => undefined}
      pausePolicy={
        <UpdatePausePolicyView
          machineLabel={props.label}
          local={props.local}
          os={props.os}
          checked={checked}
          continuationOff={false}
          reachable
          readOnly={false}
          unsupported={scene === "update-pause-old" && props.os === "linux"}
          writeAccess="granted"
          onCheckedChange={setChecked}
        />
      }
    />
  );
}

createRoot(document.getElementById("root")!).render(
  <TooltipProvider>
    <main className="min-h-screen bg-background p-4 text-foreground sm:p-8">
      {params.get("view") === "add-device" ? (
        <AddDevicePage tab={params.get("tab") === "computer" ? "computer" : "phone"} />
      ) : params.get("view") === "page" ? (
        // `?view=page&state=add-phone`: the whole page in its order; page.tsx lists the states.
        <MachinesPage
          hereCard={
            <MachineRow
              hereLabel="M4"
              row={row(0)}
              pending={null}
              onConnect={() => undefined}
              bare
            />
          }
          others={
            <MachineRow hereLabel="M4" row={row(1)} pending={null} onConnect={() => undefined} />
          }
        />
      ) : scene === "work" ? (
        <WorkScene />
      ) : scene === "send" ? (
        <SendScene />
      ) : scene?.startsWith("update-pause") ? (
        <div className="mx-auto max-w-xl" data-scene={scene}>
          <UpdateCard label="M4" local os="darwin" support="supported" />
          <UpdateCard label="Minisforum" local={false} os="linux" support="unsupported" />
        </div>
      ) : (
        <ul className="mx-auto max-w-3xl divide-y divide-border/60 rounded-xl border">
          <MachineRow hereLabel="M4" row={row(0)} pending={null} onConnect={() => undefined} />
          <MachineRow
            hereLabel="M4"
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
      )}
    </main>
  </TooltipProvider>,
);
