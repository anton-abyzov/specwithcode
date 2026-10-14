import type { ReactNode } from "react";
import { Button } from "../ui/button";

export function CloneProjectDestination({
  machine,
  path,
  picker,
  busy,
  allowed,
  onClone,
}: {
  machine: string;
  path: string | null;
  picker: ReactNode;
  busy: boolean;
  allowed: boolean;
  onClone: () => void;
}) {
  return (
    <section aria-label="Clone destination">
      <p className="px-4 pt-2 text-sm">Clone on {machine}</p>
      {picker}
      <div className="space-y-2 px-4 pb-4">
        <p className="break-all text-xs text-muted-foreground">
          {path ? `Clone into ${path}` : "Choose where to clone this repository."}
        </p>
        {!allowed && (
          <p role="alert" className="text-xs text-destructive">
            This machine must be connected with permission to clone and add projects.
          </p>
        )}
        <Button disabled={!path || busy || !allowed} onClick={onClone}>
          {busy ? "Cloning…" : "Clone repository"}
        </Button>
      </div>
    </section>
  );
}
