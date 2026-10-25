/**
 * "Connect to a project": moves a Playground design into one of the person's
 * projects on this machine. The design keeps its id, history and links; its
 * files move to the project's `.specweave/design` folder. The caller does the
 * move; this dialog only asks where, and whether the design's thread follows.
 */
import type { ProjectId } from "@specweave-studio/contracts";
import { useId, useState } from "react";

import { Button } from "../../ui/button";
import { Checkbox } from "../../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../ui/dialog";
import { Label } from "../../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../../ui/select";
import type { GalleryProject } from "./DesignActions";

export interface ConnectToProjectDialogProps {
  /** The design's title. */
  readonly title: string;
  /** Projects it can move into: the person's own on this machine, most recently active first. */
  readonly projects: readonly GalleryProject[];
  readonly initialProjectId?: ProjectId | null;
  /** The design's thread when it has no project and can move along; null otherwise. */
  readonly thread: { readonly title: string } | null;
  readonly hasDesignSystem: boolean;
  /** Resolves to an error message, or null once the design moved. */
  readonly onMove: (projectId: ProjectId, alsoMoveThread: boolean) => Promise<string | null>;
  readonly onClose: () => void;
}

export function ConnectToProjectDialog({
  title,
  projects,
  initialProjectId = null,
  thread,
  hasDesignSystem,
  onMove,
  onClose,
}: ConnectToProjectDialogProps) {
  const id = useId();
  const [projectId, setProjectId] = useState<ProjectId | null>(() =>
    initialProjectId !== null && projects.some((project) => project.id === initialProjectId)
      ? initialProjectId
      : projects.length === 1
        ? projects[0]!.id
        : null,
  );
  const [moveThread, setMoveThread] = useState(thread !== null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const target = projects.find((project) => project.id === projectId) ?? null;
  const name = title.trim() || "Untitled";

  const submit = () => {
    if (busy || target === null) return;
    setBusy(true);
    setError(null);
    void onMove(target.id, thread !== null && moveThread).then((problem) => {
      setBusy(false);
      if (problem !== null) setError(problem);
    });
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogPopup className="sm:max-w-md" data-testid="connect-design-dialog">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>Connect to a project</DialogTitle>
            <DialogDescription>
              “{name}” moves out of your Playground into the project you choose.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`${id}-project`}>Project</Label>
                {projects.length === 0 ? (
                  <p className="text-sm text-muted-foreground" data-testid="connect-design-empty">
                    No project on this machine can take it. Add a project, then try again.
                  </p>
                ) : (
                  <Select
                    value={projectId}
                    onValueChange={(value) => {
                      setProjectId(value as ProjectId | null);
                      setError(null);
                    }}
                  >
                    <SelectTrigger
                      id={`${id}-project`}
                      size="sm"
                      data-testid="connect-design-project"
                    >
                      <SelectValue>{target?.title ?? "Choose a project"}</SelectValue>
                    </SelectTrigger>
                    <SelectPopup>
                      {projects.map((project) => (
                        <SelectItem key={project.id} value={project.id}>
                          {project.title}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                )}
              </div>
              <ul className="list-disc space-y-1 ps-5 text-xs text-muted-foreground">
                <li>
                  Its files go to the project's .specweave/design folder, so the design travels with
                  the repository.
                </li>
                <li>
                  It keeps its history, versions, comments and sharing. Existing links keep working.
                </li>
                {hasDesignSystem ? (
                  <li>Its design system is copied in too if the project does not have it yet.</li>
                ) : null}
              </ul>
              {thread !== null ? (
                <label className="flex items-start gap-2 text-sm">
                  <Checkbox
                    checked={moveThread}
                    disabled={busy}
                    data-testid="connect-design-thread"
                    onCheckedChange={(checked) => setMoveThread(checked === true)}
                  />
                  <span className="flex flex-col gap-0.5">
                    <span>Also move its thread</span>
                    <span className="text-xs text-muted-foreground">
                      “{thread.title.trim() || "Untitled"}” keeps its conversation and is listed
                      with the project's threads.
                    </span>
                  </span>
                </label>
              ) : null}
              {error ? (
                <p role="alert" className="text-sm text-destructive-foreground">
                  {error}
                </p>
              ) : null}
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={busy || target === null}
              data-testid="connect-design-move"
            >
              {busy ? "Moving…" : error ? "Retry" : "Move"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
