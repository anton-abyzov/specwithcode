import {
  DEFAULT_PERSONAL_ASSISTANT_NAME,
  PERSONAL_ASSISTANT_LABEL,
} from "@specweave-studio/contracts";
import { CheckIcon, ConciergeBellIcon, FolderGit2Icon, ListChecksIcon } from "lucide-react";
import type { ReactNode } from "react";
import type { CommandPaletteView } from "../CommandPalette.logic";
import { cn } from "../../lib/utils";
import { GitHubIcon } from "../Icons";
import { Checkbox } from "../ui/checkbox";
import { newProjectNameNotice, type NewProjectKind } from "../../studio/projectCreation";

/** What "Use SpecWeave" adds, said wherever the person can turn it on. */
export const SPECWEAVE_SETUP_DESCRIPTION =
  "Runs specweave init: adds .specweave/, agent skills, .claude/settings.json, .gitignore and .gitattributes rules and a README if there is none, and adds SpecWeave sections to AGENTS.md and CLAUDE.md, for specs, tasks and handoffs";

/** What "Use SpecWeave" gives, in one sentence; the file list sits behind a disclosure. */
export const SPECWEAVE_SETUP_SUMMARY =
  "Plans each piece of work as a spec with tasks, so threads link to a plan and you can track progress";

/** What a project without SpecWeave goes without, checked against the features gated on it. */
export const SPECWEAVE_OFF_DESCRIPTION =
  "Without it, threads keep SpecWithCode's own plan and memory, but there are no increments to link threads to, no spec and acceptance-criteria plan card, no SpecWeave pickup and no saved reports. You can turn it on later in Project settings > General.";

export function SpecweaveSetupDetails() {
  return (
    <details className="mx-4 mb-2 text-xs text-muted-foreground">
      <summary className="cursor-pointer select-none py-1">What Use SpecWeave adds</summary>
      <p className="mt-1 break-words">{SPECWEAVE_SETUP_DESCRIPTION}.</p>
      <p className="mt-1 break-words">{SPECWEAVE_OFF_DESCRIPTION}</p>
    </details>
  );
}

/** For code that already exists: a way out of New project, below the form's own steps. */
export function AddExistingProjectLink({ busy, onClick }: { busy: boolean; onClick: () => void }) {
  return (
    <p className="mx-4 mb-3 text-xs text-muted-foreground">
      Already have the code?{" "}
      <button
        type="button"
        disabled={busy}
        onClick={onClick}
        className="font-medium text-foreground underline underline-offset-2 disabled:opacity-50"
      >
        Add existing project
      </button>{" "}
      opens a folder or clones a repository.
    </p>
  );
}

export interface ProjectMachineOption {
  readonly environmentId: string;
  readonly label: string;
  readonly isPrimary: boolean;
  readonly isConnected: boolean;
  readonly icon: ReactNode;
}

/**
 * The machine the new project lives on, at the top of the form so every later
 * step (location, browse, create) reads against it. Another machine is one tap away.
 */
export function ProjectMachineChoice({
  machines,
  selectedId,
  busy,
  onSelect,
}: {
  machines: readonly ProjectMachineOption[];
  selectedId: string;
  busy: boolean;
  onSelect: (environmentId: string) => void;
}) {
  return (
    <section aria-label="Machine" className="mx-4 mt-2">
      <p className="text-sm font-medium">Machine</p>
      <p className="text-xs text-muted-foreground">
        Where the project&apos;s files live and its threads run
      </p>
      <div role="radiogroup" aria-label="Machine" className="mt-1.5 flex flex-wrap gap-1.5">
        {machines.map((machine) => {
          const selected = machine.environmentId === selectedId;
          return (
            <button
              key={machine.environmentId}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={busy || !machine.isConnected}
              onClick={() => onSelect(machine.environmentId)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50",
                selected
                  ? "border-primary bg-primary/10 text-foreground"
                  : "border-border text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
            >
              {machine.icon}
              <span>{machine.label}</span>
              {machine.isPrimary ? (
                <span className="text-xs text-muted-foreground">· This device</span>
              ) : null}
              {selected ? <CheckIcon className="size-3.5" aria-hidden /> : null}
            </button>
          );
        })}
      </div>
    </section>
  );
}

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
  github: { description: string; checked: boolean; toggle: () => void } | null;
  /** "Use SpecWeave": on by default; the person can untick it to add nothing to the repository. */
  specweave: { checked: boolean; toggle: () => void } | null;
}): CommandPaletteView["groups"] {
  const github = input.kind === "code" ? input.github : null;
  const specweave = input.kind === "code" ? input.specweave : null;
  return github || specweave
    ? [
        {
          value: "new-project-options",
          label: "Options",
          items: [
            ...(github
              ? [
                  {
                    kind: "action" as const,
                    value: "new-project:github",
                    searchTerms: [],
                    title: "Create private repository on GitHub",
                    description: github.description,
                    icon: <GitHubIcon className="size-4" />,
                    disabled: input.busy,
                    titleTrailingContent: (
                      <span className="pointer-events-none ms-auto flex">
                        <Checkbox checked={github.checked} tabIndex={-1} aria-hidden />
                      </span>
                    ),
                    keepOpen: true,
                    run: async () => github.toggle(),
                  },
                ]
              : []),
            ...(specweave
              ? [
                  {
                    kind: "action" as const,
                    value: "new-project:specweave",
                    searchTerms: [],
                    title: "Use SpecWeave",
                    description: SPECWEAVE_SETUP_SUMMARY,
                    icon: <ListChecksIcon className="size-4" />,
                    disabled: input.busy,
                    titleTrailingContent: (
                      <span className="pointer-events-none ms-auto flex">
                        <Checkbox checked={specweave.checked} tabIndex={-1} aria-hidden />
                      </span>
                    ),
                    keepOpen: true,
                    run: async () => specweave.toggle(),
                  },
                ]
              : []),
          ],
        },
      ]
    : [];
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
