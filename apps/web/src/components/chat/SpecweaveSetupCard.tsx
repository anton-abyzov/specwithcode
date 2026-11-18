/**
 * "Set up SpecWeave to plan this" (1396 AC-05, AC-07, AC-09): the card a
 * thread shows when its agent asked for a plan in a project without
 * SpecWeave. It is kept per project on the server and read from the
 * workspace snapshot; the snapshot is read again when a launch tool or
 * `request_specweave_setup` finishes in the thread, when this window's own
 * press returns, and every 5 s while the card reads Setting up.
 *
 * Also the hooks the Board tab and the line above the composer share: one
 * setup press and one answer, with the same outcomes.
 */
import {
  AuthFilesystemWriteScope,
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ProjectId,
  type ProjectSpecweaveAnswer,
  type ProjectWorkspaceReadResult,
  type SpecweaveSetupRequestState,
} from "@specweave-studio/contracts";
import { squashAtomCommandFailure } from "@specweave-studio/client-runtime/state/runtime";
import { useNavigate } from "@tanstack/react-router";
import { KanbanIcon } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";

import { useTx } from "../../i18n";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { projectWorkspaceSearch } from "../../studio/projectPaneThreads";
import { projectWorkspace } from "../../studio/projectWorkspace";
import { requestMachineToolInstall } from "../machineTools/machineToolInstallRequest";
import { useSettingsProjectGroups } from "../settings/useSettingsProjectGroups";
import {
  SPECWEAVE_ADDS,
  SPECWEAVE_ADDS_LABEL,
  SPECWEAVE_CARD_HEADING,
  SPECWEAVE_CARD_TEXT,
  SPECWEAVE_DECLINED_DONE,
  SPECWEAVE_GIT_SENTENCE,
  SPECWEAVE_INSTALL_NODE,
  SPECWEAVE_OPEN_BOARD,
  SPECWEAVE_PLAN_WITHOUT,
  SPECWEAVE_RETRY,
  SPECWEAVE_REVIEW_NOTE,
  SPECWEAVE_SET_UP_DONE,
  SPECWEAVE_SETTING_UP,
  SPECWEAVE_SETTING_UP_POLL_MS,
  specweaveCardShown,
  specweaveCardState,
  specweaveNeedsGitFirst,
  specweavePollWhile,
  specweaveSetupFailureOutcome,
  specweaveSetupLabel,
  specweaveStateReason,
  type SpecweaveLocalOutcome,
  type SpecweaveShownState,
} from "../studio/specweaveSetup.logic";
import {
  ACCESS_BUTTON_ROW_CLASS,
  ACCESS_CARD_CLASS,
  ACCESS_PRIMARY_BUTTON_CLASS,
  ACCESS_SECONDARY_BUTTON_CLASS,
} from "./AccessCardChrome";

// ── Shared wiring ───────────────────────────────────────────────────────

/** The project's workspace snapshot, the one read the project page and every card share. */
export function useSpecweaveSnapshot(
  environmentId: EnvironmentId | null,
  projectId: ProjectId | null,
): {
  readonly snapshot: ProjectWorkspaceReadResult | null;
  readonly refresh: () => void;
} {
  const query = useEnvironmentQuery(
    environmentId !== null && projectId !== null
      ? projectWorkspace.read({ environmentId, input: { projectId } })
      : null,
  );
  return { snapshot: query.data ?? null, refresh: query.refresh };
}

/**
 * One setup press, wherever it is made. A folder without Git gets `initGit`,
 * which every caller shows the AC-05 sentence before. The snapshot is read
 * again when the call returns, so the Board and the card move together.
 */
export function useSpecweaveSetUp(input: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly gitRepository: boolean | undefined;
  readonly requestId?: string | undefined;
  readonly onSettled: () => void;
}): {
  readonly outcome: SpecweaveLocalOutcome | null;
  readonly run: () => Promise<boolean>;
  readonly clear: () => void;
} {
  const setUp = useAtomCommand(projectWorkspace.specweaveSetUp, { reportFailure: false });
  // The outcome belongs to the card it was pressed for: a new card (another
  // `requestId`) starts clean instead of showing an old failure.
  const [pressed, setPressed] = useState<{
    readonly outcome: SpecweaveLocalOutcome | null;
    readonly requestId: string | undefined;
  }>({ outcome: null, requestId: undefined });
  const inFlight = useRef(false);
  const { environmentId, projectId, gitRepository, requestId, onSettled } = input;
  const run = useCallback(async () => {
    if (inFlight.current) return false;
    inFlight.current = true;
    const setOutcome = (outcome: SpecweaveLocalOutcome | null) =>
      setPressed({ outcome, requestId });
    setOutcome({ state: "setting_up" });
    try {
      const result = await setUp({
        environmentId,
        input: {
          projectId,
          ...(gitRepository === false ? { initGit: true } : {}),
          ...(requestId === undefined ? {} : { requestId }),
        },
      });
      if (result._tag === "Failure") {
        setOutcome(specweaveSetupFailureOutcome(squashAtomCommandFailure(result)));
        return false;
      }
      // A card keeps reading Setting up until the snapshot read again says On;
      // elsewhere the surface that pressed goes away with the off state.
      setOutcome(requestId === undefined ? null : { state: "setting_up" });
      return true;
    } catch (cause) {
      setOutcome(specweaveSetupFailureOutcome(cause));
      return false;
    } finally {
      inFlight.current = false;
      onSettled();
    }
  }, [environmentId, gitRepository, onSettled, projectId, requestId, setUp]);
  const clear = useCallback(() => setPressed({ outcome: null, requestId: undefined }), []);
  return { outcome: pressed.requestId === requestId ? pressed.outcome : null, run, clear };
}

/** "Plan without it", "Not now" and the composer line; resolves with an error message or null. */
export function useSpecweaveAnswer(input: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly onSettled: () => void;
}): (answer: ProjectSpecweaveAnswer, requestId?: string) => Promise<string | null> {
  const answerCommand = useAtomCommand(projectWorkspace.specweaveAnswer, { reportFailure: false });
  const { environmentId, projectId, onSettled } = input;
  return useCallback(
    async (answer, requestId) => {
      try {
        const result = await answerCommand({
          environmentId,
          input: { projectId, answer, ...(requestId === undefined ? {} : { requestId }) },
        });
        if (result._tag === "Failure") return "The answer was not saved. Try again.";
        return null;
      } catch {
        return "The answer was not saved. Try again.";
      } finally {
        onSettled();
      }
    },
    [answerCommand, environmentId, onSettled, projectId],
  );
}

/** Opens the project's page on its Board tab, from a thread on any page. */
export function useOpenProjectBoard(
  environmentId: EnvironmentId | null,
  projectId: ProjectId | null,
): (() => void) | null {
  const navigate = useNavigate();
  const groups = useSettingsProjectGroups();
  const group = groups.find((candidate) =>
    candidate.memberProjects.some(
      (member) => member.environmentId === environmentId && member.id === projectId,
    ),
  );
  const projectKey = group?.projectKey ?? null;
  const open = useCallback(() => {
    if (projectKey === null || environmentId === null || projectId === null) return;
    void navigate({
      to: "/projects/$projectKey",
      params: { projectKey },
      search: { ...projectWorkspaceSearch(null, `${environmentId}:${projectId}`), pane: "board" },
    });
  }, [environmentId, navigate, projectId, projectKey]);
  return projectKey === null ? null : open;
}

// ── The card ────────────────────────────────────────────────────────────

/**
 * The card in its thread, read from the snapshot. It shows only in the thread
 * that asked; an open card stays answerable and blocks nothing else.
 */
export function SpecweaveSetupCard({
  environmentId,
  projectId,
  threadId,
  toolKey,
  lastUserMessageAt,
  onShown,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly threadId: string;
  /** Changes when a launch tool or `request_specweave_setup` finishes in the thread. */
  readonly toolKey: string;
  readonly lastUserMessageAt: string | null;
  /** The card appeared or changed state, so a list that follows its end can follow it. */
  readonly onShown?: (() => void) | undefined;
}) {
  const { snapshot, refresh } = useSpecweaveSnapshot(environmentId, projectId);
  const request = snapshot?.specweaveSetupRequest;
  const canWrite = useEnvironmentScope(environmentId, AuthFilesystemWriteScope);
  const canAnswer = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  // The folder's Git state as read now, not when the card was raised; an older
  // server that refused a folder outside Git turns the press into "Set up Git
  // and SpecWeave" instead of a Retry that repeats the refusal.
  const [offerGit, setOfferGit] = useState(false);
  const gitRepository = offerGit
    ? false
    : (snapshot?.gitRepository ?? request?.gitRepository ?? true);
  const setUp = useSpecweaveSetUp({
    environmentId,
    projectId,
    gitRepository,
    requestId: request?.requestId,
    onSettled: refresh,
  });
  if (specweaveNeedsGitFirst(setUp.outcome, gitRepository)) {
    setOfferGit(true);
    setUp.clear();
  }
  const answer = useSpecweaveAnswer({ environmentId, projectId, onSettled: refresh });
  const openBoard = useOpenProjectBoard(environmentId, projectId);
  const [answerError, setAnswerError] = useState<string | null>(null);
  const [answering, setAnswering] = useState(false);

  // A tool that may have raised the card finished: read the snapshot again.
  const lastToolKey = useRef(toolKey);
  useEffect(() => {
    if (lastToolKey.current === toolKey) return;
    lastToolKey.current = toolKey;
    refresh();
  }, [refresh, toolKey]);

  const shown = request ? specweaveCardState({ request, local: setUp.outcome, canWrite }) : null;
  // No server push exists: while the card reads Setting up, ask every 5 s.
  const polling = specweavePollWhile(request?.state) || shown?.state === "setting_up";
  useEffect(() => {
    if (!polling) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, SPECWEAVE_SETTING_UP_POLL_MS);
    return () => window.clearInterval(timer);
  }, [polling, refresh]);

  const visible = specweaveCardShown({ request, threadId, lastUserMessageAt });
  const shownState = visible ? (shown?.state ?? null) : null;
  useEffect(() => {
    if (shownState !== null) onShown?.();
  }, [onShown, shownState]);
  if (!visible || request === undefined || shown === null) return null;

  return (
    <SpecweaveSetupCardView
      shown={shown}
      gitRepository={gitRepository}
      canAnswer={canAnswer}
      answering={answering}
      answerError={answerError}
      onSetUp={() => void setUp.run()}
      onPlanWithout={async () => {
        setAnswering(true);
        setAnswerError(await answer("plan_without", request.requestId));
        setAnswering(false);
      }}
      onInstallNode={() =>
        requestMachineToolInstall({ environmentId, tool: "node", machineLabel: null })
      }
      onOpenBoard={openBoard}
    />
  );
}

/** The card itself, in each of its seven states. Pure, for tests and fixtures. */
export function SpecweaveSetupCardView(props: {
  readonly shown: SpecweaveShownState;
  readonly gitRepository: boolean;
  /** The window may answer at all (Plan without it); setup itself needs file access. */
  readonly canAnswer: boolean;
  readonly answering?: boolean;
  readonly answerError?: string | null;
  readonly onSetUp: () => void;
  readonly onPlanWithout: () => void;
  readonly onInstallNode: () => void;
  /** Absent where this window cannot open the project's page. */
  readonly onOpenBoard: (() => void) | null;
}) {
  const tx = useTx();
  const titleId = useId();
  const { shown } = props;
  const state: SpecweaveSetupRequestState = shown.state;
  const settled = state === "on" || state === "declined";
  const reason = specweaveStateReason(shown);
  const busy = state === "setting_up" || props.answering === true;
  const title =
    state === "on"
      ? tx("SpecWeave is set up")
      : state === "declined"
        ? tx("Planning without SpecWeave")
        : tx(SPECWEAVE_CARD_HEADING);
  // Filled after mount, so screen readers announce the card when it appears
  // and again when it settles.
  const [announcement, setAnnouncement] = useState("");
  useEffect(() => {
    setAnnouncement(title);
  }, [title]);
  const planWithout =
    props.canAnswer && !settled ? (
      <button
        type="button"
        className={ACCESS_SECONDARY_BUTTON_CLASS}
        disabled={busy}
        onClick={props.onPlanWithout}
      >
        {tx(SPECWEAVE_PLAN_WITHOUT)}
      </button>
    ) : null;
  return (
    <section
      className={ACCESS_CARD_CLASS}
      aria-labelledby={titleId}
      aria-busy={state === "setting_up" || undefined}
      data-specweave-card=""
      data-state={state}
    >
      <p className="sr-only" role="status" aria-live="polite" data-specweave-announcement="">
        {announcement}
      </p>
      <header className="flex min-w-0 items-start gap-2">
        <span aria-hidden className="flex h-5 shrink-0 items-center text-access-tile">
          <KanbanIcon className="size-4" strokeWidth={2.25} />
        </span>
        <h3 id={titleId} className="min-w-0 text-sm/5 font-medium text-foreground wrap-break-word">
          {title}
        </h3>
      </header>
      <div className="flex min-w-0 flex-col gap-1.5 ps-6 text-xs/5 text-muted-foreground">
        {state === "on" ? (
          <p>{tx(SPECWEAVE_SET_UP_DONE)}</p>
        ) : state === "declined" ? (
          <p>{tx(SPECWEAVE_DECLINED_DONE)}</p>
        ) : (
          <>
            <p>{tx(SPECWEAVE_CARD_TEXT)}</p>
            <details className="min-w-0">
              <summary className="w-fit cursor-pointer font-medium text-foreground">
                {tx(SPECWEAVE_ADDS_LABEL)}
              </summary>
              <ul className="mt-1 list-disc ps-4" data-specweave-adds="">
                {SPECWEAVE_ADDS.map((line) => (
                  <li key={line}>{tx(line)}</li>
                ))}
              </ul>
              <p className="mt-1">{tx(SPECWEAVE_REVIEW_NOTE)}</p>
            </details>
            {props.gitRepository ? null : <p data-specweave-git="">{tx(SPECWEAVE_GIT_SENTENCE)}</p>}
            {state === "setting_up" ? (
              <p role="status" className="text-foreground">
                {tx(SPECWEAVE_SETTING_UP)}
              </p>
            ) : null}
            {reason ? (
              <p role="alert" className="text-destructive-foreground wrap-break-word">
                {reason}
              </p>
            ) : null}
          </>
        )}
        {props.answerError ? (
          <p role="alert" className="text-destructive-foreground">
            {tx(props.answerError)}
          </p>
        ) : null}
      </div>
      {state === "declined" || (state === "on" && props.onOpenBoard === null) ? null : (
        <div className={`${ACCESS_BUTTON_ROW_CLASS} ps-6`}>
          {state === "on" && props.onOpenBoard ? (
            <button
              type="button"
              className={ACCESS_PRIMARY_BUTTON_CLASS}
              onClick={props.onOpenBoard}
            >
              {tx(SPECWEAVE_OPEN_BOARD)}
            </button>
          ) : null}
          {state === "asking" || state === "setting_up" ? (
            <button
              type="button"
              className={ACCESS_PRIMARY_BUTTON_CLASS}
              disabled={busy}
              onClick={props.onSetUp}
            >
              {tx(specweaveSetupLabel("set_up", props.gitRepository))}
            </button>
          ) : null}
          {state === "node_missing" ? (
            <button
              type="button"
              className={ACCESS_PRIMARY_BUTTON_CLASS}
              onClick={props.onInstallNode}
            >
              {tx(SPECWEAVE_INSTALL_NODE)}
            </button>
          ) : null}
          {state === "failed" || state === "node_missing" ? (
            <button
              type="button"
              className={
                state === "failed" ? ACCESS_PRIMARY_BUTTON_CLASS : ACCESS_SECONDARY_BUTTON_CLASS
              }
              disabled={busy}
              onClick={props.onSetUp}
            >
              {tx(SPECWEAVE_RETRY)}
            </button>
          ) : null}
          {planWithout}
        </div>
      )}
    </section>
  );
}
