/**
 * The one line above the coordinator's composer for a project whose folder is
 * not set up for SpecWeave (1396 AC-18): "Plan this project's work on a
 * board.", with "Set up SpecWeave", "See the board" and a dismiss. Any of the
 * three marks the advice seen, so it never returns; the dismiss also declines.
 * It takes no focus and sits in the flow, so it covers nothing. Nothing in the
 * folder changes without the press.
 */
import {
  AuthFilesystemWriteScope,
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ProjectId,
} from "@specweave-studio/contracts";
import { KanbanIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { useTx } from "../../i18n";
import { useEnvironmentScope } from "../../state/session";
import { requestMachineToolInstall } from "../machineTools/machineToolInstallRequest";
import {
  SPECWEAVE_GIT_SENTENCE,
  SPECWEAVE_INSTALL_NODE,
  SPECWEAVE_OFFER_DISMISS,
  SPECWEAVE_OFFER_SEE_BOARD,
  SPECWEAVE_OFFER_TEXT,
  SPECWEAVE_SETTING_UP,
  incrementBoardNote,
  specweaveSetupLabel,
  specweaveStateOf,
  specweaveStateReason,
  type SpecweaveLocalOutcome,
} from "../studio/specweaveSetup.logic";
import { Button } from "../ui/button";
import { specweaveOfferApplies } from "./composerNotice.logic";
import {
  useOpenProjectBoard,
  useSpecweaveAnswer,
  useSpecweaveSetUp,
  useSpecweaveSnapshot,
} from "./SpecweaveSetupCard";

/** The line for the coordinator of this project, when it applies; null otherwise. */
export function SpecweaveOffer({
  environmentId,
  projectId,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}) {
  const { snapshot, refresh } = useSpecweaveSnapshot(environmentId, projectId);
  const canAnswer = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const canWrite = useEnvironmentScope(environmentId, AuthFilesystemWriteScope);
  const setUp = useSpecweaveSetUp({
    environmentId,
    projectId,
    gitRepository: snapshot?.gitRepository,
    onSettled: refresh,
  });
  const answer = useSpecweaveAnswer({ environmentId, projectId, onSettled: refresh });
  const openBoard = useOpenProjectBoard(environmentId, projectId);
  // Pressed here: the line stays while setup runs or has failed, though the
  // advice is already marked seen, so the reason and Retry are not lost.
  const [held, setHeld] = useState(false);
  const [gone, setGone] = useState(false);
  // An answer the server did not store: the line comes back with the reason,
  // so a dismiss that failed is not taken for one that held.
  const [answerError, setAnswerError] = useState<string | null>(null);
  const answerAndHide = (choice: "advice_seen" | "advice_dismissed") => {
    setGone(true);
    setAnswerError(null);
    void answer(choice).then((error) => {
      if (error === null) return;
      setAnswerError(error);
      setGone(false);
    });
  };
  const applies = specweaveOfferApplies({ snapshot, coordinator: true, canAnswer });
  if (gone || !(applies || answerError !== null || (held && setUp.outcome !== null))) return null;
  return (
    <SpecweaveOfferView
      gitRepository={snapshot?.gitRepository}
      outcome={setUp.outcome}
      answerError={answerError}
      canSetUp={canWrite}
      onSetUp={() => {
        setHeld(true);
        void setUp.run().then((ok) => {
          void answer("advice_seen");
          if (ok) setGone(true);
        });
      }}
      onSeeBoard={
        openBoard
          ? () => {
              answerAndHide("advice_seen");
              openBoard();
            }
          : null
      }
      onInstallNode={() =>
        requestMachineToolInstall({ environmentId, tool: "node", machineLabel: null })
      }
      onDismiss={() => answerAndHide("advice_dismissed")}
    />
  );
}

/** The line itself. Pure, for tests and fixtures. */
export function SpecweaveOfferView(props: {
  readonly gitRepository: boolean | undefined;
  readonly outcome: SpecweaveLocalOutcome | null;
  /** The last answer was not stored. */
  readonly answerError?: string | null | undefined;
  /** The window may change files on the machine; without it only the board and dismiss show. */
  readonly canSetUp: boolean;
  readonly onSetUp: () => void;
  readonly onSeeBoard: (() => void) | null;
  readonly onInstallNode: () => void;
  readonly onDismiss: () => void;
}) {
  const tx = useTx();
  const settingUp = props.outcome?.state === "setting_up";
  const reason = props.outcome ? specweaveStateReason(props.outcome) : null;
  return (
    <div
      role="note"
      data-specweave-offer=""
      data-state={props.outcome?.state ?? "asking"}
      className="mb-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border border-border/70 bg-card px-3 py-1.5 text-sm dark:border-white/[0.08]"
    >
      <KanbanIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 text-foreground">
        {tx(SPECWEAVE_OFFER_TEXT)}
        {props.gitRepository === false ? (
          <span className="ms-1 text-muted-foreground" data-specweave-git="">
            {tx(SPECWEAVE_GIT_SENTENCE)}
          </span>
        ) : null}
        {settingUp ? (
          <span role="status" className="ms-1 text-muted-foreground">
            {tx(SPECWEAVE_SETTING_UP)}
          </span>
        ) : null}
        {reason ? (
          <span role="alert" className="ms-1 text-destructive-foreground wrap-break-word">
            {reason}
          </span>
        ) : null}
        {props.answerError ? (
          <span role="alert" className="ms-1 text-destructive-foreground wrap-break-word">
            {tx(props.answerError)}
          </span>
        ) : null}
      </span>
      <span className="flex shrink-0 items-center gap-1">
        {props.outcome?.state === "node_missing" ? (
          <Button size="xs" variant="outline" onClick={props.onInstallNode}>
            {tx(SPECWEAVE_INSTALL_NODE)}
          </Button>
        ) : null}
        {props.canSetUp ? (
          <Button size="xs" variant="outline" disabled={settingUp} onClick={props.onSetUp}>
            {tx(specweaveSetupLabel("set_up", props.gitRepository))}
          </Button>
        ) : null}
        {props.onSeeBoard ? (
          <Button size="xs" variant="ghost" disabled={settingUp} onClick={props.onSeeBoard}>
            {tx(SPECWEAVE_OFFER_SEE_BOARD)}
          </Button>
        ) : null}
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={tx(SPECWEAVE_OFFER_DISMISS)}
          title={tx(SPECWEAVE_OFFER_DISMISS)}
          disabled={settingUp}
          onClick={props.onDismiss}
        >
          <XIcon aria-hidden />
        </Button>
      </span>
    </div>
  );
}

/**
 * "Not on the board yet" for a thread's increment while the project's setup
 * is unfinished (1396 AC-13), and what pressing it does: open the Board tab,
 * which shows the unfinished state. Null in a project that is on.
 */
export function useIncrementBoardNote(
  environmentId: EnvironmentId | null,
  projectId: ProjectId | null,
): { readonly label: string; readonly open: (() => void) | null } | null {
  const tx = useTx();
  const { snapshot } = useSpecweaveSnapshot(environmentId, projectId);
  const open = useOpenProjectBoard(environmentId, projectId);
  const note = incrementBoardNote(specweaveStateOf(snapshot));
  return note === null ? null : { label: tx(note), open };
}

export const NOT_ON_BOARD_TITLE = "Open the Board to finish SpecWeave setup";

/** The note beside the thread header's increment. */
export function NotOnBoardNote({
  environmentId,
  projectId,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}) {
  const tx = useTx();
  const note = useIncrementBoardNote(environmentId, projectId);
  if (note === null) return null;
  if (note.open === null)
    return (
      <span className="text-xs text-muted-foreground" data-not-on-board="">
        {note.label}
      </span>
    );
  return (
    <Button
      size="micro"
      variant="outline"
      data-not-on-board=""
      title={tx(NOT_ON_BOARD_TITLE)}
      onClick={note.open}
    >
      {note.label}
    </Button>
  );
}
