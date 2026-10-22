import type { DesignThreadBinding } from "@specweave-studio/contracts";
import { SearchIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { InputGroup, InputGroupAddon, InputGroupInput } from "~/components/ui/input-group";
import { Spinner } from "~/components/ui/spinner";
import { cn } from "~/lib/utils";
import type { DesignCodingThread } from "./backend";

type Target = { kind: "new" } | { kind: "existing"; binding: DesignThreadBinding };

const sameBinding = (a: DesignThreadBinding, b: DesignThreadBinding) =>
  a.environmentId === b.environmentId && a.threadId === b.threadId;

/**
 * Picks the coding thread that receives "Implement this frame": a new thread
 * in the design's project, or one of its existing threads.
 */
export function ImplementFrameDialog({
  open,
  onOpenChange,
  frameName,
  threads,
  canStartNew,
  onSend,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  frameName: string;
  threads: readonly DesignCodingThread[];
  canStartNew: boolean;
  onSend: (target: Target) => Promise<void>;
}) {
  const [target, setTarget] = useState<Target | null>(canStartNew ? { kind: "new" } : null);
  const [query, setQuery] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const shown = useMemo(
    () =>
      threads
        .filter((thread) => thread.title.toLowerCase().includes(query.toLowerCase()))
        .slice(0, 50),
    [threads, query],
  );
  const send = async () => {
    if (target === null) return;
    setSending(true);
    setError(null);
    try {
      await onSend(target);
      onOpenChange(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSending(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-md" data-testid="implement-frame-dialog">
        <DialogHeader>
          <DialogTitle>Implement {frameName}</DialogTitle>
          <DialogDescription>
            Sends the frame as JSON with a PNG, the tokens it uses and the matching design-system
            components to a coding thread.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-2">
            <div role="radiogroup" aria-label="Coding thread" className="flex flex-col gap-1">
              {canStartNew && (
                <Option
                  selected={target?.kind === "new"}
                  onSelect={() => setTarget({ kind: "new" })}
                  title="New coding thread"
                  detail="Starts in this design's project with its worker model"
                />
              )}
              {threads.length > 6 && (
                <InputGroup className="mt-1">
                  <InputGroupAddon>
                    <SearchIcon aria-hidden className="size-3" />
                  </InputGroupAddon>
                  <InputGroupInput
                    size="compact"
                    placeholder="Find a thread"
                    aria-label="Find a thread"
                    value={query}
                    onChange={(event) => setQuery(event.currentTarget.value)}
                  />
                </InputGroup>
              )}
              <div className="flex max-h-64 flex-col gap-1 overflow-y-auto">
                {shown.map((thread) => (
                  <Option
                    key={`${thread.binding.environmentId}:${thread.binding.threadId}`}
                    selected={
                      target?.kind === "existing" && sameBinding(target.binding, thread.binding)
                    }
                    onSelect={() => setTarget({ kind: "existing", binding: thread.binding })}
                    title={thread.title}
                    detail="Existing thread"
                  />
                ))}
              </div>
              {!canStartNew && threads.length === 0 && (
                <p className="text-xs text-muted-foreground">
                  This design has no project, so there is no coding thread to send it to. Copy it to
                  a project first.
                </p>
              )}
            </div>
            {error !== null && <p className="text-xs text-destructive-foreground">{error}</p>}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={target === null || sending} onClick={() => void send()}>
            {sending && <Spinner />}
            Send frame
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function Option({
  selected,
  onSelect,
  title,
  detail,
}: {
  selected: boolean;
  onSelect: () => void;
  title: string;
  detail: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      className={cn(
        "flex flex-col rounded-md border px-3 py-2 text-left hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
        selected ? "border-primary bg-primary/5" : "border-border",
      )}
      onClick={onSelect}
    >
      <span className="truncate text-sm">{title}</span>
      <span className="text-xs text-muted-foreground">{detail}</span>
    </button>
  );
}
