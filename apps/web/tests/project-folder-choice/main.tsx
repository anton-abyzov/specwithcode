import { CloneProjectDestination } from "../../src/components/studio/CloneProjectDestination";
import { createRoot } from "react-dom/client";
import { useState } from "react";
import { EnvironmentId } from "@specweave-studio/contracts";
import { useProjectFolderChoice } from "../../src/hooks/useProjectFolderChoice";
import {
  AddExistingProjectLink,
  newProjectGitHubRow,
  ProjectCreationPreview,
  ProjectMachineChoice,
  projectCreationGroups,
} from "../../src/components/studio/ProjectCreation";
import {
  newProjectGitHubUnavailableReason,
  projectMachineUnavailableReason,
} from "../../src/studio/newProjectAvailability";
import { projectPlaces } from "../../src/components/studio/folderBrowser.logic";
import { projectMachineReason } from "../../src/studio/projectCreation";
import { LaptopIcon } from "lucide-react";

const MACHINES = {
  m4: {
    label: "MacBook M4",
    projectsFolder: "/Users/you/Projects",
    projects: [
      { workspaceRoot: "/Users/you/Projects/github/specweave-umb", title: "specweave" },
      { workspaceRoot: "/Users/you/Projects/github/vskill", title: "vskill" },
    ],
  },
  // Its projects folder is not made yet, and it has one project elsewhere.
  m1: {
    label: "MacBook M1",
    projectsFolder: "/Users/remote/Projects",
    projects: [{ workspaceRoot: "/Users/remote/work/client-app", title: "Client app" }],
  },
} as const;
import { CommandPaletteContent } from "../../src/components/CommandPaletteContent";
import { CommandPaletteResults } from "../../src/components/CommandPaletteResults";
import { CommandDialog, CommandDialogPopup } from "../../src/components/ui/command";
import { ProjectsFolderChoice } from "../../src/components/onboarding/ProjectsFolderChoice";
import "./fixture.css";
document.documentElement.classList.toggle(
  "dark",
  new URLSearchParams(location.search).get("theme") === "dark",
);
// `mode=states`: what New project says when it cannot do something: machines
// that cannot be chosen, GitHub signed out, and a folder it may not read.
const STATES = new URLSearchParams(location.search).get("mode") === "states";
const UNAVAILABLE_MACHINES = [
  {
    environmentId: "m2",
    label: "Studio Linux",
    reason: projectMachineUnavailableReason({
      online: false,
      status: "Offline",
      canOperate: true,
      supportsCreate: true,
    }),
  },
  {
    environmentId: "m3",
    label: "Shared iMac",
    reason: projectMachineUnavailableReason({
      online: true,
      status: "Connected",
      canOperate: false,
      supportsCreate: true,
    }),
  },
  {
    environmentId: "m5",
    label: "Old Mini",
    reason: projectMachineUnavailableReason({
      online: true,
      status: "Connected",
      canOperate: true,
      supportsCreate: false,
    }),
  },
];
function Fixture() {
  const clone = new URLSearchParams(location.search).get("mode") === "clone";
  const [machine, setMachine] = useState(EnvironmentId.make("m4"));
  const [name, setName] = useState(clone ? "" : "Example project");
  const current = MACHINES[machine as "m4" | "m1"];
  const folder = useProjectFolderChoice(machine, false, {
    defaultPath: clone ? null : STATES ? "/Users/you/Private" : current.projectsFolder,
    machineLabel: current.label,
    projects: current.projects,
    canCreateFolder: true,
    ...(clone
      ? {}
      : {
          projectName: name,
          places: projectPlaces({
            projectsFolder: current.projectsFolder,
            projectRoots: current.projects.map((project) => project.workspaceRoot),
          }),
        }),
  });
  const [specweave, setSpecweave] = useState(true);
  const groups = clone
    ? []
    : projectCreationGroups({
        kind: "code",
        busy: false,
        github: STATES
          ? newProjectGitHubRow({
              target: null,
              pathPreview: null,
              name,
              unavailable: newProjectGitHubUnavailableReason({
                discovery: {
                  sourceControlProviders: [
                    { kind: "github", status: "available", auth: { status: "unauthenticated" } },
                  ],
                } as never,
                pending: false,
                machine: current.label,
              }),
              checked: false,
              toggle: () => {
                (window as any).githubToggled = true;
              },
            })
          : null,
        specweave: { checked: specweave, toggle: () => setSpecweave((value) => !value) },
      });
  const machineChoice = (
    <ProjectMachineChoice
      machines={[
        ...(["m4", "m1"] as const).map((id) => ({
          environmentId: id,
          label: MACHINES[id].label,
          isPrimary: id === "m4",
          isConnected: true,
          icon: <LaptopIcon className="size-3.5" />,
        })),
        ...(STATES
          ? UNAVAILABLE_MACHINES.map((machine) => ({
              environmentId: machine.environmentId,
              label: machine.label,
              isPrimary: false,
              isConnected: false,
              unavailableReason: machine.reason,
              icon: <LaptopIcon className="size-3.5" />,
            }))
          : []),
      ]}
      selectedId={machine}
      reason={
        clone
          ? null
          : projectMachineReason({
              selected: machine,
              selectedLabel: current.label,
              suggested: "m4",
              thisDevice: "m4",
              loadBalancingEnabled: false,
            })
      }
      busy={false}
      onSelect={(id) => {
        if (clone) folder.reset();
        setMachine(EnvironmentId.make(id));
      }}
    />
  );
  return (
    <CommandDialog open>
      <CommandDialogPopup
        aria-label={clone ? "Clone repository" : "New project"}
        className="overflow-hidden has-[[data-command-form]]:max-h-[min(48rem,90dvh)]"
      >
        <CommandPaletteContent
          mode="none"
          panelSize="form"
          autoHighlight={false}
          value={name}
          onValueChange={setName}
          inputProps={{
            placeholder: clone ? "Choose a clone location below" : "Project name",
            "aria-label": "Project name",
          }}
          inputAccessory={
            clone ? null : (
              <button
                disabled={!folder.path || !name.trim()}
                className="absolute right-4 top-3 rounded border bg-background px-3 py-1 disabled:opacity-40"
              >
                Create
              </button>
            )
          }
        >
          {clone ? (
            <>
              {machineChoice}
              <CloneProjectDestination
                machine={machine === "m4" ? "MacBook M4" : "MacBook M1"}
                path={folder.path ? `${folder.path}/orbita` : null}
                picker={folder.picker}
                busy={false}
                allowed={true}
                onClone={() => {
                  (window as any).cloned = { machine, path: `${folder.path}/orbita` };
                }}
              />
            </>
          ) : (
            <>
              <ProjectCreationPreview
                kind="code"
                name={name}
                path={folder.path ? `${folder.path}/example-project` : null}
                root={folder.path}
                machine={machine === "m4" ? "MacBook M4" : "MacBook M1"}
              />
              {machineChoice}
              {folder.picker}
            </>
          )}
          {groups.length > 0 ? (
            <CommandPaletteResults
              groups={groups}
              isActionsOnly={false}
              keybindings={{}}
              onExecuteItem={(item) => {
                if (item.kind === "action") void item.run();
              }}
            />
          ) : null}
          {clone ? null : (
            <AddExistingProjectLink
              busy={false}
              onClick={() => {
                (window as any).existingClicked = true;
              }}
            />
          )}
        </CommandPaletteContent>
      </CommandDialogPopup>
    </CommandDialog>
  );
}
// `mode=setup`: the folder choice on the Projects step of first-run setup,
// `found=0` when setup found nothing to import.
function SetupFolder() {
  const [folder, setFolder] = useState<string | null>(null);
  const machine = MACHINES.m4;
  return (
    <div className="mx-auto mt-10 max-w-3xl rounded-2xl border bg-zinc-25/80 px-6 py-5 dark:bg-white/2">
      <h1 className="text-2xl font-semibold tracking-tight">Choose your projects</h1>
      <ProjectsFolderChoice
        environmentId={EnvironmentId.make("m4")}
        machineLabel={machine.label}
        projectsFolder={machine.projectsFolder}
        projects={machine.projects}
        defaultOpen={new URLSearchParams(location.search).get("found") === "0"}
        disabled={false}
        folder={folder}
        onFolderChange={setFolder}
        onOtherWays={() => {
          (window as any).otherWaysClicked = true;
        }}
      />
      <p data-slot="setup-folder" className="mt-3 text-sm text-muted-foreground">
        {folder ?? "No folder chosen"}
      </p>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(
  new URLSearchParams(location.search).get("mode") === "setup" ? <SetupFolder /> : <Fixture />,
);
