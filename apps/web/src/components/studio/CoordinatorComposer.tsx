import type {
  ChatAttachment,
  EnvironmentId,
  ResolvedKeybindingsConfig,
  ScopedThreadRef,
} from "@specweave-studio/contracts";
import type { ClientSettings } from "@specweave-studio/contracts/settings";
import { ArrowUpIcon, PlusIcon } from "lucide-react";
import { useRef, useSyncExternalStore, type ReactNode } from "react";

import { composerSendButtonLabel, composerSubmissionIntentForKey } from "../../composer-logic";
import { parseAwayAppCommand, parseComposerAppCommand } from "../../studio/composerAppCommands";
import { requestAway } from "../../studio/awayRequest";
import { resolveLeadingSkillCommand } from "../../providerSkillSearch";
import { ViewerThreadComposerPortal } from "../../viewerOverlayStore";
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
import { useEnvironment, usePrimaryEnvironmentId } from "../../state/environments";
import { machineColorProps, useMachineIdentity } from "../../studio/machineIdentity";
import { DRAFT_SENT_ELSEWHERE_MESSAGE } from "../../lib/durableComposerDraftBindings";

type Attached = ReturnType<typeof useCoordinatorAttachments>;

/** Sends a coordinator draft; an answer to an earlier question may keep its uploads. */
export type CoordinatorDraftSend = (
  text: string,
  attachments: ReadonlyArray<ChatAttachment> | undefined,
) => Promise<void | { readonly keepUploads: boolean }>;

/**
 * Sends the draft the composer holds. Outside the component: the React Compiler
 * cannot compile a `try` with a `finally`, and one would leave the composer, and
 * every keystroke in it, unoptimized. On failure the text and files stay and the
 * reason shows beside the box.
 */
export async function submitCoordinatorDraft(input: {
  readonly composer: ProjectCoordinatorComposer;
  readonly attached: Attached;
  readonly onAppCommand: CoordinatorSlashMenuInput["onAppCommand"];
  readonly onSend: CoordinatorDraftSend;
  readonly onError: (message: string | null) => void;
  /** The text as the coordinator's provider should get it (a typed `/skill` as its `$` mention). */
  readonly resolveText?: (text: string) => string;
  /** True when another window already sent (or changed) the copy this composer shows. */
  readonly sentElsewhere?: () => Promise<boolean>;
}): Promise<void> {
  const { composer, attached, onAppCommand, onSend, onError } = input;
  const { prompt: text, promptRevision, attachments: images, submitting } = composer.getSnapshot();
  if (submitting || (!text.trim() && images.length === 0)) return;
  const appCommand =
    images.length === 0 && onAppCommand !== null ? parseComposerAppCommand(text) : null;
  if (appCommand !== null && onAppCommand !== null) {
    // The app runs it; nothing goes to the coordinator.
    composer.setPrompt("");
    void onAppCommand(appCommand);
    return;
  }
  // `/away` and `/back` act on the machine, so they open the Away dialog from any composer.
  const awayCommand = images.length === 0 ? parseAwayAppCommand(text) : null;
  if (awayCommand !== null) {
    composer.setPrompt("");
    requestAway(awayCommand);
    return;
  }
  composer.setSubmitting(true);
  onError(null);
  attached.dismissProblem();
  let release = () => {};
  try {
    // A stale copy of a draft sent from another window or machine must not go out twice;
    // the composer now shows the host's state (empty after that send).
    if (await input.sentElsewhere?.()) {
      onError(DRAFT_SENT_ELSEWHERE_MESSAGE);
      return;
    }
    // The composer changed while the host answered (typed here, or cleared by a restore):
    // what was captured above is no longer what the box holds, so it is not sent.
    const after = composer.getSnapshot();
    if (after.promptRevision !== promptRevision || after.attachments !== images) return;
    const attachments = await attached.prepare(images);
    release = attached.hold(images);
    const sent = await onSend(
      input.resolveText?.(text) ?? text,
      attachments.length ? attachments : undefined,
    );
    release();
    composer.clearSentPrompt(promptRevision);
    attached.clearSent(images, { keepUploads: sent?.keepUploads === true });
  } catch (e) {
    onError(e instanceof Error ? e.message : "Message not sent.");
  } finally {
    release();
    composer.setSubmitting(false);
  }
}

/**
 * The coordinator's message box. While the viewer overlay shows the coordinator
 * beside a document, the same box moves there, draft and send included.
 */
export function CoordinatorComposer(
  props: Parameters<typeof CoordinatorComposerForm>[0] & {
    readonly threadRef: ScopedThreadRef | null;
  },
) {
  const { threadRef, ...form } = props;
  return (
    <ViewerThreadComposerPortal threadRef={threadRef}>
      <CoordinatorComposerForm {...form} />
    </ViewerThreadComposerPortal>
  );
}

/**
 * It owns the draft's subscription, so a keystroke renders this form and nothing
 * else: the conversation above it stays as it was.
 */
function CoordinatorComposerForm(props: {
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
  readonly onSend: CoordinatorDraftSend;
  readonly onError: (message: string | null) => void;
  /** Above the attachment notice: why the host is blocked, the last error. */
  readonly status: ReactNode;
  /** Below the attachment notice: the send receipt and the voice call bar. */
  readonly notices: ReactNode;
  /** The coordinator's open question, right above the message box that answers it. */
  readonly question?: ReactNode;
  /** The message box's label: it says when a send answers a question. */
  readonly promptLabel?: string;
  /** The composer foot's controls after the attach button. */
  readonly meta: ReactNode;
  readonly controls: ReactNode;
  readonly modelFallback: boolean;
  /** False while the coordinator's machine is not connected. */
  readonly hostReachable?: boolean;
  /**
   * The button's own words when it does more than send ("Continue here and send"). Never a
   * machine name: the line above the box says where a message goes. With `run`, pressing
   * the button or the send key runs that instead of sending, and the draft stays.
   */
  readonly primary?: { readonly text: string; readonly run?: () => void } | null;
  /**
   * A send that goes to the coordinator on another machine than the one shown: that
   * machine's name for screen readers, and what the button's tooltip says.
   */
  readonly sendTo?: { readonly machine: string; readonly tip: string } | null;
  /** The coordinator is on another machine than the one shown, reachable or not. */
  readonly coordinatorElsewhere?: boolean;
  /** Checked before a send; see `submitCoordinatorDraft`. */
  readonly draftSentElsewhere?: () => Promise<boolean>;
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
    ...(props.hostReachable !== undefined ? { hostReachable: props.hostReachable } : {}),
  });
  const slashMenu = useCoordinatorSlashMenu({
    prompt,
    setPrompt: composer.setPrompt,
    onAppCommand,
    provider: props.provider,
    cwd: props.cwd,
  });
  const filePicker = useRef<HTMLInputElement>(null);
  // The coordinator's machine, by color and icon: the box wears it. Send carries its color
  // when it goes to a machine other than this device's, and never its name.
  const hostEnvironment = useEnvironment(environmentId);
  const machine = useMachineIdentity(environmentId, hostEnvironment?.label);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const primary = props.primary ?? null;
  const sendsElsewhere =
    // The coordinator is on another machine and this send does not go there: no machine.
    !(props.coordinatorElsewhere && !props.sendTo) &&
    props.hostReachable !== false &&
    machine !== null &&
    primaryEnvironmentId !== null &&
    environmentId !== primaryEnvironmentId;
  const sendLabel = composerSendButtonLabel({ isPhoneKeyboard, sendShortcut, prompt });
  // One rule for the Send button and the Enter key.
  const sendDisabled =
    sendBlocked ||
    preparing ||
    attached.preparing.length > 0 ||
    (!prompt.trim() && attached.attachments.length === 0);
  const submit = () =>
    primary?.run
      ? Promise.resolve(primary.run())
      : submitCoordinatorDraft({
          composer,
          attached,
          onAppCommand,
          onSend,
          onError,
          resolveText: (text) =>
            resolveLeadingSkillCommand(text, props.provider?.snapshot, props.cwd),
          ...(props.draftSentElsewhere ? { sentElsewhere: props.draftSentElsewhere } : {}),
        });
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
      {props.question}
      <div
        className={machine ? "sws-composer-card machine-composer" : "sws-composer-card"}
        {...machineColorProps(machine)}
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
          {props.promptLabel ?? "Message the project coordinator"}
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
        <Tip label={primary?.text ?? props.sendTo?.tip ?? sendLabel}>
          <button
            className={[
              "sws-send",
              primary ? "sws-send-target" : "",
              sendsElsewhere ? "machine-send" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            // The words are drawn from this attribute. They never name a machine.
            {...(primary
              ? { "data-send-label": primary.text, "data-send-short": primary.text }
              : {})}
            {...(sendsElsewhere ? machineColorProps(machine) : {})}
            aria-label={
              primary?.text ??
              (props.sendTo
                ? `Send to the coordinator on ${props.sendTo.machine}`
                : sendsElsewhere
                  ? `Send to the coordinator on ${machine.name}`
                  : "Send to coordinator")
            }
            disabled={sendDisabled && !primary?.run}
          >
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
              disabled={!canAttach && props.hostReachable !== false}
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
