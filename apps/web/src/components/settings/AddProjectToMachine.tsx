import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";
import type { EnvironmentId } from "@specweave-studio/contracts";
import { ChevronDownIcon, FolderPlusIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { useTx } from "../../i18n";
import { useEnvironmentShellLive, useProjects, useServerConfigs } from "../../state/entities";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { AddToMachineDialog } from "../chat/AddToMachineDialog";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { projectsToAdd } from "./AddProjectToMachine.logic";

/**
 * Settings > Machines, on a connected machine that holds no project yet: the
 * step after joining it. A machine can only run a project it has a copy of,
 * so a joined machine does nothing until one is added. Opens the same Add to
 * another machine dialog as the Run on menu.
 *
 * Mounted for every connected machine, not only an empty one: the dialog
 * outlives the prompt, because the project it adds is what ends `empty`.
 */
export function AddProjectToMachine(props: {
  readonly environmentId: EnvironmentId;
  /** The machine's name as this app shows it. */
  readonly name: string;
  /** The machine holds no project of its own. */
  readonly empty: boolean;
}) {
  const hereEnvironmentId = usePrimaryEnvironmentId();
  const projects = useProjects();
  const configs = useServerConfigs();
  // An unread list is not an empty one: say nothing until both lists are in.
  const hereLive = useEnvironmentShellLive(hereEnvironmentId);
  const thereLive = useEnvironmentShellLive(props.environmentId);
  const scratchRoot =
    hereEnvironmentId === null ? null : configs.get(hereEnvironmentId)?.scratchWorkspaceRoot;
  const choices = useMemo(
    () => projectsToAdd(projects, hereEnvironmentId, scratchRoot),
    [projects, hereEnvironmentId, scratchRoot],
  );
  const [source, setSource] = useState<EnvironmentProject | null>(null);
  if (hereEnvironmentId === null || hereEnvironmentId === props.environmentId) return null;
  return (
    <>
      {props.empty && hereLive && thereLive ? (
        <AddProjectToMachineView name={props.name} choices={choices} onChoose={setSource} />
      ) : null}
      {source ? (
        <AddToMachineDialog
          open
          onOpenChange={(next) => {
            if (!next) setSource(null);
          }}
          source={source}
          destinationEnvironmentId={props.environmentId}
          onAdded={() => setSource(null)}
        />
      ) : null}
    </>
  );
}

export function AddProjectToMachineView(props: {
  readonly name: string;
  readonly choices: ReadonlyArray<EnvironmentProject>;
  readonly onChoose: (project: EnvironmentProject) => void;
}) {
  const tx = useTx();
  const { name, choices } = props;
  const only = choices.length === 1 ? choices[0] : undefined;
  return (
    <div className="flex min-w-0 flex-col items-start gap-1.5" data-testid="add-project-to-machine">
      <p className="text-xs text-muted-foreground">
        {choices.length === 0
          ? tx(
              "{name} can only run a project it has a copy of. Open a project on this machine first, then add it to {name} here.",
              { name },
            )
          : tx(
              "{name} can only run a project it has a copy of. Add one, then choose {name} under Run on in a chat, or list it under Machines for workers in the project's settings.",
              { name },
            )}
      </p>
      {only ? (
        <Button size="xs" variant="outline" onClick={() => props.onChoose(only)}>
          <FolderPlusIcon aria-hidden className="size-3" />
          {tx("Add {project} to {name}", { project: only.title, name })}
        </Button>
      ) : choices.length > 1 ? (
        <Menu>
          <MenuTrigger render={<Button size="xs" variant="outline" />}>
            <FolderPlusIcon aria-hidden className="size-3" />
            {tx("Add a project to {name}", { name })}
            <ChevronDownIcon aria-hidden className="size-3" />
          </MenuTrigger>
          <MenuPopup align="start" className="max-h-72 min-w-56">
            {choices.map((project) => (
              <MenuItem key={project.id} onClick={() => props.onChoose(project)}>
                <span className="truncate">{project.title}</span>
              </MenuItem>
            ))}
          </MenuPopup>
        </Menu>
      ) : null}
    </div>
  );
}
