/**
 * The thread's own rows in the composer's options menu, each with Follow
 * project (the project's setting shown beside it), On and Off:
 * - Advisor: whether this thread may consult a stronger model, and which
 *   model would answer it;
 * - Adversarial review: whether a finished feature on this thread gets a
 *   review by a model from another family.
 * Each row has an info button with what it costs in time.
 */
import { advisorConsultView } from "@specweave-studio/client-runtime/work-log/presentation";
import type {
  AdversarialReviewSettings,
  AdvisorSettings,
  ModelSelection,
  OrchestrationV2ProjectedTurnItem,
  ScopedThreadRef,
  ServerProvider,
  ThreadAdvisorMode,
  ThreadReviewMode,
} from "@specweave-studio/contracts";
import { threadReviewState } from "@specweave-studio/shared/adversarialReview";
import {
  threadAdvisorPreview,
  threadAdvisorState,
  type ThreadAdvisorPreview,
} from "@specweave-studio/shared/advisor";
import { resolveSelectableModel } from "@specweave-studio/shared/model";
import { resolveProjectSettings } from "@specweave-studio/shared/projectSettings";
import { InfoIcon } from "lucide-react";

import { useTx } from "../../i18n";
import { useThreadShell, useThreadVisibleTurnItems } from "../../state/entities";
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

/** What the Advisor row says under its choices about who answers. */
export type ThreadAdvisorNote =
  | {
      readonly kind: "advisor";
      readonly model: string;
      readonly sameModel: boolean;
      /** Who answers a thread past `limit` tokens, when that is another model. */
      readonly pastLimit: string | null;
      readonly limit: number;
    }
  | { readonly kind: "none" }
  /** The app passed no advisor, and Claude's own setting answered with `model`. */
  | { readonly kind: "pass-through"; readonly model: string };

function selectionName(
  selection: ModelSelection,
  providers: ReadonlyArray<ServerProvider>,
): string {
  const provider = providers.find((entry) => entry.instanceId === selection.instanceId);
  return provider?.models.find((model) => model.slug === selection.model)?.name ?? selection.model;
}

/**
 * The model that last answered from Claude Code's own advisor setting on this
 * thread, by its display name. A consult the app passed the advisor for does
 * not count. Only the loaded history is read.
 */
export function latestBuiltInAdvisor(
  items: ReadonlyArray<OrchestrationV2ProjectedTurnItem>,
  providers: ReadonlyArray<ServerProvider>,
): string | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const view = advisorConsultView(items[index]!.item);
    if (view === null || view.fromClaudeSettings !== true || view.advisor === null) continue;
    // Named by its slug, as the timeline's consult row looks it up.
    const slug = view.advisor;
    for (const provider of [
      ...providers.filter((entry) => entry.driver === "claudeAgent"),
      ...providers.filter((entry) => entry.driver !== "claudeAgent"),
    ]) {
      const resolved = resolveSelectableModel(provider.driver, slug, provider.models);
      const name = provider.models.find((model) => model.slug === resolved)?.name;
      if (name !== undefined) return name;
    }
    return slug;
  }
  return null;
}

/**
 * The Advisor row's note: the model that would answer the next consult when
 * the advisor is on, and in pass-through the model Claude's own setting
 * answered with. Off says nothing: the thread consults no one.
 */
export function threadAdvisorNote(input: {
  readonly state: ThreadAdvisorMenuState;
  readonly preview: ThreadAdvisorPreview;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly limit: number;
  readonly passThroughModel: string | null;
}): ThreadAdvisorNote | null {
  if (input.state.enabled) {
    const { advisor, sameModel, pastLimit } = input.preview;
    if (advisor === null) return { kind: "none" };
    return {
      kind: "advisor",
      model: selectionName(advisor, input.providers),
      sameModel,
      pastLimit: pastLimit === null ? null : selectionName(pastLimit, input.providers),
      limit: input.limit,
    };
  }
  if (input.state.choice === "off" || input.passThroughModel === null) return null;
  return { kind: "pass-through", model: input.passThroughModel };
}

function ThreadAdvisorNoteLines(props: { readonly note: ThreadAdvisorNote }) {
  const tx = useTx();
  const { note } = props;
  const lines =
    note.kind === "none"
      ? [tx("No model can advise this thread right now.")]
      : note.kind === "pass-through"
        ? [tx("Claude's own advisor setting answered here: {model}", { model: note.model })]
        : [
            note.sameModel
              ? tx("Advisor: {model}, same model as this thread", { model: note.model })
              : tx("Advisor: {model}", { model: note.model }),
            ...(note.pastLimit === null
              ? []
              : [tx("Past {limit} tokens: {model}", { limit: note.limit, model: note.pastLimit })]),
          ];
  return (
    <div className="px-2 pt-0.5 pb-1.5 text-muted-foreground text-xs" data-thread-advisor-note={note.kind}>
      {lines.map((line) => (
        <div key={line}>{line}</div>
      ))}
    </div>
  );
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
  readonly note?: ThreadAdvisorNote | null;
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
        {props.note ? <ThreadAdvisorNoteLines note={props.note} /> : null}
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
  const turnItems = useThreadVisibleTurnItems(props.threadRef);
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
  const advisorState = threadAdvisorMenuState(shell.source.advisorMode, projectSettings.advisor);
  const providers = config?.providers ?? [];
  // The same rule the session uses, read when the menu opens; the context
  // size is not read, so a long thread's model shows as its own line.
  const note =
    showAdvisor && shell.modelSelection != null
      ? threadAdvisorNote({
          state: advisorState,
          preview: advisorState.enabled
            ? threadAdvisorPreview({
                providers,
                model: projectSettings.advisor.model ?? null,
                lanes: projectSettings.modelLanes,
                sourceOrder: projectSettings.defaultModelProviders,
                excludedModels: projectSettings.providerLimitExcludedModels,
                thread: shell.modelSelection,
                claudeBuiltIn: projectSettings.advisor.claudeBuiltIn,
                nowMs: Date.now(),
              })
            : { advisor: null, sameModel: false, pastLimit: null },
          providers,
          limit: projectSettings.advisor.builtInContextLimit,
          passThroughModel: advisorState.enabled ? null : latestBuiltInAdvisor(turnItems, providers),
        })
      : null;
  return (
    <>
      {showAdvisor ? (
        <ThreadAdvisorMenuItems
          state={advisorState}
          note={note}
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
          state={threadReviewMenuState(shell.source.reviewMode, projectSettings.adversarialReview)}
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
