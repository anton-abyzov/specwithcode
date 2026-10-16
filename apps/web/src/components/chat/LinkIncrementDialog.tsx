/**
 * "Link increment": bind a thread to a SpecWeave increment by hand, mark it as
 * having none, or go back to automatic binding (ledger writes, checkpoint,
 * title or branch). The link lives in Studio's database, never in the
 * repository. Opened from the plan card and the command palette, rendered once
 * by the chat view, like the link pull request dialog.
 */
import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@specweave-studio/client-runtime/state/runtime";
import type {
  ProjectId,
  ScopedThreadRef,
  ThreadIncrementLinkTarget,
} from "@specweave-studio/contracts";
import { Atom } from "effect/reactivity";
import { CheckIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { useThreadShell } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { projectWorkspace } from "../../studio/projectWorkspace";
import { incrementLinkRevisionAtom } from "../../studio/useThreadIncrementProgress";
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
import { Input } from "../ui/input";

const linkIncrementDialogThreadAtom = Atom.make<ScopedThreadRef | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("plan-progress:link-increment-thread"),
);

export function openLinkIncrementDialog(threadRef: ScopedThreadRef): void {
  appAtomRegistry.set(linkIncrementDialogThreadAtom, threadRef);
}

/** Sets a thread's link; the card's Unlink uses it directly with `{ type: "none" }`. */
export function useSetThreadIncrementLink() {
  const command = useAtomCommand(projectWorkspace.threadIncrementLink);
  return useCallback(
    async (threadRef: ScopedThreadRef, projectId: ProjectId, link: ThreadIncrementLinkTarget) => {
      const result = await command({
        environmentId: threadRef.environmentId,
        input: { projectId, threadId: threadRef.threadId, link },
      });
      if (result._tag === "Failure") {
        const error = squashAtomCommandFailure(result);
        throw error instanceof Error ? error : new Error("Could not change the increment link.");
      }
      appAtomRegistry.set(
        incrementLinkRevisionAtom,
        appAtomRegistry.get(incrementLinkRevisionAtom) + 1,
      );
    },
    [command],
  );
}

/** Mounted once per chat view; shows the picker for whichever thread asked for it. */
export function LinkIncrementDialogHost() {
  const threadRef = useAtomValue(linkIncrementDialogThreadAtom);
  const thread = useThreadShell(threadRef);
  if (threadRef === null || !thread) return null;
  return (
    <LinkIncrementDialog
      threadRef={threadRef}
      projectId={thread.projectId}
      onClose={() => appAtomRegistry.set(linkIncrementDialogThreadAtom, null)}
    />
  );
}

const sameTarget = (left: ThreadIncrementLinkTarget, right: ThreadIncrementLinkTarget) =>
  left.type === right.type &&
  (left.type !== "increment" ||
    (right.type === "increment" && left.incrementId === right.incrementId));

function LinkIncrementDialog({
  threadRef,
  projectId,
  onClose,
}: {
  threadRef: ScopedThreadRef;
  projectId: ProjectId;
  onClose: () => void;
}) {
  const query = useEnvironmentQuery(
    useMemo(
      () =>
        projectWorkspace.incrementsList({
          environmentId: threadRef.environmentId,
          input: { projectId, threadId: threadRef.threadId },
        }),
      [projectId, threadRef.environmentId, threadRef.threadId],
    ),
  );
  const current: ThreadIncrementLinkTarget = query.data?.link ?? { type: "auto" };
  const [filter, setFilter] = useState("");
  const [choice, setChoice] = useState<ThreadIncrementLinkTarget | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const setLink = useSetThreadIncrementLink();
  const selected = choice ?? current;

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, []);

  const increments = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const all = query.data?.increments ?? [];
    return needle === ""
      ? all
      : all.filter((increment) =>
          `${increment.incrementId} ${increment.title ?? ""} ${increment.status}`
            .toLowerCase()
            .includes(needle),
        );
  }, [filter, query.data]);

  const submit = useCallback(async () => {
    setError(null);
    setPending(true);
    try {
      await setLink(threadRef, projectId, selected);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not change the increment link.");
      return;
    } finally {
      setPending(false);
    }
    onClose();
  }, [onClose, projectId, selected, setLink, threadRef]);

  const option = (target: ThreadIncrementLinkTarget, label: string, detail: string | null) => {
    const active = sameTarget(selected, target);
    return (
      <li key={target.type === "increment" ? target.incrementId : target.type}>
        <button
          type="button"
          role="radio"
          aria-checked={active}
          className={cn(
            "flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm",
            active ? "bg-accent text-accent-foreground" : "hover:bg-accent/60",
          )}
          onClick={() => setChoice(target)}
          onDoubleClick={() => {
            setChoice(target);
            void setLink(threadRef, projectId, target).then(onClose, (cause: unknown) =>
              setError(cause instanceof Error ? cause.message : "Could not change the link."),
            );
          }}
        >
          <CheckIcon aria-hidden className={cn("size-4 shrink-0", !active && "invisible")} />
          <span className="min-w-0 flex-1 truncate">{label}</span>
          {detail ? <span className="shrink-0 text-xs text-muted-foreground">{detail}</span> : null}
        </button>
      </li>
    );
  };

  return (
    <Dialog open onOpenChange={(next) => (pending || next ? undefined : onClose())}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Link increment</DialogTitle>
          <DialogDescription>
            Choose the SpecWeave increment this thread's plan card follows. SpecWithCode reads its
            spec and ledger and never writes to them.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <Input
            ref={inputRef}
            placeholder="Filter increments"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              const only = increments.length === 1 ? increments[0] : undefined;
              if (only) setChoice({ type: "increment", incrementId: only.incrementId });
              else void submit();
            }}
          />
          <ul
            role="radiogroup"
            aria-label="Increments"
            className="mt-2 max-h-[45vh] space-y-0.5 overflow-y-auto"
            data-link-increment-options
          >
            {filter.trim() === ""
              ? [
                  option({ type: "auto" }, "Automatic", "ledger writes, title or branch"),
                  option({ type: "none" }, "No increment", "the agent's todo list only"),
                ]
              : null}
            {increments.map((increment) =>
              option(
                { type: "increment", incrementId: increment.incrementId },
                increment.title
                  ? `${increment.incrementId.replace(/^(\d+)-.*/u, "$1")} ${increment.title}`
                  : increment.incrementId,
                increment.status,
              ),
            )}
          </ul>
          {query.data && query.data.increments.length === 0 ? (
            <p className="mt-2 text-xs text-muted-foreground">
              No increments in this thread's checkout (.specweave/increments).
            </p>
          ) : null}
          {(error ?? query.error) ? (
            <p className="mt-2 text-xs text-destructive-foreground">
              {error ?? "Could not list the increments."}
            </p>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => void submit()}
            disabled={pending || sameTarget(selected, current)}
          >
            {pending ? "Saving..." : "Save"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
