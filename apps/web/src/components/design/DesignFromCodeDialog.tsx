import type {
  DesignOwnerInput,
  DesignSystemId,
  DesignSystemSummary,
  ProjectId,
} from "@specweave-studio/contracts";
import { useId, useState } from "react";

import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import type { GalleryProject } from "./gallery/DesignActions";
import { SystemSelect, systemsOwnedBy } from "./gallery/SystemSelect";
import { type CopyOutcome, DesignSystemPickerView } from "./systems/DesignSystemPicker";

export interface DesignFromCodeRequest {
  readonly projectId: ProjectId;
  readonly designSystem: DesignSystemId | null;
  readonly brief: string;
}

/**
 * Starts a design that an agent builds against a project's real code: it
 * asks for the project and an optional design system, then the page creates
 * the design in that project and starts a thread there bound to it.
 */
export function DesignFromCodeDialog({
  open,
  onOpenChange,
  projects,
  systems,
  initialProjectId = null,
  workerLabelFor,
  onStart,
  onOpenCreated = null,
  onCopySystem = null,
  connected = true,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projects: readonly GalleryProject[];
  systems: readonly DesignSystemSummary[];
  initialProjectId?: ProjectId | null;
  /** The model the project's new threads start on, or null when no provider is ready. */
  workerLabelFor: (projectId: ProjectId) => string | null;
  /** Resolves to an error message, or null once the thread has started. */
  onStart: (request: DesignFromCodeRequest) => Promise<string | null>;
  /** Opens the design an earlier attempt created, when its thread did not start. */
  onOpenCreated?: (() => void) | null;
  /** Copies another owner's system into the project ("Copy into <owner>"). */
  onCopySystem?:
    | ((system: DesignSystemSummary, to: DesignOwnerInput) => Promise<CopyOutcome>)
    | null;
  /**
   * Whether this machine's connection is up. The dialog can open from cached
   * state before it is, and a start then would be refused unsent.
   */
  connected?: boolean;
}) {
  const id = useId();
  const [projectId, setProjectId] = useState<ProjectId | null>(
    initialProjectId ?? (projects.length === 1 ? projects[0]!.id : null),
  );
  const [systemId, setSystemId] = useState<DesignSystemId | null>(null);
  const [brief, setBrief] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const project = projects.find((candidate) => candidate.id === projectId) ?? null;
  const ownerSystems = systemsOwnedBy(
    systems,
    projectId === null ? null : { kind: "project", projectId },
  );
  const worker = projectId === null ? null : workerLabelFor(projectId);
  const ready = project !== null && worker !== null && connected && !busy;

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogPopup className="sm:max-w-lg" data-testid="design-from-code-dialog">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            if (!ready || projectId === null) return;
            setBusy(true);
            setError(null);
            void onStart({ projectId, designSystem: systemId, brief: brief.trim() }).then(
              (problem) => {
                setBusy(false);
                setError(problem);
              },
            );
          }}
        >
          <DialogHeader>
            <DialogTitle>Design from code</DialogTitle>
            <DialogDescription>
              An agent reads the project's code and designs on a new canvas in that project. You can
              watch, comment and edit while it works.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`${id}-project`}>Project</Label>
                {projects.length === 0 ? (
                  <p className="text-muted-foreground text-sm">
                    Add a project first. The design is saved in its folder.
                  </p>
                ) : (
                  <Select
                    value={projectId}
                    onValueChange={(value) => {
                      setProjectId(value as ProjectId | null);
                      setSystemId(null);
                      setError(null);
                    }}
                  >
                    <SelectTrigger
                      id={`${id}-project`}
                      size="sm"
                      data-testid="design-from-code-project"
                    >
                      <SelectValue>{project?.title ?? "Choose a project"}</SelectValue>
                    </SelectTrigger>
                    <SelectPopup>
                      {projects.map((candidate) => (
                        <SelectItem key={candidate.id} value={candidate.id}>
                          {candidate.title}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                )}
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`${id}-system`}>Design system</Label>
                {projectId === null ? (
                  <SystemSelect
                    id={`${id}-system`}
                    systems={ownerSystems}
                    value={systemId}
                    onChange={setSystemId}
                  />
                ) : (
                  <DesignSystemPickerView
                    id={`${id}-system`}
                    owner={{ kind: "project", projectId }}
                    systems={systems}
                    projects={projects}
                    value={systemId}
                    onChange={setSystemId}
                    onCopy={
                      onCopySystem === null
                        ? null
                        : (system) => onCopySystem(system, { kind: "project", projectId })
                    }
                  />
                )}
                <p className="text-muted-foreground text-xs">
                  {projectId !== null && ownerSystems.length === 0
                    ? "This project has no design system yet. The agent matches the styles it finds in the code."
                    : "The agent uses its tokens and components."}
                </p>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`${id}-brief`}>What should this design show?</Label>
                <Textarea
                  id={`${id}-brief`}
                  rows={4}
                  maxLength={4000}
                  value={brief}
                  placeholder="A settings page for notifications, in the style of the existing app"
                  onChange={(event) => setBrief(event.target.value)}
                />
              </div>
              {project !== null ? (
                <p className="text-muted-foreground text-xs" data-testid="design-from-code-worker">
                  {worker === null
                    ? "No provider is ready on this machine. Sign in to one in Settings > Providers."
                    : `Starts a thread in ${project.title} on ${worker}.`}
                </p>
              ) : null}
              {connected ? null : (
                <p
                  role="status"
                  className="text-muted-foreground text-xs"
                  data-testid="design-from-code-connecting"
                >
                  Connecting to this machine. Start design turns on once it is connected.
                </p>
              )}
              {error ? (
                <div className="flex items-start justify-between gap-3">
                  <p role="alert" className="text-destructive-foreground text-sm">
                    {error}
                  </p>
                  {onOpenCreated ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="shrink-0"
                      disabled={busy}
                      onClick={onOpenCreated}
                      data-testid="design-from-code-open"
                    >
                      Open design
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!ready} data-testid="design-from-code-start">
              {busy ? "Starting…" : "Start design"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
