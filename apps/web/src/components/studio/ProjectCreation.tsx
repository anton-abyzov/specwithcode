import {
  DEFAULT_PERSONAL_ASSISTANT_NAME,
  PERSONAL_ASSISTANT_LABEL,
} from "@specweave-studio/contracts";
import {
  CheckIcon,
  ConciergeBellIcon,
  FolderGit2Icon,
  FolderPlusIcon,
  ChevronRightIcon,
} from "lucide-react";
import type { CommandPaletteView } from "../CommandPalette.logic";
import { GitHubIcon } from "../Icons";
import { Checkbox } from "../ui/checkbox";
import { newProjectNameNotice, type NewProjectKind } from "../../studio/projectCreation";

export function ProjectCreationPreview({
  kind,
  name,
  path,
  root,
  machine,
}: {
  kind: NewProjectKind;
  name: string;
  path: string | null;
  root: string | null;
  machine: string | null;
}) {
  return (
    <div className="p-2 pb-0">
      <div className="flex min-h-8 items-center gap-2 rounded-sm px-2 py-1.5">
        {kind === "personal" ? (
          <ConciergeBellIcon className="size-4 shrink-0" />
        ) : (
          <FolderGit2Icon className="size-4 shrink-0" />
        )}
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm text-foreground">
            {name || (kind === "personal" ? DEFAULT_PERSONAL_ASSISTANT_NAME : "New project")}
          </span>
          <span className="break-words text-xs text-muted-foreground">
            {kind === "personal"
              ? name
                ? "Private, app-managed storage · No repository created"
                : "Press Enter to keep this name, or type your own"
              : !name
                ? "Type a project name in the field above"
                : root === null
                  ? "Choose a folder below"
                  : `Creates ${path}, or uses the chosen folder if it is already a project`}
            {machine === null ? "" : ` on ${machine}`}
          </span>
          {kind === "code" && newProjectNameNotice(name) ? (
            <span role="note" className="break-words text-xs text-warning-foreground">
              {newProjectNameNotice(name)}
            </span>
          ) : null}
        </span>
      </div>
    </div>
  );
}

export function projectCreationGroups(input: {
  kind: NewProjectKind;
  busy: boolean;
  machines: readonly {
    item: import("../CommandPalette.logic").CommandPaletteActionItem;
    selected: boolean;
  }[];
  github: { description: string; checked: boolean; toggle: () => void } | null;
  addExisting: () => void;
}): CommandPaletteView["groups"] {
  return [
    projectMachineGroup(input.machines, input.busy),
    ...(input.kind === "code" && input.github
      ? [
          {
            value: "new-project-options",
            label: "Options",
            items: [
              {
                kind: "action" as const,
                value: "new-project:github",
                searchTerms: [],
                title: "Create private repository on GitHub",
                description: input.github.description,
                icon: <GitHubIcon className="size-4" />,
                disabled: input.busy,
                titleTrailingContent: (
                  <span className="pointer-events-none ms-auto flex">
                    <Checkbox checked={input.github.checked} tabIndex={-1} aria-hidden />
                  </span>
                ),
                keepOpen: true,
                run: async () => input.github?.toggle(),
              },
            ],
          },
        ]
      : []),
    {
      value: "new-project-existing",
      label: "",
      items: [
        {
          kind: "action",
          value: "new-project:existing",
          searchTerms: [],
          title: "Add existing project",
          description: "Open a folder or clone a repository",
          icon: <FolderPlusIcon className="size-4" />,
          disabled: input.busy,
          titleTrailingContent: (
            <ChevronRightIcon className="ms-auto size-4 text-muted-foreground" />
          ),
          keepOpen: true,
          run: async () => input.addExisting(),
        },
      ],
    },
  ];
}

export function projectMachineGroup(
  machines: readonly {
    item: import("../CommandPalette.logic").CommandPaletteActionItem;
    selected: boolean;
  }[],
  busy = false,
): CommandPaletteView["groups"][number] {
  return {
    value: "new-project-machines",
    label: "Execution machine",
    items: machines.map(({ item, selected }) => ({
      ...item,
      disabled: busy || item.disabled === true,
      ...(selected
        ? { titleTrailingContent: <CheckIcon className="ms-auto size-4 text-muted-foreground" /> }
        : {}),
    })),
  };
}
