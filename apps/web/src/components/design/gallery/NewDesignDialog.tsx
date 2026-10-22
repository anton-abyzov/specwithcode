import type {
  DesignKind,
  DesignOwnerInput,
  DesignSystemId,
  DesignSystemSummary,
  ProjectId,
} from "@specweave-studio/contracts";
import { useId, useState } from "react";

import { Button } from "../../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../ui/dialog";
import { Input } from "../../ui/input";
import { Label } from "../../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../../ui/select";
import type { GalleryProject } from "./DesignActions";
import { type CopyOutcome, DesignSystemPickerView } from "../systems/DesignSystemPicker";

const PLAYGROUND = "__playground__";

export interface NewDesignRequest {
  readonly kind: DesignKind;
  readonly owner: DesignOwnerInput;
  readonly title: string;
  readonly designSystem: DesignSystemId | null;
}

const COPY = {
  design: {
    title: "New design",
    untitled: "Untitled design",
    create: "Create design",
    where:
      "A Playground design stays on this machine. A project's design is saved in its folder and travels with the repository.",
  },
  slides: {
    title: "New slides",
    untitled: "Untitled slides",
    create: "Create slides",
    where:
      "Slides are 1920 by 1080 and take their colors and fonts from the design system. Playground slides stay on this machine; a project's slides travel with the repository.",
  },
} as const;

/** A blank design or deck in the Playground or a project the user picks. */
export function NewDesignDialog({
  kind = "design",
  open,
  onOpenChange,
  projects,
  systems,
  onCreate,
  onCopySystem = null,
  initialOwner,
  initialSystemId = null,
}: {
  kind?: DesignKind;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projects: readonly GalleryProject[];
  systems: readonly DesignSystemSummary[];
  /** Resolves to an error message, or null once the design exists. */
  onCreate: (request: NewDesignRequest) => Promise<string | null>;
  /** Copies another owner's system into the new design's owner ("Copy into <owner>"). */
  onCopySystem?:
    | ((system: DesignSystemSummary, to: DesignOwnerInput) => Promise<CopyOutcome>)
    | null;
  /** Preselected "Save in"; the Playground when omitted. */
  initialOwner?: DesignOwnerInput;
  /** Preselected design system, for "Use in a new design". */
  initialSystemId?: DesignSystemId | null;
}) {
  const id = useId();
  const [where, setWhere] = useState<string>(
    initialOwner?.kind === "project" ? initialOwner.projectId : PLAYGROUND,
  );
  const [title, setTitle] = useState("");
  const [systemId, setSystemId] = useState<DesignSystemId | null>(initialSystemId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const owner: DesignOwnerInput =
    where === PLAYGROUND
      ? { kind: "playground" }
      : { kind: "project", projectId: where as ProjectId };
  const project = projects.find((candidate) => candidate.id === where) ?? null;
  const copy = COPY[kind];

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogPopup className="sm:max-w-md" data-testid="new-design-dialog" data-kind={kind}>
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            if (busy) return;
            setBusy(true);
            setError(null);
            void onCreate({
              kind,
              owner,
              title: title.trim() || copy.untitled,
              designSystem: systemId,
            }).then((problem) => {
              setBusy(false);
              setError(problem);
            });
          }}
        >
          <DialogHeader>
            <DialogTitle>{copy.title}</DialogTitle>
            <DialogDescription>{copy.where}</DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`${id}-title`}>Title</Label>
                <Input
                  id={`${id}-title`}
                  value={title}
                  maxLength={180}
                  placeholder={copy.untitled}
                  onChange={(event) => setTitle(event.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`${id}-where`}>Save in</Label>
                <Select
                  value={where}
                  onValueChange={(value) => {
                    setWhere(value ?? PLAYGROUND);
                    setSystemId(null);
                  }}
                >
                  <SelectTrigger id={`${id}-where`} size="sm">
                    <SelectValue>{project?.title ?? "Playground"}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    <SelectItem value={PLAYGROUND}>Playground</SelectItem>
                    {projects.map((candidate) => (
                      <SelectItem key={candidate.id} value={candidate.id}>
                        {candidate.title}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`${id}-system`}>Design system</Label>
                <DesignSystemPickerView
                  id={`${id}-system`}
                  owner={owner}
                  systems={systems}
                  projects={projects}
                  value={systemId}
                  onChange={setSystemId}
                  onCopy={onCopySystem === null ? null : (system) => onCopySystem(system, owner)}
                />
              </div>
              {error ? (
                <p role="alert" className="text-destructive-foreground text-sm">
                  {error}
                </p>
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
            <Button type="submit" disabled={busy}>
              {busy ? "Creating…" : copy.create}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
