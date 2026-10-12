/**
 * First tasks offered while a project has no threads: what the host found in the
 * project folder and its goal, then the steps that fit any project. Choosing one
 * sends its request to the coordinator, which starts the thread.
 */
import type {
  EnvironmentId,
  ProjectId,
  ProjectKind,
  ProjectStarterSuggestion,
} from "@specweave-studio/contracts";
import {
  buildStarterSuggestions,
  STARTER_SUGGESTION_LIMIT,
  starterComposerHint,
  UNREAD_STARTER_SIGNALS,
} from "@specweave-studio/shared/projectStarterSuggestions";
import {
  ArrowRightLeftIcon,
  ArrowUpRightIcon,
  BlocksIcon,
  BookOpenIcon,
  CheckIcon,
  CompassIcon,
  FlaskConicalIcon,
  GitCommitHorizontalIcon,
  GitCompareIcon,
  ListTodoIcon,
  MilestoneIcon,
  NotebookPenIcon,
  RepeatIcon,
  SparklesIcon,
  TargetIcon,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { useEnvironmentQuery } from "../../../state/query";
import { projectWorkspace } from "../../../studio/projectWorkspace";

const TOPIC_ICONS: Record<ProjectStarterSuggestion["topic"], LucideIcon> = {
  handoff: ArrowRightLeftIcon,
  increment: MilestoneIcon,
  changes: GitCompareIcon,
  goal: TargetIcon,
  tests: FlaskConicalIcon,
  todos: ListTodoIcon,
  commits: GitCommitHorizontalIcon,
  readme: BookOpenIcon,
  explore: CompassIcon,
  memory: NotebookPenIcon,
  routine: RepeatIcon,
  scaffold: BlocksIcon,
  capabilities: SparklesIcon,
};
const ORIGIN_LABELS: Record<ProjectStarterSuggestion["origin"], string> = {
  repository: "From the repository",
  goal: "From your goal",
  specweave: "From SpecWeave",
  common: "Good first step",
};
/**
 * The Threads pane is the only place a project's first tasks are offered, so it
 * lists every one the host found (the builder caps them).
 */
const LIST_LIMIT = STARTER_SUGGESTION_LIMIT;

const COORDINATOR_PLACEHOLDER = "Ask the coordinator a question or start a task…";
const FIRST_TASK_PLACEHOLDER = "Describe a task or ask a question";
/** Counts project views opened, so the hint and the plain prompt take turns between them. */
let placeholderTurns = 0;

/**
 * What the coordinator's empty composer says. A project with no threads asks
 * for a first task, and every other time it is opened, when the host found a
 * file worth reading, offers a Claude Code style "Try" hint instead.
 */
export function coordinatorPlaceholder(input: {
  hasThreads: boolean;
  hint: string | null;
  turn: number;
}): string {
  if (input.hasThreads) return COORDINATOR_PLACEHOLDER;
  return input.hint !== null && input.turn % 2 === 1 ? input.hint : FIRST_TASK_PLACEHOLDER;
}

/** The composer text for this project view; the turn is fixed for as long as it stays open. */
export function useCoordinatorPlaceholder(
  hasThreads: boolean,
  suggestions: readonly ProjectStarterSuggestion[],
): string {
  // Read during render, advanced once per view in an effect: StrictMode runs
  // initializers and effects twice, and the ref keeps the second run from counting.
  const [turn] = useState(() => placeholderTurns);
  const counted = useRef(false);
  useEffect(() => {
    if (counted.current) return;
    counted.current = true;
    placeholderTurns++;
  }, []);
  return coordinatorPlaceholder({
    hasThreads,
    hint: hasThreads ? null : starterComposerHint(suggestions),
    turn,
  });
}

/**
 * The project's starter tasks. The host is asked only while they would be shown;
 * until it answers nothing is offered, and if it cannot answer (an older host,
 * a dropped connection) the general ideas stand in.
 */
export function useStarterSuggestions(input: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  enabled: boolean;
  kind: ProjectKind;
  goal: string;
  hasMemory: boolean;
}): { suggestions: readonly ProjectStarterSuggestion[]; loading: boolean } {
  const query = useEnvironmentQuery(
    input.enabled
      ? projectWorkspace.starterSuggestions({
          environmentId: input.environmentId,
          input: { projectId: input.projectId },
        })
      : null,
  );
  // The host derives its cards from the goal and project memory. Saving either
  // makes the cached answer stale, so ask again as soon as they change. While the
  // cards are hidden the last-asked signature is kept, so showing them again
  // after a change also asks again.
  const signature = `${input.goal.trim()}\u0000${input.hasMemory ? 1 : 0}`;
  const askedFor = useRef(signature);
  const refresh = query.refresh;
  useEffect(() => {
    if (!input.enabled || askedFor.current === signature) return;
    askedFor.current = signature;
    refresh();
  }, [input.enabled, refresh, signature]);
  const found = query.data?.suggestions;
  const general = useMemo(
    () =>
      buildStarterSuggestions({
        ...UNREAD_STARTER_SIGNALS,
        kind: input.kind,
        goal: input.goal,
        hasMemory: input.hasMemory,
      }),
    [input.goal, input.hasMemory, input.kind],
  );
  if (!input.enabled) return { suggestions: [], loading: false };
  if (found) return { suggestions: found, loading: false };
  if (query.isPending && !query.error) return { suggestions: [], loading: true };
  return { suggestions: general, loading: false };
}

export function StarterSuggestions(props: {
  suggestions: readonly ProjectStarterSuggestion[];
  loading: boolean;
  /** Cards beside the coordinator's welcome, or compact rows in the Threads pane. */
  layout: "cards" | "list";
  heading: string;
  /** Why nothing can be sent right now; the ideas stay readable. */
  blocked: string | null;
  /** The suggestion on its way to the coordinator. */
  startingId: string | null;
  startedIds: ReadonlySet<string>;
  onStart: (suggestion: ProjectStarterSuggestion) => void;
}) {
  const shown =
    props.layout === "list" ? props.suggestions.slice(0, LIST_LIMIT) : props.suggestions;
  if (!props.loading && shown.length === 0) return null;
  const headingId = `sws-starters-${props.layout}`;
  return (
    <section
      className="sws-starters"
      data-layout={props.layout}
      aria-labelledby={headingId}
      aria-busy={props.loading}
    >
      <h3 id={headingId}>{props.heading}</h3>
      {props.loading ? (
        <div className="sws-starter-grid" aria-hidden>
          {Array.from({ length: props.layout === "list" ? 3 : 4 }, (_, index) => (
            <span className="sws-starter sws-starter-pending" key={index} />
          ))}
        </div>
      ) : (
        <ul className="sws-starter-grid">
          {shown.map((suggestion) => {
            const Icon = TOPIC_ICONS[suggestion.topic];
            const started = props.startedIds.has(suggestion.id);
            const starting = props.startingId === suggestion.id;
            return (
              <li key={suggestion.id}>
                <button
                  type="button"
                  className="sws-starter"
                  data-origin={suggestion.origin}
                  data-started={started ? "true" : undefined}
                  disabled={started || props.startingId !== null || props.blocked !== null}
                  aria-describedby={`${headingId}-${suggestion.id}`}
                  onClick={() => props.onStart(suggestion)}
                >
                  <span className="sws-starter-icon" aria-hidden>
                    {started ? <CheckIcon /> : <Icon />}
                  </span>
                  <span className="sws-starter-text">
                    <strong>{suggestion.title}</strong>
                    <span id={`${headingId}-${suggestion.id}`}>
                      {started
                        ? "Sent to the coordinator."
                        : starting
                          ? "Sending to the coordinator…"
                          : suggestion.detail}
                    </span>
                  </span>
                  <span className="sws-starter-origin">{ORIGIN_LABELS[suggestion.origin]}</span>
                  <ArrowUpRightIcon className="sws-starter-go" aria-hidden />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {props.blocked && !props.loading ? (
        <p className="sws-starter-note" role="status">
          {props.blocked}
        </p>
      ) : null}
    </section>
  );
}
