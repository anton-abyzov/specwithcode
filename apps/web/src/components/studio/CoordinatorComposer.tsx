import type {
  ChatAttachment,
  EnvironmentId,
  ResolvedKeybindingsConfig,
} from "@specweave-studio/contracts";
import type { ClientSettings } from "@specweave-studio/contracts/settings";
import { ArrowUpIcon, PlusIcon } from "lucide-react";
import { useRef, useSyncExternalStore, type ReactNode } from "react";

import { composerSendButtonLabel, composerSubmissionIntentForKey } from "../../composer-logic";
import { parseComposerAppCommand } from "../../studio/composerAppCommands";
import type { ProjectCoordinatorComposer } from "../../studio/projectCoordinatorComposer";
import { useCoordinatorSlashMenu, type CoordinatorSlashMenuInput } from "./CoordinatorSlashMenu";
import {
  coordinatorAttachAccept,
  CoordinatorAttachmentNotice,
  CoordinatorAttachmentStrip,
  filesFrom,
  pastedFilesFrom,
  useCoordinatorAttachments,
} from "./shell/CoordinatorAttachments";
import { Tip } from "./shell/Tip";

type Attached = ReturnType<typeof useCoordinatorAttachments>;

/**
 * Sends the draft the composer holds. Outside the component: the React Compiler
 * cannot compile a `try` with a `finally`, and one would leave the composer, and
 * every keystroke in it, unoptimized.
 */
async function submitCoordinatorDraft(input: {
  readonly composer: ProjectCoordinatorComposer;
  readonly attached: Attached;
  readonly onAppCommand: CoordinatorSlashMenuInput["onAppCommand"];
  readonly onSend: (
    text: string,
    attachments: ReadonlyArray<ChatAttachment> | undefined,
  ) => Promise<void>;
  readonly onError: (message: string | null) => void;
}): Promise<void> {
  const { composer, attached, onAppCommand, onSend, onError } = input;
  const { prompt: text, promptRevision, attachments: images, submitting } = composer.getSnapshot();
  if (submitting || (!text.trim() && images.length === 0)) return;
  const appCommand = images.length === 0 ? parseComposerAppCommand(text) : null;
  if (appCommand !== null) {
    // The app runs it; nothing goes to the coordinator.
    composer.setPrompt("");
    if (onAppCommand) void onAppCommand(appCommand);
    return;
  }
  composer.setSubmitting(true);
  onError(null);
  attached.dismissProblem();
  let release = () => {};
  try {
    const attachments = await attached.prepare(images);
    release = attached.hold(images);
    await onSend(text, attachments.length ? attachments : undefined);
    release();
    composer.clearSentPrompt(promptRevision);
    attached.clearSent(images);
  } catch (e) {
    onError(e instanceof Error ? e.message : "Message not sent.");
  } finally {
    release();
    composer.setSubmitting(false);
  }
}

/**
 * The coordinator's message box. It owns the draft's subscription, so a keystroke
 * renders this form and nothing else: the conversation above it stays as it was.
 */
export function CoordinatorComposer(props: {
  readonly composer: ProjectCoordinatorComposer;
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  /** Nothing can be sent for a reason the parent shows: a blocked host, no model, a send or save in flight. */
  readonly sendBlocked: boolean;
  /** Said when the send key is pressed and only a model is missing. */
  readonly missingModel: string | null;
  /** This window may attach and upload files to the host right now. */
  readonly canAttach: boolean;
  readonly uploadsSupported: boolean;
  readonly maxFileBytes: number | null;
  readonly sending: boolean;
  readonly placeholder: string;
  readonly keybindings: ResolvedKeybindingsConfig;
  readonly isPhoneKeyboard: boolean;
  readonly sendShortcut: ClientSettings["sendShortcut"];
  readonly onAppCommand: CoordinatorSlashMenuInput["onAppCommand"];
  readonly provider: CoordinatorSlashMenuInput["provider"];
  readonly onSend: (
    text: string,
    attachments: ReadonlyArray<ChatAttachment> | undefined,
  ) => Promise<void>;
  readonly onError: (message: string | null) => void;
  /** Above the attachment notice: why the host is blocked, the last error. */
  readonly status: ReactNode;
  /** Below the attachment notice: the send receipt and the voice call bar. */
  readonly notices: ReactNode;
  /** The composer foot's controls after the attach button. */
  readonly meta: ReactNode;
  readonly controls: ReactNode;
  readonly modelFallback: boolean;
}) {
  const {
    composer,
    environmentId,
    sendBlocked,
    missingModel,
    canAttach,
    uploadsSupported,
    maxFileBytes,
    sending,
    keybindings,
    isPhoneKeyboard,
    sendShortcut,
    onAppCommand,
    onSend,
    onError,
  } = props;
  const { prompt, submitting: preparing } = useSyncExternalStore(
    composer.subscribe,
    composer.getSnapshot,
    composer.getSnapshot,
  );
  const attached = useCoordinatorAttachments({
    environmentId,
    draft: composer,
    uploadsSupported,
    canUpload: canAttach,
    maxFileBytes,
  });
  const slashMenu = useCoordinatorSlashMenu({
    prompt,
    setPrompt: composer.setPrompt,
    onAppCommand,
    provider: props.provider,
    cwd: props.cwd,
  });
  const filePicker = useRef<HTMLInputElement>(null);
  // One rule for the Send button and the Enter key.
  const sendDisabled =
    sendBlocked ||
    preparing ||
    attached.preparing.length > 0 ||
    (!prompt.trim() && attached.attachments.length === 0);
  const submit = () =>
    submitCoordinatorDraft({ composer, attached, onAppCommand, onSend, onError });
  return (
    <form
      className="project-composer sws-composer"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      {props.status}
      <CoordinatorAttachmentNotice problem={attached.problem} onDismiss={attached.dismissProblem} />
      {props.notices}
      <div
        className="sws-composer-card"
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes("Files")) e.preventDefault();
        }}
        onDrop={(e) => {
          if (!e.dataTransfer.types.includes("Files")) return;
          // Every dropped file is answered: attached, or told why not.
          e.preventDefault();
          attached.add(filesFrom(e.dataTransfer));
        }}
      >
        {slashMenu.menu}
        <CoordinatorAttachmentStrip
          attachments={attached.attachments}
          preparing={attached.preparing}
          locked={preparing || sending}
          onRemove={(id) => {
            attached.remove(id);
            // The button that had focus is gone; typing continues in the message.
            document.getElementById("project-prompt")?.focus();
          }}
        />
        <label className="sr-only" htmlFor="project-prompt">
          Message the project coordinator
        </label>
        <textarea
          id="project-prompt"
          rows={1}
          value={prompt}
          onChange={(e) => {
            composer.setPrompt(e.target.value);
            slashMenu.onCaretChange(e.target.selectionStart);
          }}
          onSelect={(e) => slashMenu.onCaretChange(e.currentTarget.selectionStart)}
          aria-controls={slashMenu.listId}
          aria-expanded={slashMenu.open}
          aria-autocomplete="list"
          placeholder={props.placeholder}
          onPaste={(e) => {
            const files = pastedFilesFrom(e.clipboardData);
            if (files.length === 0) return;
            // A file on the clipboard is the message's attachment, not text to insert.
            e.preventDefault();
            attached.add(files);
          }}
          onKeyDown={(e) => {
            if (slashMenu.onKeyDown(e)) return;
            // The chat composer's own rule: the person's send shortcut, never on a
            // phone keyboard, never mid-composition or on a held key.
            const intent = composerSubmissionIntentForKey({
              event: e.nativeEvent,
              keybindings,
              isPhoneKeyboard,
              isDraftThread: false,
              sendShortcut,
              prompt,
            });
            if (intent !== "foreground") return;
            // The send key never types a new line, but it sends only when the Send
            // button could: images still preparing, a blocked host or a send in
            // flight are all visible beside it.
            e.preventDefault();
            if (sendDisabled) {
              // The only reason not shown beside the composer: say it, as a send would.
              if (missingModel !== null && (prompt.trim() || attached.attachments.length > 0))
                onError(missingModel);
              return;
            }
            void submit();
          }}
        />
        <Tip label={composerSendButtonLabel({ isPhoneKeyboard, sendShortcut, prompt })}>
          <button className="sws-send" aria-label="Send to coordinator" disabled={sendDisabled}>
            <ArrowUpIcon aria-hidden />
            <span className="sr-only">{sending || preparing ? "Sending…" : "Send"}</span>
          </button>
        </Tip>
      </div>
      <div className="sws-composer-foot" data-model-fallback={props.modelFallback ? "" : undefined}>
        <span className="sws-composer-meta">
          <input
            ref={filePicker}
            type="file"
            accept={coordinatorAttachAccept(maxFileBytes !== null)}
            multiple
            hidden
            tabIndex={-1}
            aria-hidden
            onChange={(e) => {
              attached.add([...(e.target.files ?? [])]);
              e.target.value = "";
            }}
          />
          <Tip label="Attach images or files (or paste, or drop them on the message)">
            <button
              type="button"
              className="sws-icon-button sws-attach"
              aria-label="Attach files"
              disabled={!canAttach}
              onClick={() => filePicker.current?.click()}
            >
              <PlusIcon aria-hidden />
            </button>
          </Tip>
          {props.meta}
        </span>
        {props.controls}
      </div>
    </form>
  );
}
