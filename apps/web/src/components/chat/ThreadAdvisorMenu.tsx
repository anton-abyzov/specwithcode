/**
 * The thread's own rows in the composer's options menu, each with Follow
 * project (the project's setting shown beside it), On and Off:
 * - Advisor: whether this thread may consult a stronger model;
 * - Adversarial review: whether a finished feature on this thread gets a
 *   review by a model from another family.
 * Each row has an info button with what it costs in time.
 */
import type {
  AdversarialReviewSettings,
  AdvisorSettings,
  ScopedThreadRef,
  ThreadAdvisorMode,
  ThreadReviewMode,
} from "@specweave-studio/contracts";
import { threadReviewState } from "@specweave-studio/shared/adversarialReview";
import { threadAdvisorState } from "@specweave-studio/shared/advisor";
import { resolveProjectSettings } from "@specweave-studio/shared/projectSettings";
import { InfoIcon } from "lucide-react";

import { useTx } from "../../i18n";
import { useThreadShell } from "../../state/entities";
import { useEnvironment } from "../../state/environments";
import { threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import {
  ADVERSARIAL_REVIEW_TIME_NOTE,
  ADVISOR_TIME_NOTE,
  SLOWER_WORK_NOTE_LABEL,
} from "../settings/slowerWorkNotes";
import { threadAdvisorMenuVisible, threadReviewMenuVisible } from "./threadAdvisorAvailability";
import { Button } from "../ui/button";
import { MenuGroup, MenuRadioGroup, MenuRadioItem, MenuSeparator as MenuDivider } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export type ThreadAdvisorChoice = "follow" | ThreadAdvisorMode;

export const THREAD_ADVISOR_CHOICES: ReadonlyArray<ThreadAdvisorChoice> = ["follow", "on", "off"];

/** The radio value for a thread's stored mode; null and absent follow the project. */
export function threadAdvisorChoice(
  mode: ThreadAdvisorMode | null | undefined,
): ThreadAdvisorChoice {
  return mode === "on" || mode === "off" ? mode : "follow";
}

/** The mode a choice writes with thread.advisor-mode.set. */
export function threadAdvisorModeForChoice(choice: ThreadAdvisorChoice): ThreadAdvisorMode | null {
  return choice === "follow" ? null : choice;
}

export { threadAdvisorMenuVisible, threadReviewMenuVisible };

export interface ThreadAdvisorMenuState {
  readonly choice: ThreadAdvisorChoice;
  /** Whether the thread may consult, after its own choice. */
  readonly enabled: boolean;
  /** The project's setting, which Follow project uses. */
  readonly projectEnabled: boolean;
}

export function threadAdvisorMenuState(
  mode: ThreadAdvisorMode | null | undefined,
  projectSettings: Pick<AdvisorSettings, "enabled">,
): ThreadAdvisorMenuState {
  return {
    choice: threadAdvisorChoice(mode),
    enabled: threadAdvisorState(mode, projectSettings).enabled,
    projectEnabled: projectSettings.enabled,
  };
}

export interface ThreadReviewMenuState {
  readonly choice: ThreadAdvisorChoice;
  /** Whether a finished feature gets a review, after the thread's own choice. */
  readonly enabled: boolean;
  /** The project's setting, which Follow project uses. */
  readonly projectEnabled: boolean;
}

export function threadReviewMenuState(
  mode: ThreadReviewMode | null | undefined,
  projectSettings: Pick<AdversarialReviewSettings, "autoOnFeatureComplete">,
): ThreadReviewMenuState {
  return {
    choice: threadAdvisorChoice(mode),
    enabled: threadReviewState(mode, projectSettings).enabled,
    projectEnabled: projectSettings.autoOnFeatureComplete,
  };
}

/** A group's name, its info button with the time note, and its one-line description. */
function ThreadChoiceHeader(props: {
  readonly title: string;
  readonly timeNote: string;
  readonly description: string;
}) {
  const tx = useTx();
  return (
    <div className="px-2 pt-1.5 pb-1 font-medium text-muted-foreground text-xs">
      <div className="flex items-center gap-1">
        {props.title}
        <Tooltip>
          <TooltipTrigger
            delay={200}
            render={
              <Button
                size="icon-micro"
                variant="ghost-muted"
                aria-label={tx(SLOWER_WORK_NOTE_LABEL, { setting: props.title })}
                data-thread-choice-time-note=""
              >
                <InfoIcon className="size-3.5" />
              </Button>
            }
          />
          <TooltipPopup side="top" className="max-w-72">
            {props.timeNote}
          </TooltipPopup>
        </Tooltip>
      </div>
      <div className="font-normal">{props.description}</div>
    </div>
  );
}

/** Follow project, On and Off, for one row whose state is already read. */
function ThreadChoiceItems(props: {
  readonly kind: "advisor" | "review";
  readonly state: { readonly choice: ThreadAdvisorChoice; readonly projectEnabled: boolean };
  readonly onChoose: (mode: ThreadAdvisorMode | null) => void;
}) {
  const tx = useTx();
  const { state } = props;
  const labels: Record<ThreadAdvisorChoice, string> = {
    follow: state.projectEnabled ? tx("Follow project (on)") : tx("Follow project (off)"),
    on: tx("On"),
    off: tx("Off"),
  };
  return (
    <MenuRadioGroup
      value={state.choice}
      onValueChange={(value) => {
        const choice = THREAD_ADVISOR_CHOICES.find((candidate) => candidate === value);
        if (choice === undefined || choice === state.choice) return;
        props.onChoose(threadAdvisorModeForChoice(choice));
      }}
    >
      {THREAD_ADVISOR_CHOICES.map((choice) => (
        <MenuRadioItem
          key={choice}
          value={choice}
          hideIndicator
          closeOnClick
          {...(props.kind === "advisor"
            ? { "data-thread-advisor-choice": choice }
            : { "data-thread-review-choice": choice })}
        >
          <span>{labels[choice]}</span>
        </MenuRadioItem>
      ))}
    </MenuRadioGroup>
  );
}

/** The Advisor group's three choices, for a thread whose state is already read. */
export function ThreadAdvisorMenuItems(props: {
  readonly state: ThreadAdvisorMenuState;
  readonly separated: boolean;
  readonly onChoose: (mode: ThreadAdvisorMode | null) => void;
}) {
  const tx = useTx();
  return (
    <div data-thread-advisor-menu={props.state.enabled ? "on" : "off"}>
      {props.separated ? <MenuDivider /> : null}
      <MenuGroup>
        <ThreadChoiceHeader
          title={tx("Advisor")}
          timeNote={tx(ADVISOR_TIME_NOTE)}
          description={tx("Lets this thread ask a stronger model to check its work.")}
        />
        <ThreadChoiceItems kind="advisor" state={props.state} onChoose={props.onChoose} />
      </MenuGroup>
    </div>
  );
}

/** The Adversarial review group's three choices, the same way as Advisor's. */
export function ThreadReviewMenuItems(props: {
  readonly state: ThreadReviewMenuState;
  readonly separated: boolean;
  readonly onChoose: (mode: ThreadReviewMode | null) => void;
}) {
  const tx = useTx();
  return (
    <div data-thread-review-menu={props.state.enabled ? "on" : "off"}>
      {props.separated ? <MenuDivider /> : null}
      <MenuGroup>
        <ThreadChoiceHeader
          title={tx("Adversarial review")}
          timeNote={tx(ADVERSARIAL_REVIEW_TIME_NOTE)}
          description={tx(
            "Has a model from another family review this thread's work when its feature is finished.",
          )}
        />
        <ThreadChoiceItems kind="review" state={props.state} onChoose={props.onChoose} />
      </MenuGroup>
    </div>
  );
}

/**
 * The thread's Advisor and Adversarial review rows. Each shows where the
 * server understands it; neither shows for a draft or an advisor child, and a
 * review thread has no review row.
 */
export function ThreadAdvisorMenu(props: {
  readonly threadRef: ScopedThreadRef;
  readonly separated: boolean;
}) {
  const shell = useThreadShell(props.threadRef);
  const environment = useEnvironment(props.threadRef.environmentId);
  const setAdvisorMode = useOrchestrationCommand(threadEnvironment.setAdvisorMode);
  const setReviewMode = useOrchestrationCommand(threadEnvironment.setReviewMode);
  const config = environment?.serverConfig;
  const settings = config?.settings;
  if (shell === null || settings == null) return null;
  const capabilities = config?.environment?.capabilities;
  const showAdvisor = threadAdvisorMenuVisible({
    capability: capabilities?.advisor === true,
    purpose: shell.source.purpose,
  });
  const showReview = threadReviewMenuVisible({
    capability: capabilities?.threadReviewMode === true,
    purpose: shell.source.purpose,
    title: shell.title,
  });
  if (!showAdvisor && !showReview) return null;
  const projectSettings = resolveProjectSettings(settings, shell.projectId).settings;
  return (
    <>
      {showAdvisor ? (
        <ThreadAdvisorMenuItems
          state={threadAdvisorMenuState(shell.source.advisorMode, projectSettings.advisor)}
          separated={props.separated}
          onChoose={(advisorMode) => {
            void setAdvisorMode({
              environmentId: props.threadRef.environmentId,
              input: { threadId: props.threadRef.threadId, advisorMode },
            });
          }}
        />
      ) : null}
      {showReview ? (
        <ThreadReviewMenuItems
          state={threadReviewMenuState(
            shell.source.reviewMode,
            projectSettings.adversarialReview,
          )}
          separated={props.separated || showAdvisor}
          onChoose={(reviewMode) => {
            void setReviewMode({
              environmentId: props.threadRef.environmentId,
              input: { threadId: props.threadRef.threadId, reviewMode },
            });
          }}
        />
      ) : null}
    </>
  );
}
