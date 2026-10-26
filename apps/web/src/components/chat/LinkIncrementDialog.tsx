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

const PAGE = 50;
/** The server answers at most this many per request; past it, search narrows the list. */
const MOST_LISTED = 300;

/** The list request for what the reader typed, the status chip and how many pages they opened. */
export function incrementListInput(filter: string, status: string | null, pages: number) {
  const query = filter.trim();
  return {
    ...(query === "" ? {} : { query }),
    ...(status === null ? {} : { status }),
    limit: Math.min(MOST_LISTED, PAGE * Math.max(1, pages)),
  };
}

/** Status chips, busiest first, with "all" in front. */
export function statusChips(counts: Readonly<Record<string, number>> | undefined) {
  return Object.entries(counts ?? {}).toSorted(
    ([leftStatus, left], [rightStatus, right]) =>
      right - left || leftStatus.localeCompare(rightStatus),
  );
}

const sameTarget = (left: ThreadIncrementLinkTarget, right: ThreadIncrementLinkTarget) =>
  left.type === right.type &&
  (left.type !== "increment" ||
    (right.type === "increment" && left.incrementId === right.incrementId));

export function LinkIncrementDialog({
  threadRef,
  projectId,
  onClose,
}: {
  threadRef: ScopedThreadRef;
  projectId: ProjectId;
  onClose: () => void;
}) {
  const [filter, setFilter] = useState("");
  const [searched, setSearched] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [pages, setPages] = useState(1);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setSearched(filter);
      setPages(1);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [filter]);
  const query = useEnvironmentQuery(
    useMemo(
      () =>
        projectWorkspace.incrementsList({
          environmentId: threadRef.environmentId,
          input: {
            projectId,
            threadId: threadRef.threadId,
            ...incrementListInput(searched, status, pages),
          },
        }),
      [pages, projectId, searched, status, threadRef.environmentId, threadRef.threadId],
    ),
  );
  // A new search or page starts a fresh query; keep the last reply on screen
  // until it lands, so the list does not blank and the link is never guessed.
  const [data, setData] = useState(query.data);
  if (query.data && query.data !== data) setData(query.data);
  const current: ThreadIncrementLinkTarget | null = data ? (data.link ?? { type: "auto" }) : null;
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

  const increments = data?.increments ?? [];
  const total = data?.total ?? increments.length;
  const chips = statusChips(data?.statusCounts);

  const submit = useCallback(async () => {
    if (!selected) return;
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
    const active = selected !== null && sameTarget(selected, target);
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
            placeholder="Search increments by number or title"
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
          {chips.length > 1 || status !== null ? (
            <div
              className="mt-2 flex flex-wrap gap-1"
              role="group"
              aria-label="Status"
              data-link-increment-status
            >
              {[["all", null] as const, ...chips.map(([name]) => [name, name] as const)].map(
                ([label, value]) => (
                  <button
                    key={label}
                    type="button"
                    aria-pressed={status === value}
                    className={cn(
                      "rounded-full border px-2 py-0.5 text-xs",
                      status === value
                        ? "border-foreground/40 bg-accent text-accent-foreground"
                        : "border-border/70 text-muted-foreground hover:text-foreground",
                    )}
                    onClick={() => {
                      setStatus(value);
                      setPages(1);
                    }}
                  >
                    {label}
                    {value === null ? null : (
                      <span className="ms-1 tabular-nums">{data?.statusCounts?.[value]}</span>
                    )}
                  </button>
                ),
              )}
            </div>
          ) : null}
          <ul
            role="radiogroup"
            aria-label="Increments"
            className="mt-2 max-h-[45vh] space-y-0.5 overflow-y-auto"
            data-link-increment-options
          >
            {filter.trim() === "" && status === null
              ? [
                  option({ type: "auto" }, "Automatic", "ledger writes, title or branch"),
                  option({ type: "none" }, "No increment", "the agent's checklist only"),
                ]
              : null}
            {increments.map((increment) =>
              option(
                { type: "increment", incrementId: increment.incrementId },
                increment.title
                  ? `${increment.incrementId.replace(/^(\d+[A-Za-z]?)-.*/u, "$1")} ${increment.title}`
                  : increment.incrementId,
                increment.status,
              ),
            )}
          </ul>
          {data && total > increments.length ? (
            <p
              className="mt-2 flex items-center gap-2 text-xs text-muted-foreground"
              data-link-increment-more
            >
              Showing {increments.length} of {total}.
              {increments.length < MOST_LISTED ? (
                <button
                  type="button"
                  className="underline underline-offset-2 hover:text-foreground"
                  onClick={() => setPages((count) => count + 1)}
                >
                  Load more
                </button>
              ) : (
                <span>Search to narrow the list.</span>
              )}
            </p>
          ) : null}
          {data && total === 0 ? (
            <p className="mt-2 text-xs text-muted-foreground">
              {searched.trim() !== "" || status !== null
                ? "No increment matches."
                : "No increments in this thread's checkout (.specweave/increments)."}
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
            disabled={pending || !selected || !current || sameTarget(selected, current)}
          >
            {pending ? "Saving..." : "Save"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
