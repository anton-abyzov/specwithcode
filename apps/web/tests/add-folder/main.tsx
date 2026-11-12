import { createRoot } from "react-dom/client";
import { useState } from "react";
import { FolderPlusIcon } from "lucide-react";
import { EnvironmentId } from "@specweave-studio/contracts";
import { collapseRestartedBrowsePath } from "../../src/components/CommandPalette.logic";
import { CommandPaletteContent } from "../../src/components/CommandPaletteContent";
import {
  AddFolderAction,
  AddFolderPanel,
  SystemFolderButton,
  useAddFolder,
} from "../../src/components/studio/AddFolderPanel";
import { projectPlaces } from "../../src/components/studio/folderBrowser.logic";
import { CommandDialog, CommandDialogPopup } from "../../src/components/ui/command";
import { readRecentFolders, rememberRecentFolder } from "../../src/hooks/useProjectFolderChoice";
import { folderDropRefusal } from "../../src/lib/folderDrop";
import { applyPlatform, type Platform } from "../../src/lib/platformConventions";
import "./fixture.css";

// The real Add folder panel and its address-bar hook inside the real command
// dialog, over a made-up disk (mocks.ts). Nothing is added to any project list:
// a confirmed folder is recorded on `window` for the verifier to read.
const MACHINES = {
  mac: {
    label: "Work Mac",
    platform: "MacIntel",
    thisDevice: true,
    projectsFolder: "/Users/you/Projects",
    projects: [{ workspaceRoot: "/Users/you/Projects/storefront", title: "Storefront" }],
  },
  linux: {
    label: "Linux server",
    platform: "Linux",
    thisDevice: false,
    projectsFolder: null,
    projects: [{ workspaceRoot: "/home/you/work/client-app", title: "Client app" }],
  },
  pc: {
    label: "Office PC",
    platform: "Win32",
    thisDevice: false,
    projectsFolder: null,
    projects: [],
  },
} as const;

declare global {
  interface Window {
    /** Every confirm that reached the add step, in order. */
    addCalls: string[];
    added: { machine: string; path: string } | null;
    pickerOpened: number;
    /** Paths the desktop app would report for dropped files, by file name. */
    droppedPaths: Record<string, string>;
  }
}
window.addCalls = [];
window.added = null;
window.pickerOpened = 0;
window.droppedPaths = {};

const params = new URLSearchParams(location.search);
const os = (params.get("os") ?? "macos") as Platform;
applyPlatform(document.documentElement, os);
document.documentElement.classList.toggle("dark", params.get("theme") === "dark");
const machineId = (params.get("machine") ?? "mac") as keyof typeof MACHINES;
// The desktop app's bridge: the system folder dialog and dropped paths exist only there.
const desktop = params.get("desktop") !== "0";
const copiesCheck = params.get("copies") === "1";

function Fixture() {
  const machine = MACHINES[machineId];
  const environmentId = EnvironmentId.make(machineId);
  const [query, setQuery] = useState(params.get("path") ?? "~/");
  const [checking, setChecking] = useState(false);
  const canPick = desktop && machine.thisDevice;
  const folder = useAddFolder({
    environmentId,
    active: true,
    value: query,
    onValueChange: (next) => setQuery(collapseRestartedBrowsePath(next)),
    platform: machine.platform,
    cwd: null,
    machineLabel: machine.label,
    projects: machine.projects,
    allowed: true,
    add: async (path) => {
      window.addCalls.push(path);
      if (copiesCheck) {
        setChecking(true);
        await new Promise((done) => setTimeout(done, 900));
        setChecking(false);
      }
      if (path.includes("locked")) return `The folder '${path}' cannot be written to.`;
      rememberRecentFolder(environmentId, path);
      window.added = { machine: machineId, path };
      return null;
    },
    pickNatively: canPick
      ? () => {
          window.pickerOpened += 1;
        }
      : null,
    dropRefusal: folderDropRefusal({
      inDesktopApp: desktop,
      targetIsThisDevice: machine.thisDevice,
      machineLabel: machine.label,
    }),
    getPathForFile: desktop ? (file) => window.droppedPaths[file.name] ?? "" : undefined,
  });
  return (
    <CommandDialog open>
      <CommandDialogPopup
        aria-label="Add project"
        className="overflow-hidden has-[[data-command-form]]:max-h-[min(48rem,90dvh)]"
      >
        <CommandPaletteContent
          mode="none"
          panelSize="form"
          autoHighlight={false}
          items={[]}
          value={query}
          onValueChange={(value, details) => {
            const event: { target?: unknown; isComposing?: unknown } | undefined = details?.event;
            folder.bar.change(value, {
              element: event?.target instanceof HTMLInputElement ? event.target : null,
              composing: event?.isComposing === true,
            });
          }}
          primaryAction={<AddFolderAction folder={folder} />}
          inputAccessory={
            desktop ? (
              <SystemFolderButton
                className="absolute inset-e-2.5 top-1/2 -translate-y-1/2"
                picking={false}
                disabled={!canPick}
                describedBy={folder.noteId}
                onPick={() => {
                  window.pickerOpened += 1;
                }}
              />
            ) : null
          }
          inputProps={{
            placeholder: "Folder path, like ~/projects/my-app",
            "aria-label": "Folder path",
            startAddon: <FolderPlusIcon />,
            ...(desktop ? { className: "*:data-[slot=autocomplete-input]:pe-28!" } : {}),
            onPaste: folder.bar.onPaste,
            ...folder.bar.aria,
            onKeyDown: (event) => {
              if (folder.bar.onKeyDown(event)) {
                (
                  event as typeof event & { preventBaseUIHandler?: () => void }
                ).preventBaseUIHandler?.();
              }
            },
          }}
        >
          <AddFolderPanel
            folder={folder}
            places={projectPlaces({
              projectsFolder: machine.projectsFolder,
              projectRoots: machine.projects.map((project) => project.workspaceRoot),
              recent: readRecentFolders(environmentId),
            })}
            busyNote={checking ? "Looking for copies on other machines…" : null}
            pickerNote={
              desktop && !canPick
                ? `The system dialog shows this device's folders only. Type or paste a path on ${machine.label}.`
                : null
            }
          />
        </CommandPaletteContent>
      </CommandDialogPopup>
    </CommandDialog>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
