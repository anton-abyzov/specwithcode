import { scopeProjectRef } from "@specweave-studio/client-runtime/environment";
import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";
import type {
  EnvironmentId,
  FolderCopyChoice,
  FolderCopyOffer,
  FolderCopySourceSummary,
  FolderCopyStatus,
  FolderCopyUndoResult,
  ProjectId,
} from "@specweave-studio/contracts";
import { useEffect, useRef, useState } from "react";

import { randomUUID } from "~/lib/utils";
import { waitForProject } from "~/state/entities";
import {
  applyCopy,
  cancelCopy,
  copyApplied,
  type CopyCommands,
  isAbort,
  messageOf,
  pollCopy,
  unwrap,
  useLinkCommands,
  withoutDivergedTakeTheirs,
} from "~/studio/addToMachineCopy";
import { formatBytes } from "~/studio/folderCopy";
import { linkCopyAsWorkers } from "~/studio/projectLink";
import { CopyPlanPreview, CopyProgress, CopyUndoPreview } from "../studio/HandoffCopyPreview";
import { ProjectLinkDialog } from "../studio/ProjectLinkDialog";
import { Button } from "../ui/button";
import {
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogTitle,
} from "../ui/dialog";

type Link =
  | { readonly status: "linking" | "linked" }
  | { readonly status: "review"; readonly reason: string };

/**
 * AC-06: the destination already has a checkout of this repository. The copy brings
 * the source's work into it (fast-forward when behind, theirs kept aside when
 * diverged, conflicts decided here), then links it as a worker copy. Undoable.
 */
export function AddToMachineConsolidate(props: {
  readonly source: EnvironmentProject;
  readonly sourceName: string;
  readonly destinationEnvironmentId: EnvironmentId;
  readonly destName: string;
  readonly offer: FolderCopyOffer;
  readonly summary: FolderCopySourceSummary;
  readonly initialStatus: FolderCopyStatus;
  readonly secrets: ReadonlyArray<string>;
  readonly commands: CopyCommands;
  readonly onBusyChange: (busy: boolean) => void;
  readonly onApplied: () => void;
  readonly onLinked: (projectId: ProjectId) => void;
  readonly onUndone: () => void;
  readonly onCancelled: () => void;
  readonly onClose: () => void;
}) {
  const { source, destinationEnvironmentId: destination, destName, sourceName, commands } = props;
  const operationId = props.offer.operationId;
  const linkCommands = useLinkCommands();
  const [copy, setCopy] = useState(props.initialStatus);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<Link | null>(null);
  const [undoPreview, setUndoPreview] = useState<FolderCopyUndoResult | null>(null);
  const [linkDialog, setLinkDialog] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const { onBusyChange } = props;

  useEffect(() => {
    const controller = new AbortController();
    abortRef.current = controller;
    return () => controller.abort();
  }, []);
  useEffect(() => onBusyChange(busy), [busy, onBusyChange]);

  const secrets = props.secrets.filter((path) =>
    props.summary.secretFiles.some((file) => file.path === path),
  );

  const run = async (work: (signal: AbortSignal | undefined) => Promise<void>) => {
    setBusy(true);
    setError(null);
    const signal = abortRef.current?.signal;
    try {
      await work(signal);
    } catch (cause) {
      if (!isAbort(cause) && !signal?.aborted) setError(messageOf(cause));
    } finally {
      if (!signal?.aborted) setBusy(false);
    }
  };

  const decide = (input: {
    readonly decisions?: Readonly<Record<string, FolderCopyChoice>>;
    readonly clone?: ReadonlyArray<string>;
  }) =>
    run(async (signal) => {
      unwrap(
        await commands.decide({ environmentId: destination, input: { operationId, ...input } }),
      );
      setCopy(await pollCopy(commands, destination, operationId, signal ? { signal } : {}));
    });

  const linkCopy = async (projectId: ProjectId) => {
    setLink({ status: "linking" });
    const outcome = await linkCopyAsWorkers(linkCommands, {
      kept: { environmentId: source.environmentId, projectId: source.id },
      joining: { environmentId: destination, projectId },
      keptLabel: sourceName,
      joiningLabel: destName,
      newOperationId: randomUUID,
    }).catch((cause: unknown) => ({
      status: "review" as const,
      reason: messageOf(cause, "Linking stopped."),
    }));
    if (outcome.status === "linked")
      // The menu selects the project next, so it must be in the store first.
      await waitForProject(scopeProjectRef(destination, projectId), 10_000).catch(() => null);
    setLink(outcome);
    if (outcome.status === "linked") props.onLinked(projectId);
  };

  const apply = () =>
    run(async (signal) => {
      const next = await applyCopy(commands, {
        sourceEnvironmentId: source.environmentId,
        destinationEnvironmentId: destination,
        destinationLabel: destName,
        operationId,
        secrets,
        onStatus: setCopy,
        ...(signal ? { signal } : {}),
      });
      setCopy(next);
      if (next.state === "applied") props.onApplied();
      if (copyApplied(next) && next.projectId) await linkCopy(next.projectId);
    });

  const stop = () =>
    run(async () => {
      await cancelCopy(commands, {
        sourceEnvironmentId: source.environmentId,
        destinationEnvironmentId: destination,
        operationId,
        reason: "The copy was cancelled before Apply.",
      });
      props.onCancelled();
    });

  const undoCopy = (force: boolean, previewOnly: boolean) =>
    run(async () => {
      const result = unwrap(
        await commands.undo({
          environmentId: destination,
          input: { operationId, preview: previewOnly, force },
        }),
      );
      setCopy(result.status);
      if (previewOnly) {
        setUndoPreview(result);
        return;
      }
      setUndoPreview(null);
      if (!result.undone) throw new Error(result.problems.join(" ") || "Undo did not finish.");
      props.onUndone();
    });

  const preview = withoutDivergedTakeTheirs(copy);
  const applied = copyApplied(copy);
  const failed = copy.state === "failed" || copy.state === "cancelled";
  const reviewing = copy.state === "previewed";

  return (
    <>
      <DialogHeader>
        <DialogTitle>Link and consolidate on {destName}</DialogTitle>
        <DialogDescription>
          {copy.targetFolder} on {destName} already has this repository. Review what comes over from{" "}
          {sourceName}; nothing there is overwritten without your choice.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <div className="space-y-4" data-slot="add-consolidate-review" data-state={copy.state}>
          {reviewing && (
            <>
              <CopyPlanPreview
                status={preview}
                disabled={busy}
                onDecide={(decisions) => void decide({ decisions })}
                onClone={(rowId, on) =>
                  void decide({
                    clone: on
                      ? [...copy.rows.filter((row) => row.clone).map((row) => row.id), rowId]
                      : copy.rows
                          .filter((row) => row.clone && row.id !== rowId)
                          .map((row) => row.id),
                  })
                }
              />
              {copy.disk && (
                <p role="alert" className="text-sm text-destructive-foreground">
                  {destName} needs {formatBytes(copy.disk.needed)} free for this copy and has{" "}
                  {formatBytes(copy.disk.free)}.
                </p>
              )}
              {secrets.length > 0 && (
                <p className="wrap-anywhere text-muted-foreground text-xs">
                  Secret files to send: {secrets.join(", ")}
                </p>
              )}
            </>
          )}

          {!reviewing && !applied && !failed && copy.state !== "undone" && (
            <CopyProgress status={copy} />
          )}

          {failed && (
            <p role="alert" className="wrap-anywhere text-sm text-destructive-foreground">
              {copy.error?.message ?? "The copy stopped."}
              {copy.failedStep !== "applying" && copy.failedStep !== "applied"
                ? ` Nothing in ${copy.targetFolder} changed.`
                : ""}
            </p>
          )}

          {applied && (
            <div className="space-y-3 text-sm" data-slot="add-consolidate-done">
              <p
                className="wrap-anywhere"
                role={link?.status === "review" ? "alert" : "status"}
                data-slot="copy-link"
              >
                {link?.status === "linking"
                  ? `Linking the copy on ${destName} so it runs workers for ${sourceName}…`
                  : link?.status === "linked"
                    ? `Linked: ${copy.targetFolder} on ${destName} runs workers; the coordinator on ${sourceName} sends it work.`
                    : link?.status === "review"
                      ? `The files are in place. Not linked yet. ${link.reason}`
                      : `The files are in ${copy.targetFolder} on ${destName}.`}
              </p>
              {copy.checks.some((check) => !check.ok) && (
                <ul className="space-y-1 text-xs">
                  {copy.checks
                    .filter((check) => !check.ok)
                    .map((check) => (
                      <li key={check.repo} className="wrap-anywhere">
                        {check.repo}: {check.problems.join(" ")}
                      </li>
                    ))}
                </ul>
              )}
              {copy.secrets && copy.secrets.length > 0 && (
                <ul className="space-y-1 text-xs" aria-label="Secret files sent">
                  {copy.secrets.map((secret) => (
                    <li key={secret.path} className="wrap-anywhere">
                      <span className="font-mono">{secret.writtenAs}</span>
                      {secret.state === "beside"
                        ? ` was written beside ${secret.path}, which differs on ${destName}.`
                        : secret.state === "unchanged"
                          ? " was already the same."
                          : " is in place, readable only by you."}
                    </li>
                  ))}
                </ul>
              )}
              {undoPreview && <CopyUndoPreview result={undoPreview} />}
            </div>
          )}

          {copy.state === "undone" && (
            <p role="status" className="text-sm">
              {copy.targetFolder} on {destName} is back to how it was before the copy.
            </p>
          )}

          {error && (
            <p role="alert" className="wrap-anywhere text-sm text-destructive-foreground">
              {error}
            </p>
          )}
        </div>
      </DialogPanel>
      <DialogFooter variant="bare">
        {reviewing && (
          <>
            <Button variant="outline" disabled={busy} onClick={() => void stop()}>
              Cancel copy
            </Button>
            <Button
              disabled={busy || (copy.totals?.decisionsNeeded ?? 1) > 0}
              onClick={() => void apply()}
            >
              Apply and link
            </Button>
          </>
        )}
        {failed && (
          <Button variant="outline" disabled={busy} onClick={() => void stop()}>
            Back
          </Button>
        )}
        {applied &&
          copy.backupsDiscardedAt === undefined &&
          (undoPreview ? (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => void undoCopy(undoPreview.edited > 0, false)}
            >
              {undoPreview.edited > 0 ? "Undo and keep edited files aside" : "Undo the copy"}
            </Button>
          ) : (
            <Button variant="outline" disabled={busy} onClick={() => void undoCopy(false, true)}>
              Undo…
            </Button>
          ))}
        {applied && link?.status === "review" && (
          <Button variant="outline" disabled={busy} onClick={() => setLinkDialog(true)}>
            Link…
          </Button>
        )}
        {(applied || copy.state === "undone") && (
          <Button disabled={busy} onClick={props.onClose}>
            Done
          </Button>
        )}
      </DialogFooter>
      {linkDialog && copy.projectId && (
        <ProjectLinkDialog
          open
          onOpenChange={(open) => !open && setLinkDialog(false)}
          project={source}
          initialCandidate={{ environmentId: destination, projectId: copy.projectId }}
          initialKept="here"
          autoReview
          onLinked={() => {
            setLink({ status: "linked" });
            if (copy.projectId) props.onLinked(copy.projectId);
          }}
        />
      )}
    </>
  );
}
