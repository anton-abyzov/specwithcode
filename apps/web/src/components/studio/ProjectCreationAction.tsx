import { useId } from "react";
import { Button } from "../ui/button";
import type { NewProjectKind } from "../../studio/projectCreation";

/** Stays visible while the project form scrolls, with the next required step. */
export function ProjectCreationAction({
  kind,
  hasName,
  hasFolder,
  canCreate,
  connected,
  busy,
  onCreate,
}: {
  kind: NewProjectKind;
  hasName: boolean;
  hasFolder: boolean;
  canCreate: boolean;
  connected: boolean;
  busy: boolean;
  onCreate: () => void;
}) {
  const hintId = useId();
  const ready = hasName && (kind === "personal" || hasFolder) && canCreate && connected;
  const hint = busy
    ? "Creating your project…"
    : !connected
      ? "Connect the selected machine to continue."
      : !canCreate
        ? "This connection needs permission to create projects."
        : !hasName
          ? "Enter a project name at the top."
          : kind === "code" && !hasFolder
            ? "Choose a project location, then select Use this folder."
            : "Ready to create. Click below, or press Enter in the name field.";
  return (
    <div
      className="shrink-0 border-t border-border px-4 py-3"
      role="region"
      aria-label="Create project"
    >
      <p id={hintId} role="status" className="mb-2 text-sm text-muted-foreground">
        {hint}
      </p>
      <Button
        className="w-full"
        disabled={!ready || busy}
        aria-describedby={hintId}
        onClick={onCreate}
      >
        {busy ? "Creating…" : kind === "personal" ? "Create personal assistant" : "Create project"}
      </Button>
    </div>
  );
}
