import { CloneProjectDestination } from "../../src/components/studio/CloneProjectDestination";
import { createRoot } from "react-dom/client";
import { useState } from "react";
import { EnvironmentId } from "@specweave-studio/contracts";
import { useProjectFolderChoice } from "../../src/hooks/useProjectFolderChoice";
import {
  ProjectCreationPreview,
  projectCreationGroups,
} from "../../src/components/studio/ProjectCreation";
import { CommandPaletteContent } from "../../src/components/CommandPaletteContent";
import { CommandPaletteResults } from "../../src/components/CommandPaletteResults";
import { CommandDialog, CommandDialogPopup } from "../../src/components/ui/command";
import "./fixture.css";
document.documentElement.classList.toggle(
  "dark",
  new URLSearchParams(location.search).get("theme") === "dark",
);
function Fixture() {
  const clone = new URLSearchParams(location.search).get("mode") === "clone";
  const [machine, setMachine] = useState(EnvironmentId.make("m4"));
  const [name, setName] = useState(clone ? "" : "Example project");
  const folder = useProjectFolderChoice(machine, false);
  const groups = projectCreationGroups({
    kind: "code",
    busy: false,
    github: null,
    addExisting: () => {
      (window as any).existingClicked = true;
    },
    machines: ["m4", "m1"].map((id) => ({
      selected: machine === id,
      item: {
        kind: "action",
        value: id,
        title: id === "m4" ? "MacBook M4" : "MacBook M1",
        description: id === "m4" ? "This device" : "Remote machine",
        icon: null,
        searchTerms: [],
        keepOpen: true,
        run: async () => {
          folder.reset();
          setMachine(EnvironmentId.make(id));
        },
      },
    })),
  });
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
          ) : (
            <>
              <ProjectCreationPreview
                kind="code"
                name={name}
                path={folder.path ? `${folder.path}/example-project` : null}
                root={folder.path}
                machine={machine === "m4" ? "MacBook M4" : "MacBook M1"}
              />
              {folder.picker}
            </>
          )}
          <CommandPaletteResults
            groups={
              clone ? groups.filter((group) => group.value === "new-project-machines") : groups
            }
            isActionsOnly={false}
            keybindings={{}}
            onExecuteItem={(item) => {
              if (item.kind === "action") void item.run();
            }}
          />
        </CommandPaletteContent>
      </CommandDialogPopup>
    </CommandDialog>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
