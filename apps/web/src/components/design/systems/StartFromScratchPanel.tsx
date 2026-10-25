/**
 * "Start from scratch": an empty design system with Light and Dark modes in
 * the chosen owner. Nothing is read from anywhere; its page opens next.
 */
import type { DesignOwnerInput, DesignSystemCreateInput } from "@specweave-studio/contracts";
import { SparklesIcon } from "lucide-react";
import { useId, useState } from "react";

import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { Label } from "../../ui/label";
import { Textarea } from "../../ui/textarea";
import { OwnerSelect } from "./OwnerSelect";
import { ownerUnavailable, type OwnerProject } from "./reviewModel";

export const SCRATCH_MODES = [
  { id: "light", name: "Light" },
  { id: "dark", name: "Dark" },
] as const;

export function StartFromScratchPanel({
  projects,
  defaultOwner,
  onCreate,
}: {
  projects: readonly OwnerProject[];
  defaultOwner: DesignOwnerInput;
  /** Resolves to an error message, or null once the system's page opens. */
  onCreate: (input: DesignSystemCreateInput) => Promise<string | null>;
}) {
  const id = useId();
  const [owner, setOwner] = useState<DesignOwnerInput>(defaultOwner);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const unavailable = ownerUnavailable(owner, projects);

  const create = () => {
    const trimmed = name.trim();
    if (trimmed === "") return setError("A design system needs a name.");
    if (unavailable !== null)
      return setError("Choose where to save it: this project isn't offered for new designs.");
    const about = description.trim();
    setBusy(true);
    setError(null);
    void onCreate({
      owner,
      name: trimmed,
      ...(about === "" ? {} : { description: about }),
      modes: SCRATCH_MODES.map((mode) => ({ ...mode })),
    }).then((failure) => {
      setBusy(false);
      setError(failure);
    });
  };

  return (
    <form
      className="flex flex-col gap-4"
      data-testid="scratch-panel"
      onSubmit={(event) => {
        event.preventDefault();
        create();
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-name`}>Name</Label>
          <Input
            id={`${id}-name`}
            size="sm"
            value={name}
            maxLength={180}
            placeholder="e.g. Acme brand"
            aria-invalid={error !== null && name.trim() === ""}
            onChange={(event) => {
              setName(event.target.value);
              setError(null);
            }}
          />
        </div>
        <OwnerSelect id={`${id}-owner`} projects={projects} value={owner} onChange={setOwner} />
        <div className="flex flex-col gap-1.5 sm:col-span-2">
          <Label htmlFor={`${id}-description`}>Description (optional)</Label>
          <Textarea
            id={`${id}-description`}
            value={description}
            maxLength={4_000}
            className="min-h-20"
            placeholder="What it is for, and where it is used"
            onChange={(event) => setDescription(event.target.value)}
          />
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        It starts empty, with Light and Dark modes. Add colors, type and assets on its page, write
        the brand book, or ask an agent to fill it in.
      </p>
      {error ? (
        <p role="alert" className="text-sm text-destructive-foreground">
          {error}
        </p>
      ) : null}
      <div className="flex justify-end">
        <Button type="submit" disabled={busy || unavailable !== null} data-testid="scratch-create">
          <SparklesIcon aria-hidden />
          {busy ? "Creating…" : "Create design system"}
        </Button>
      </div>
    </form>
  );
}
