import { CheckIcon, LaptopIcon } from "lucide-react";
import { useRef, useState } from "react";
import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@specweave-studio/client-runtime/state/runtime";
import type { EnvironmentId, ProjectId } from "@specweave-studio/contracts";
import type {
  FolderCopyMatch,
  FolderToAdd,
  MissingRepository,
} from "../../studio/folderLinkSuggestion";
import { sourceControlEnvironment } from "../../state/sourceControl";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Radio, RadioGroup } from "../ui/radio-group";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";

export type CloneState =
  | { readonly phase: "cloning" }
  | { readonly phase: "cloned" }
  | { readonly phase: "failed"; readonly error: string };

const matchKey = (match: FolderCopyMatch) =>
  `${match.candidate.project.environmentId}:${match.candidate.project.id}`;

/** Add folder found a copy of this folder on another machine: link it, or add it alone. */
export function FolderLinkSuggestionDialog({
  open,
  onOpenChange,
  folder,
  matches,
  selected,
  onSelect,
  clones,
  busy,
  error,
  onClone,
  onLink,
  onAddOnly,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly folder: string;
  readonly matches: ReadonlyArray<FolderCopyMatch>;
  readonly selected: string;
  readonly onSelect: (key: string) => void;
  /** By clone destination. */
  readonly clones: Readonly<Record<string, CloneState>>;
  readonly busy: "link" | "add" | null;
  readonly error: string | null;
  readonly onClone: (repository: MissingRepository) => void;
  readonly onLink: (match: FolderCopyMatch) => void;
  readonly onAddOnly: () => void;
}) {
  const match = matches.find((item) => matchKey(item) === selected) ?? matches[0];
  if (!match) return null;
  const linkLabel = (item: FolderCopyMatch) =>
    `Link as a copy of ${item.candidate.project.title} on ${item.machine}`;
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (busy === null) onOpenChange(value);
      }}
    >
      <DialogPopup showCloseButton={busy === null} className="w-full sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {matches.length === 1 ? `${linkLabel(match)}?` : "This folder is a copy of a project"}
          </DialogTitle>
          <DialogDescription className="wrap-anywhere">
            {`${folder} matches a project on another machine. Linking makes them one shared project; you choose which coordinator stays next.`}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-4">
            {matches.length === 1 ? (
              <p className="text-sm text-muted-foreground" data-slot="folder-link-summary">
                {match.candidate.summary}
              </p>
            ) : (
              <RadioGroup
                value={matchKey(match)}
                onValueChange={(value) => onSelect(String(value))}
                disabled={busy !== null}
                aria-label="Copy of"
              >
                {matches.map((item) => (
                  <label
                    key={matchKey(item)}
                    data-slot="folder-link-match"
                    className={`grid min-w-0 grid-cols-[1.125rem_1rem_minmax(0,1fr)] items-start gap-x-3 rounded-lg border p-3 transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring has-[:focus-visible]:ring-offset-2 has-[:focus-visible]:ring-offset-background ${
                      matchKey(item) === matchKey(match)
                        ? "border-primary bg-accent/40"
                        : "border-border"
                    } ${busy !== null ? "cursor-default" : "cursor-pointer hover:bg-accent/40"}`}
                  >
                    <span className="flex h-5 items-center justify-center">
                      <Radio value={matchKey(item)} />
                    </span>
                    <span className="flex h-5 items-center justify-center">
                      <LaptopIcon className="size-4 shrink-0" aria-hidden />
                    </span>
                    <span className="min-w-0 text-sm leading-5">
                      <span className="block wrap-anywhere font-medium">{linkLabel(item)}</span>
                      <span className="block text-xs text-muted-foreground">
                        {item.candidate.summary}
                      </span>
                    </span>
                  </label>
                ))}
              </RadioGroup>
            )}
            {match.missing.length > 0 && (
              <section className="space-y-2" aria-label="Missing here">
                <h3 className="text-sm font-medium">
                  {`Not in this folder (${match.missing.length})`}
                </h3>
                <ul className="space-y-1">
                  {match.missing.map((repository) => (
                    <MissingRepositoryRow
                      key={repository.path}
                      repository={repository}
                      state={clones[repository.destination]}
                      disabled={busy !== null}
                      onClone={() => onClone(repository)}
                    />
                  ))}
                </ul>
              </section>
            )}
            {error && (
              <p role="alert" className="wrap-anywhere text-sm text-destructive-foreground">
                {error}
              </p>
            )}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" disabled={busy !== null} onClick={onAddOnly}>
            {busy === "add" ? "Adding" : "Add without linking"}
          </Button>
          <Button disabled={busy !== null} onClick={() => onLink(match)}>
            {busy === "link" ? "Adding" : "Link"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function MissingRepositoryRow({
  repository,
  state,
  disabled,
  onClone,
}: {
  readonly repository: MissingRepository;
  readonly state: CloneState | undefined;
  readonly disabled: boolean;
  readonly onClone: () => void;
}) {
  return (
    <li
      className="flex min-w-0 items-center gap-3 rounded-md border px-3 py-2"
      data-slot="folder-link-missing"
    >
      <span className="min-w-0 flex-1 text-sm leading-5">
        <span className="block break-all font-medium">{repository.path}</span>
        <span className="block break-all text-xs text-muted-foreground">
          {state?.phase === "failed"
            ? state.error
            : (repository.originKey ?? "No origin to clone from")}
        </span>
      </span>
      {state?.phase === "cloned" ? (
        <span className="flex shrink-0 items-center gap-1 text-xs" role="status">
          <CheckIcon className="size-4" aria-hidden />
          Cloned
        </span>
      ) : repository.clone ? (
        <Button
          size="sm"
          variant="outline"
          className="shrink-0"
          disabled={disabled || state?.phase === "cloning"}
          onClick={onClone}
        >
          {state?.phase === "cloning" ? "Cloning" : "Clone from origin"}
        </Button>
      ) : null}
    </li>
  );
}

export interface FolderLinkSuggestionRequest {
  readonly folder: FolderToAdd;
  readonly matches: ReadonlyArray<FolderCopyMatch>;
  /** Adds the folder as a project and opens it; null when that failed (already reported). */
  readonly addProject: () => Promise<EnvironmentProject | null>;
}

export interface LinkTarget {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}

function errorText(error: unknown): string {
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "An error occurred.";
}

/**
 * Shows the suggestion for one added folder. "Link" adds the project (once) and
 * hands it to `onLink` with the chosen copy; "Add without linking" only adds it.
 */
export function FolderLinkSuggestion({
  request,
  onClose,
  onLink,
}: {
  readonly request: FolderLinkSuggestionRequest | null;
  readonly onClose: () => void;
  readonly onLink: (project: EnvironmentProject, candidate: LinkTarget) => void;
}) {
  if (!request) return null;
  return (
    <FolderLinkSuggestionFlow
      key={`${request.folder.environmentId}:${request.folder.workspaceRoot}`}
      request={request}
      onClose={onClose}
      onLink={onLink}
    />
  );
}

function FolderLinkSuggestionFlow({
  request,
  onClose,
  onLink,
}: {
  readonly request: FolderLinkSuggestionRequest;
  readonly onClose: () => void;
  readonly onLink: (project: EnvironmentProject, candidate: LinkTarget) => void;
}) {
  const cloneRepository = useAtomCommand(sourceControlEnvironment.cloneRepository, {
    reportFailure: false,
  });
  const [selected, setSelected] = useState(() =>
    request.matches[0] ? matchKey(request.matches[0]) : "",
  );
  const [clones, setClones] = useState<Record<string, CloneState>>({});
  const [busy, setBusy] = useState<"link" | "add" | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A failed link after a successful add must not add the folder twice.
  const added = useRef<EnvironmentProject | null>(null);

  const add = async (intent: "link" | "add") => {
    if (busy !== null) return null;
    setBusy(intent);
    setError(null);
    const project = added.current ?? (await request.addProject().catch(() => null));
    added.current = project;
    setBusy(null);
    if (!project) setError("The folder could not be added. Check the notification and try again.");
    return project;
  };

  const clone = async (repository: MissingRepository) => {
    if (!repository.clone) return;
    setClones((current) => ({ ...current, [repository.destination]: { phase: "cloning" } }));
    const result = await cloneRepository({
      environmentId: request.folder.environmentId,
      input: { ...repository.clone, destinationPath: repository.destination },
    });
    const next: CloneState =
      result._tag === "Success"
        ? { phase: "cloned" }
        : {
            phase: "failed",
            error: isAtomCommandInterrupted(result)
              ? "The clone stopped. Try again."
              : errorText(squashAtomCommandFailure(result)),
          };
    setClones((current) => ({ ...current, [repository.destination]: next }));
  };

  return (
    <FolderLinkSuggestionDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      folder={request.folder.workspaceRoot}
      matches={request.matches}
      selected={selected}
      onSelect={setSelected}
      clones={clones}
      busy={busy}
      error={error}
      onClone={(repository) => void clone(repository)}
      onAddOnly={() => {
        void add("add").then((project) => {
          if (project) onClose();
        });
      }}
      onLink={(match) => {
        void add("link").then((project) => {
          if (!project) return;
          onClose();
          onLink(project, {
            environmentId: match.candidate.project.environmentId,
            projectId: match.candidate.project.id,
          });
        });
      }}
    />
  );
}
