import { scopeThreadRef } from "@specweave-studio/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@specweave-studio/client-runtime/state/runtime";
import { CommandId, type ProjectId, type ScopedThreadRef } from "@specweave-studio/contracts";
import { useRouter } from "@tanstack/react-router";
import { useEffect, useId, useMemo, useState } from "react";
import { create } from "zustand";

import { useComposerDraftStore } from "../composerDraftStore";
import { newMessageId, newThreadId } from "../lib/utils";
import {
  readThreadShell,
  useProjects,
  useServerConfigs,
  waitForThreadMoveOutcome,
} from "../state/entities";
import { threadEnvironment } from "../state/threads";
import { useOrchestrationCommand } from "../state/use-orchestration-command";
import { buildThreadRouteParams } from "../threadRoutes";
import { isScratchMember } from "../studio/projectListVisibility";
import { threadMoveStartsByDefault, threadMoveTargets } from "./threadMove.logic";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Label } from "./ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "./ui/select";
import { Textarea } from "./ui/textarea";
import { stackedThreadToast, toastManager } from "./ui/toast";

type Request = { readonly threadRef: ScopedThreadRef; readonly resolve: () => void };
const useRequest = create<{ request: Request | null }>(() => ({ request: null }));

/**
 * Opens "Move to another project" for a thread. Resolves when the dialog closes,
 * whether or not the thread moved.
 */
export function requestThreadMove(threadRef: ScopedThreadRef): Promise<void> {
  useRequest.getState().request?.resolve();
  return new Promise((resolve) => useRequest.setState({ request: { threadRef, resolve } }));
}

const newMoveIds = () => ({
  commandId: CommandId.make(`move:${newThreadId()}`),
  targetThreadId: newThreadId(),
  messageId: newMessageId(),
});

function finish() {
  const request = useRequest.getState().request;
  useRequest.setState({ request: null });
  request?.resolve();
}

export function ThreadMoveDialogHost() {
  const request = useRequest((state) => state.request);
  useEffect(() => () => finish(), []);
  return request ? (
    <ThreadMoveDialog
      key={`${request.threadRef.environmentId}:${request.threadRef.threadId}`}
      threadRef={request.threadRef}
    />
  ) : null;
}

function ThreadMoveDialog({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const id = useId();
  const router = useRouter();
  const projects = useProjects();
  const configs = useServerConfigs();
  const readOpeningRequest = useOrchestrationCommand(threadEnvironment.readOpeningRequest, {
    reportFailure: false,
  });
  const moveToProject = useOrchestrationCommand(threadEnvironment.moveToProject, {
    reportFailure: false,
  });
  // A retry to the same project resumes the same move; another project is a new move.
  const [ids, setIds] = useState(newMoveIds);
  const [thread] = useState(() => readThreadShell(threadRef));
  const targets = useMemo(
    () =>
      thread === null
        ? []
        : threadMoveTargets(
            thread,
            projects,
            (environmentId) => configs.get(environmentId)?.scratchWorkspaceRoot ?? null,
          ),
    [configs, projects, thread],
  );
  const sourceProject = projects.find(
    (project) =>
      project.environmentId === threadRef.environmentId && project.id === thread?.projectId,
  );
  // A chat outside every project has nothing to leave behind, so it moves as it is.
  const keepsThread =
    sourceProject !== undefined &&
    isScratchMember(
      sourceProject,
      (environmentId) => configs.get(environmentId)?.scratchWorkspaceRoot ?? null,
    );
  const [targetProjectId, setTargetProjectId] = useState<ProjectId | null>(null);
  const [text, setText] = useState("");
  const [attachmentCount, setAttachmentCount] = useState(0);
  const [startNow, setStartNow] = useState(() =>
    thread === null ? false : threadMoveStartsByDefault(thread),
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void readOpeningRequest({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    }).then((result) => {
      if (cancelled || result._tag !== "Success" || result.value === null) return;
      const opening = result.value;
      setText((current) => (current.length === 0 ? opening.text : current));
      setAttachmentCount(opening.attachmentCount);
    });
    return () => {
      cancelled = true;
    };
  }, [readOpeningRequest, threadRef.environmentId, threadRef.threadId]);

  if (thread === null) return null;
  const target = targets.find((project) => project.id === targetProjectId) ?? null;
  const request = text.trim();

  const submit = async () => {
    if (target === null) {
      setError("Choose the project this thread belongs to.");
      return;
    }
    if (!keepsThread && startNow && request.length === 0) {
      setError("Write the request the new thread should start with, or leave it unstarted.");
      return;
    }
    setSubmitting(true);
    setError(null);
    const result = await moveToProject({
      environmentId: threadRef.environmentId,
      input: {
        commandId: ids.commandId,
        threadId: threadRef.threadId,
        targetProjectId: target.id,
        targetThreadId: ids.targetThreadId,
        ...(startNow && !keepsThread ? { start: { messageId: ids.messageId, text: request } } : {}),
      },
    });
    if (result._tag === "Failure") {
      setSubmitting(false);
      if (isAtomCommandInterrupted(result)) return;
      const failure = squashAtomCommandFailure(result);
      setError(failure instanceof Error ? failure.message : "The thread could not be moved.");
      return;
    }
    const movedRef = scopeThreadRef(threadRef.environmentId, ids.targetThreadId);
    // The server decides whether the thread moves as it is; read what actually landed.
    const outcome = await waitForThreadMoveOutcome({
      source: threadRef,
      moved: movedRef,
      projectId: target.id,
    });
    if (outcome === "kept" || (outcome === null && keepsThread)) {
      setSubmitting(false);
      finish();
      toastManager.add(
        stackedThreadToast({
          type: "success",
          title: `Moved to ${target.title}`,
          description: "It keeps its conversation and folder.",
        }),
      );
      return;
    }
    setSubmitting(false);
    if (!startNow && request.length > 0) {
      // The request waits in the new thread's composer for the user to send.
      useComposerDraftStore.getState().setPrompt(movedRef, request);
    }
    finish();
    toastManager.add(
      stackedThreadToast({
        type: "success",
        title: `Moved to ${target.title}`,
        description: startNow
          ? "It started over there as a new thread."
          : "The new thread is waiting for you there.",
      }),
    );
    void router.navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(movedRef),
    });
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !submitting) finish();
      }}
    >
      <DialogPopup className="sm:max-w-lg">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {keepsThread ? "Move to a project" : "Move to another project"}
            </DialogTitle>
            <DialogDescription>
              {keepsThread
                ? `"${thread.title}" has no project. It moves as it is: it keeps its conversation and folder, and running work goes on.`
                : `"${thread.title}" stops in ${sourceProject?.title ?? "this project"} and starts over as a new thread in the project you choose.`}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`${id}-project`}>Project</Label>
                {targets.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    There is no other project on this machine to move it to.
                  </p>
                ) : (
                  <Select
                    value={targetProjectId}
                    onValueChange={(value) => {
                      if (value !== targetProjectId) setIds(newMoveIds());
                      setTargetProjectId(value as ProjectId | null);
                      setError(null);
                    }}
                  >
                    <SelectTrigger id={`${id}-project`} size="sm">
                      <SelectValue>{target?.title ?? "Choose a project"}</SelectValue>
                    </SelectTrigger>
                    <SelectPopup>
                      {targets.map((project) => (
                        <SelectItem key={project.id} value={project.id}>
                          {project.title}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                )}
              </div>
              {keepsThread ? (
                <p className="text-xs text-muted-foreground">
                  From then on it runs with that project's settings and memory, and it is listed
                  with the project's threads.
                </p>
              ) : (
                <>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor={`${id}-request`}>Opening request</Label>
                    <Textarea
                      id={`${id}-request`}
                      value={text}
                      rows={5}
                      onChange={(event) => setText(event.target.value)}
                      placeholder="What the new thread should do"
                    />
                    {attachmentCount > 0 ? (
                      <p className="text-xs text-muted-foreground">
                        {attachmentCount === 1
                          ? "Its attachment stays with this thread. Attach it again in the new one."
                          : `Its ${attachmentCount} attachments stay with this thread. Attach them again in the new one.`}
                      </p>
                    ) : null}
                  </div>
                  <label className="flex items-start gap-2 text-sm">
                    <Checkbox
                      checked={startNow}
                      onCheckedChange={(checked) => setStartNow(checked === true)}
                    />
                    <span className="flex flex-col gap-0.5">
                      <span>Start it there now</span>
                      <span className="text-xs text-muted-foreground">
                        Otherwise the request waits in the new thread's composer, and nothing runs
                        until you send it.
                      </span>
                    </span>
                  </label>
                  <ul className="list-disc space-y-1 ps-5 text-xs text-muted-foreground">
                    <li>
                      Nothing carries over: no conversation, file changes, worktree, project memory
                      or sign-ins. Files it changed stay in this project's folder.
                    </li>
                    <li>
                      Its running turn and delegated tasks stop, and queued messages are discarded.
                      Linked pull requests stay with this thread.
                    </li>
                    <li>
                      This thread is archived with a link to the new one, keeps its history and
                      takes no new messages.
                    </li>
                  </ul>
                </>
              )}
              {error ? <p className="text-sm text-destructive-foreground">{error}</p> : null}
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={submitting} onClick={() => finish()}>
              Cancel
            </Button>
            <Button type="submit" disabled={submitting || target === null}>
              {submitting ? "Moving…" : target ? `Move to ${target.title}` : "Move"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
