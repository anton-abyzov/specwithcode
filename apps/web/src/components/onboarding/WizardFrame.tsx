import {
  createContext,
  useContext,
  useEffect,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from "react";
import { createPortal } from "react-dom";
import { isElectron } from "../../env";
import { useT } from "../../i18n";
import { currentPlatform, keyLabel } from "../../lib/platformConventions";
import { StarOnGitHubLink } from "../github/StarOnGitHub";
import { LanguageSelect } from "../settings/LanguageSelect";
import { StudioWordmark } from "../StudioWordmark";
import { Button } from "../ui/button";
import { Dialog } from "../ui/dialog";
import { DialogCloseButton } from "../ui/dialog-close-button";
import { WizardFooter, WizardHeader, WizardPanel, WizardPopup, WizardSteps } from "../ui/wizard";
import { FirstRunUpdateNotice } from "./FirstRunUpdateNotice";
import { stepStartControl } from "./wizardFocus";

/**
 * One entry of the first-run stage bar. The bar, Back and Continue all read the
 * same list, so a stage is added by adding one entry and left out by `when`.
 */
export interface WizardStage<Id extends string = string> {
  readonly id: Id;
  readonly label: string;
  /** False leaves the stage out of the bar and out of Back and Continue. */
  readonly when?: boolean;
}

export function shownStages<Id extends string>(
  stages: readonly WizardStage<Id>[],
): readonly WizardStage<Id>[] {
  return stages.filter((stage) => stage.when !== false);
}

function neighbourStage<Id extends string>(
  stages: readonly WizardStage<Id>[],
  id: Id,
  direction: 1 | -1,
): Id | null {
  const from = stages.findIndex((stage) => stage.id === id);
  if (from === -1) return null;
  for (let index = from + direction; index >= 0 && index < stages.length; index += direction) {
    const stage = stages[index]!;
    if (stage.when !== false) return stage.id;
  }
  return null;
}

/** The next shown stage, from the full list: a stage hidden while it is open still knows its place. */
export function stageAfter<Id extends string>(stages: readonly WizardStage<Id>[], id: Id) {
  return neighbourStage(stages, id, 1);
}

export function stageBefore<Id extends string>(stages: readonly WizardStage<Id>[], id: Id) {
  return neighbourStage(stages, id, -1);
}

export function StepShell({
  title,
  description,
  children,
}: {
  readonly title: string;
  readonly description?: string;
  readonly children?: React.ReactNode;
}) {
  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight text-foreground">{title}</h1>
      {description ? (
        <p className="mt-2.5 text-sm leading-relaxed text-muted-foreground">{description}</p>
      ) : null}
      {children}
    </>
  );
}

/** True once `active` has held for `delayMs`, and false again when it stops. */
export function useHeldFor(active: boolean, delayMs: number) {
  const [elapsed, setElapsed] = useState(false);
  useEffect(() => {
    if (!active) return;
    const timer = setTimeout(() => setElapsed(true), delayMs);
    return () => {
      clearTimeout(timer);
      setElapsed(false);
    };
  }, [active, delayMs]);
  return active && elapsed;
}

/** Undefined outside the frame; null inside it until the slot is in the page. */
const FooterSlotContext = createContext<HTMLElement | null | undefined>(undefined);

/**
 * Where the open step's footer is drawn: below the scrolling panel, so the
 * actions stay in view however long the step is. Without a slot (a step drawn
 * on its own) the footer follows the step's content.
 */
export function WizardFooterSlot({
  slot,
  children,
}: {
  readonly slot: HTMLElement | null;
  readonly children: ReactNode;
}) {
  return <FooterSlotContext.Provider value={slot}>{children}</FooterSlotContext.Provider>;
}

export interface WizardFooterAction {
  readonly label: string;
  readonly onClick: () => void;
  readonly disabled?: boolean;
}

export interface WizardPrimaryAction extends WizardFooterAction {
  /** The label says what is running; the button is off until it ends. */
  readonly busy?: boolean;
  /** Outline when going on is allowed but is not what the step recommends. */
  readonly variant?: "default" | "outline";
  /** Off for a step that starts on a field of its own. */
  readonly autoFocus?: boolean;
}

/**
 * The one footer every first-run step has: Back on the left, then the skip
 * action and the primary in the system's order. Enter presses the primary (see
 * `handleWizardEnter`). A step whose primary fails stays open and passes `error`.
 */
export function WizardStepFooter({
  back,
  leading,
  skip,
  primary,
  primaryRef,
  note,
  error,
}: {
  /** Absent on the first step. */
  readonly back?: { readonly onClick: () => void; readonly disabled?: boolean } | undefined;
  /** A quiet extra control that keeps the left side, after Back. */
  readonly leading?: ReactNode;
  readonly skip?: WizardFooterAction | undefined;
  readonly primary?: WizardPrimaryAction | undefined;
  readonly primaryRef?: Ref<HTMLButtonElement> | undefined;
  /** Says why an action is off, such as an import still running. */
  readonly note?: string | null | undefined;
  readonly error?: string | null | undefined;
}) {
  const t = useT();
  const slot = useContext(FooterSlotContext);
  const footer = (
    <div data-slot="wizard-step-footer" className={slot ? "shrink-0" : "-mx-6 mt-4 -mb-5"}>
      {error ? (
        <p role="alert" className="px-6 pt-3 text-sm text-destructive-foreground">
          {error}
        </p>
      ) : null}
      {note ? (
        <p role="status" className="px-6 pt-3 text-xs leading-relaxed text-muted-foreground">
          {note}
        </p>
      ) : null}
      <WizardFooter
        leading={
          <div className="flex flex-wrap items-center gap-2" data-slot="wizard-footer-leading">
            {back ? (
              <Button variant="ghost" disabled={back.disabled} onClick={back.onClick}>
                {t("wizard.back")}
              </Button>
            ) : null}
            {leading}
          </div>
        }
      >
        {skip ? (
          <Button variant="outline" disabled={skip.disabled} onClick={skip.onClick}>
            {skip.label}
          </Button>
        ) : null}
        {primary ? (
          <Button
            ref={primaryRef}
            data-wizard-primary=""
            aria-keyshortcuts="Enter"
            // Not before the footer is in its slot: focus inside the panel would scroll the step.
            autoFocus={slot !== null && (primary.autoFocus ?? true)}
            variant={primary.variant ?? "default"}
            disabled={primary.disabled || primary.busy}
            onClick={primary.onClick}
          >
            {primary.label}
            {/* A hint for the eye, drawn by CSS: the button's name and text stay its label. */}
            <kbd
              aria-hidden
              data-slot="kbd"
              data-key={keyLabel("enter", currentPlatform())}
              className="pointer-events-none inline-flex h-5 min-w-5 items-center justify-center rounded bg-current/12 px-1 font-sans text-xs font-medium opacity-80 select-none before:content-[attr(data-key)]"
            />
          </Button>
        ) : null}
      </WizardFooter>
    </div>
  );
  return slot ? createPortal(footer, slot) : footer;
}

/** Controls that use Enter themselves: pressing it there is theirs, not the step's. */
const ENTER_OWNERS =
  'button, a[href], select, textarea, summary, [role="button"], [role="checkbox"], [role="switch"], [role="radio"], [role="combobox"], [role="option"], [role="menuitem"], [role="tab"], [contenteditable=""], [contenteditable="true"]';
/** A terminal types Enter and Escape; a form has its own submit. */
const KEYS_OFF = '.xterm, [data-wizard-keys="off"]';

/** The step's primary button when Enter at `target` should press it, else null. */
export function primaryForEnter(popup: Element, target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element) || !popup.contains(target)) return null;
  if (target.closest(`form, ${KEYS_OFF}`) || target.closest(ENTER_OWNERS)) return null;
  return popup.querySelector<HTMLElement>("[data-wizard-primary]:not(:disabled)");
}

/**
 * `onKeyDown` for the setup dialog: Enter presses the step's primary from
 * anywhere in the step that does not use Enter itself. Menus and dialogs opened
 * from a step draw outside the dialog, so their keys never count.
 */
export function handleWizardEnter(event: KeyboardEvent<HTMLElement>) {
  if (event.key !== "Enter" || event.defaultPrevented || event.nativeEvent.isComposing) return;
  if (event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return;
  const primary = primaryForEnter(event.currentTarget, event.target);
  if (!primary) return;
  event.preventDefault();
  primary.click();
}

/**
 * Whether Escape pressed at `target` leaves setup, as the close button does.
 * A terminal keeps its Escape, and so does anything outside the dialog, such as
 * the sign-in window.
 */
export function escapeLeavesSetup(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return true;
  if (target.closest(KEYS_OFF)) return false;
  const popup = '[data-slot="dialog-popup"]';
  if (target.closest(popup) !== null) return true;
  // With nothing focused the key is setup's, unless another dialog is open over it.
  return (
    target === document.body &&
    [
      ...document.querySelectorAll('[role="dialog"], [role="alertdialog"], [aria-modal="true"]'),
    ].every((dialog) => dialog.closest(popup) !== null)
  );
}

/**
 * The first-run dialog every step is drawn in: the stage bar from the list of
 * stages, the scrolling panel with the open step, that step's footer below it
 * and the close button. Enter presses the step's primary; Escape and the close
 * button both leave setup where closing is allowed.
 */
export function FirstRunFrame<Id extends string>({
  stages,
  currentStage,
  stagesLocked = false,
  onStageChange,
  canClose,
  onLeave,
  holdHeight = false,
  children,
  after,
}: {
  /** The stages to show, in order (see `shownStages`). */
  readonly stages: readonly WizardStage<Id>[];
  readonly currentStage: number;
  /** While true no stage can be reopened from the bar, as during an import. */
  readonly stagesLocked?: boolean;
  /** An earlier stage was picked from the bar. */
  readonly onStageChange: (stage: WizardStage<Id>) => void;
  readonly canClose: boolean;
  readonly onLeave: () => void;
  readonly holdHeight?: boolean;
  readonly children: ReactNode;
  /** Drawn beside the dialog, such as a dialog a step opens. */
  readonly after?: ReactNode;
}) {
  const t = useT();
  const [footerSlot, setFooterSlot] = useState<HTMLElement | null>(null);
  return (
    <Dialog
      open
      disablePointerDismissal
      onOpenChange={(open, event) => {
        event.cancel();
        if (open || !canClose) return;
        // Escape does what the close button does, except where a terminal has the key.
        if (
          event.reason === "close-press" ||
          (event.reason === "escape-key" && escapeLeavesSetup(event.event.target))
        ) {
          onLeave();
        }
      }}
    >
      {isElectron ? (
        // Setup covers the workspace's own top bar, so the window keeps a strip to drag it by.
        <div
          aria-hidden
          data-slot="first-run-drag-strip"
          className="drag-region fixed inset-x-0 top-0 z-[51] h-[var(--workspace-topbar-height)]"
        />
      ) : null}
      <WizardPopup
        size="wide"
        bottomStickOnMobile={false}
        showCloseButton={false}
        // The dialog stays clear of the strip, and so of the window's own buttons.
        clearTitlebar={isElectron}
        initialFocus={() => stepStartControl() ?? true}
        onKeyDown={handleWizardEnter}
      >
        <WizardHeader
          title={t("wizard.title")}
          identity={
            <div className="flex flex-wrap items-center justify-between gap-3 pe-10">
              <div className="flex items-center gap-2" role="img" aria-label="SpecWithCode">
                <StudioWordmark className="size-6 shrink-0" aria-hidden />
                <span className="text-2xl font-medium tracking-tight text-muted-foreground">
                  SpecWithCode
                </span>
              </div>
              <div className="flex items-center gap-1">
                <StarOnGitHubLink />
                <LanguageSelect showIcon className="w-auto sm:w-auto" />
              </div>
            </div>
          }
        >
          <WizardSteps
            steps={stages.map((stage) => stage.label)}
            currentStep={currentStage}
            isStepDisabled={(index) => stagesLocked || index >= currentStage}
            onStepChange={(index) => {
              const stage = stages[index];
              if (stagesLocked || index >= currentStage || stage === undefined) return;
              onStageChange(stage);
            }}
          />
          <FirstRunUpdateNotice />
        </WizardHeader>
        <WizardFooterSlot slot={footerSlot}>
          <WizardPanel holdHeight={holdHeight}>{children}</WizardPanel>
        </WizardFooterSlot>
        {/* The open step draws its footer here, below the scroll, so its actions stay in view. */}
        <div ref={setFooterSlot} data-slot="wizard-footer-slot" className="shrink-0 empty:hidden" />
        {/* Last, as in every dialog: setup opens focused on its content. */}
        {canClose ? (
          <DialogCloseButton aria-label={t("wizard.close")} title={t("wizard.close")} />
        ) : null}
      </WizardPopup>
      {after}
    </Dialog>
  );
}
