import { useEffect, useMemo, useRef, useState } from "react";
import {
  AuthOrchestrationOperateScope,
  getProviderAttachmentLimitError,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  type EnvironmentId,
  type ThreadId,
} from "@specweave-studio/contracts";
import {
  useComposerDraftStore,
  useComposerThreadDraft,
  type ComposerFileAttachment,
  type ComposerImageAttachment,
} from "../../composerDraftStore";
import {
  questionAttachmentDraftId,
  countQuestionAttachments,
  changeQuestionAttachmentPreparation,
  useQuestionAttachmentPreparation,
} from "../../questionAttachments";
import { readEnvironmentScope } from "../../state/session";
import {
  releaseDraftAttachment,
  retryAttachmentUpload,
  startAttachmentUpload,
  useAttachmentUploadStore,
} from "../../lib/attachmentUploadQueue";
import { prepareImageForAttachment } from "../../lib/imageCompression";
import { randomUUID } from "../../lib/utils";
import {
  classifyComposerAttachmentFile,
  normalizeComposerImageFileMimeType,
} from "../chat/composerAttachmentFiles";
import { Button } from "../ui/button";
import { PaperclipIcon, XIcon } from "lucide-react";

/** Uses the same persisted question drafts, preparation counters and guarded upload queue as native chat. */
export function CoordinatorQuestionAttachments({
  environmentId,
  threadId,
  requestId,
  questionId,
  allQuestionIds,
  disabled,
  maxFileBytes,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  requestId: string;
  questionId: string;
  allQuestionIds: readonly string[];
  disabled: boolean;
  maxFileBytes: number | null;
}) {
  const target = questionAttachmentDraftId(environmentId, threadId, requestId, questionId);
  const keys = useMemo(
    () =>
      allQuestionIds.map((id) => questionAttachmentDraftId(environmentId, threadId, requestId, id)),
    [allQuestionIds, environmentId, threadId, requestId],
  );
  const draft = useComposerThreadDraft(target);
  const attachments = [...draft.images, ...draft.files];
  const uploads = useAttachmentUploadStore((state) => state.uploadsByImageId);
  const preparing = useQuestionAttachmentPreparation((state) => state.counts[target] ?? 0);
  const picker = useRef<HTMLInputElement>(null);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => setProblem(null), [target]);
  useEffect(() => {
    if (disabled) return;
    for (const image of attachments)
      startAttachmentUpload({ environmentId, image, draftTarget: target });
  }, [disabled, environmentId, draft.images, draft.files, target]);
  const canChange = () =>
    !disabled && readEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  async function add(files: File[]) {
    if (!canChange()) return;
    setProblem(null);
    const accepted: File[] = [];
    const problems: string[] = [];
    // Reserve before awaiting preparation, so overlapping picks share the request's limit.
    for (const file of files) {
      if (countQuestionAttachments(keys) >= PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
        problems.push(`${file.name}: the answer attachment limit has been reached.`);
        continue;
      }
      if (
        classifyComposerAttachmentFile(file) === "file" &&
        (maxFileBytes === null || file.size > maxFileBytes || file.size === 0)
      ) {
        problems.push(`${file.name}: this host cannot accept this file size or type.`);
        continue;
      }
      accepted.push(file);
      changeQuestionAttachmentPreparation(target, 1);
    }
    for (const file of accepted) {
      try {
        let attachment: ComposerImageAttachment | ComposerFileAttachment;
        if (classifyComposerAttachmentFile(file) === "image") {
          const result = await prepareImageForAttachment(normalizeComposerImageFileMimeType(file));
          if (!result.ok) {
            problems.push(`${file.name}: the image could not be prepared.`);
            continue;
          }
          attachment = {
            type: "image",
            id: randomUUID(),
            name: result.file.name || file.name,
            mimeType: result.file.type,
            sizeBytes: result.file.size,
            previewUrl: URL.createObjectURL(result.file),
            file: result.file,
          };
        } else {
          attachment = {
            type: "file",
            id: randomUUID(),
            name: file.name || "file",
            mimeType: file.type || "application/octet-stream",
            sizeBytes: file.size,
            file,
          };
        }
        const current = keys.flatMap((key) => {
          const held = useComposerDraftStore.getState().getComposerDraft(key);
          return held ? [...held.images, ...held.files] : [];
        });
        const limit = getProviderAttachmentLimitError([...current, attachment]);
        // A resolved/dismissed question clears its preparation marker. Never attach after that.
        if (limit || !canChange() || !useQuestionAttachmentPreparation.getState().counts[target]) {
          if (attachment.type === "image") URL.revokeObjectURL(attachment.previewUrl);
          if (limit) problems.push(limit);
          continue;
        }
        const store = useComposerDraftStore.getState();
        const ids =
          attachment.type === "image"
            ? store.addImages(target, [attachment])
            : store.addFiles(target, [attachment], { appendReference: false });
        const replacement =
          attachment.type === "file"
            ? store.getComposerDraft(target)?.files.find((held) => held.file === attachment.file)
            : undefined;
        if (!ids.includes(attachment.id) && !replacement) {
          if (attachment.type === "image") URL.revokeObjectURL(attachment.previewUrl);
          problems.push(`${file.name}: this file is already attached or exceeds the limit.`);
          continue;
        }
        startAttachmentUpload({
          environmentId,
          image: replacement ?? attachment,
          draftTarget: target,
        });
      } catch (error) {
        problems.push(error instanceof Error ? error.message : `${file.name}: attaching failed.`);
      } finally {
        changeQuestionAttachmentPreparation(target, -1);
      }
    }
    if (problems.length) setProblem(problems.join(" "));
  }
  return (
    <div
      className="space-y-2"
      aria-label="Answer attachments"
      onDragOver={(event) => {
        if (!disabled && event.dataTransfer.types.includes("Files")) event.preventDefault();
      }}
      onDrop={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        void add([...event.dataTransfer.files]);
      }}
    >
      <input
        ref={picker}
        type="file"
        multiple
        hidden
        aria-label="Choose answer attachments"
        accept={maxFileBytes === null ? "image/*" : undefined}
        onChange={(event) => {
          void add([...(event.target.files ?? [])]);
          event.target.value = "";
        }}
      />
      <Button
        variant="outline"
        size="sm"
        disabled={disabled}
        onClick={() => picker.current?.click()}
      >
        <PaperclipIcon aria-hidden />
        Attach to answer
      </Button>
      {preparing ? (
        <p className="text-xs text-muted-foreground" role="status">
          Preparing {preparing} attachment{preparing === 1 ? "" : "s"}…
        </p>
      ) : null}
      {problem ? (
        <p className="text-xs text-destructive" role="alert">
          {problem}
        </p>
      ) : null}
      {attachments.length ? (
        <ul className="space-y-1" aria-label="Attached to this answer">
          {attachments.map((attachment) => {
            const state = uploads[attachment.id];
            return (
              <li
                key={attachment.id}
                className="flex items-center gap-2 rounded-lg border p-2 text-sm"
              >
                <span className="min-w-0 flex-1 truncate">{attachment.name}</span>
                <span className="text-xs text-muted-foreground">
                  {state?.status === "ready"
                    ? "Ready"
                    : state?.status === "failed"
                      ? "Upload failed"
                      : "Uploading…"}
                </span>
                {state?.status === "failed" ? (
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={disabled}
                    onClick={() => {
                      if (canChange())
                        retryAttachmentUpload({
                          environmentId,
                          image: attachment,
                          draftTarget: target,
                        });
                    }}
                  >
                    Retry upload
                  </Button>
                ) : null}
                <Button
                  variant="ghost-muted"
                  size="icon-xs"
                  aria-label={`Remove ${attachment.name}`}
                  disabled={disabled}
                  onClick={() => {
                    if (!canChange()) return;
                    setProblem(null);
                    releaseDraftAttachment(attachment);
                    const store = useComposerDraftStore.getState();
                    if (attachment.type === "image") {
                      store.removeImage(target, attachment.id);
                    } else store.removeFile(target, attachment.id);
                  }}
                >
                  <XIcon aria-hidden />
                </Button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
