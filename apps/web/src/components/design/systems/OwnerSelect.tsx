/** The "Save in" owner picker shared by the new-design-system flows. */
import type { DesignOwnerInput } from "@specweave-studio/contracts";

import { Label } from "../../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../../ui/select";
import {
  offeredProjects,
  ownerFromKey,
  ownerKey,
  ownerUnavailable,
  PLAYGROUND_KEY,
  type OwnerProject,
} from "./reviewModel";

export function OwnerSelect({
  id,
  projects,
  value,
  onChange,
}: {
  id: string;
  projects: readonly OwnerProject[];
  value: DesignOwnerInput;
  onChange: (owner: DesignOwnerInput) => void;
}) {
  const key = ownerKey(value);
  const project = value.kind === "project" ? projects.find((p) => p.id === value.projectId) : null;
  // An archived or automated project is never a choice; one already chosen shows as context.
  const unavailable = ownerUnavailable(value, projects);
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>Save in</Label>
      <Select value={key} onValueChange={(next) => onChange(ownerFromKey(next ?? PLAYGROUND_KEY))}>
        <SelectTrigger id={id} size="sm" data-testid="design-system-owner">
          <SelectValue>
            {unavailable !== null && project ? (
              <UnavailableOwner title={project.title} reason={unavailable} />
            ) : (
              (project?.title ?? "Playground")
            )}
          </SelectValue>
        </SelectTrigger>
        <SelectPopup>
          {unavailable !== null && project ? (
            <SelectItem value={key} disabled data-testid="design-system-owner-unavailable">
              <UnavailableOwner title={project.title} reason={unavailable} />
            </SelectItem>
          ) : null}
          <SelectItem value={PLAYGROUND_KEY}>Playground</SelectItem>
          {offeredProjects(projects).map((candidate) => (
            <SelectItem key={candidate.id} value={`p:${candidate.id}`}>
              {candidate.title}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </div>
  );
}

/** A current owner the picker does not offer: its name and why. */
export function UnavailableOwner({ title, reason }: { title: string; reason: string }) {
  return (
    <span className="flex min-w-0 items-baseline gap-1.5">
      <span className="min-w-0 truncate">{title}</span>
      <span className="shrink-0 whitespace-nowrap text-muted-foreground text-xs">{reason}</span>
    </span>
  );
}
