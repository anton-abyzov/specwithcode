import { useRef, type RefObject } from "react";
import type {
  EnvironmentId,
  FolderCopySourceSummary,
  FolderCopyStatus,
} from "@specweave-studio/contracts";
import { useAtomCommand } from "../../state/use-atom-command";
import { machineHandoff } from "../../studio/machineHandoff";
import type { CopyMachine } from "./HandoffCopySetup";
import { secretsLeft, secretsLeftSendable, secretsLeftText } from "./handoffCopyAuto";
import {
  planRepositoryChoices,
  sendableSecrets,
  travellingSecrets,
  type RepositoryChoices,
} from "./handoffCopySecrets";
import {
  ALL_SECRETS,
  pendingSecrets,
  type PendingCopy,
  type SecretsChoice,
} from "./handoffFolderCopyPending";
import { useLiveState } from "./handoffFolderCopyRules";
import { sendSecretsOrWithdraw, useSecretsGate } from "./useSecretsGate";

/** Said instead of approving when included secrets cannot be listed. */
export const secretsUnreadText = (source: string): string =>
  `The list of secret files could not be read from ${source}. Try again once ${source} is reachable, or untick Secrets to copy without them.`;

/**
 * The copy dialog's secrets: the person's choice, what this window may send, the files that
 * travel, sending them before an approval, and what to say about the ones left behind.
 */
export function useCopySecrets({
  source,
  sourceLabel,
  targetLabel,
  machine,
  machines,
  summary,
  copy,
  summaryNow,
  copyNow,
  repositoryChoices,
  repositoryDraft,
  latestPending,
  done,
  keep,
  readSummary,
}: {
  readonly source: EnvironmentId;
  readonly sourceLabel: string;
  readonly targetLabel: string;
  readonly machine: EnvironmentId | null;
  readonly machines: ReadonlyArray<CopyMachine>;
  readonly summary: FolderCopySourceSummary | null;
  readonly copy: FolderCopyStatus | null;
  readonly summaryNow: RefObject<FolderCopySourceSummary | null>;
  readonly copyNow: RefObject<FolderCopyStatus | null>;
  readonly repositoryChoices: RepositoryChoices | null;
  readonly repositoryDraft: RefObject<RepositoryChoices | null>;
  readonly latestPending: RefObject<PendingCopy | null>;
  /** The copy is finished: say what stayed on the source. */
  readonly done: boolean;
  /** Saves a changed choice on the running copy's pointer, or on the draft when none runs. */
  readonly keep: (choice: SecretsChoice) => void;
  /** Reads the source's summary again; null when it cannot be read. */
  readonly readSummary: (saved: PendingCopy) => Promise<FolderCopySourceSummary | null | undefined>;
}) {
  const sendSecrets = useAtomCommand(machineHandoff.copySecrets, { reportFailure: false });
  const sourceStatus = useAtomCommand(machineHandoff.copySourceStatus, { reportFailure: false });
  // Secrets travel by default (unless only the source's window may send them); unticked
  // files stay out through a new measure or a reopen.
  const [chosen, setChosen, chosenNow] = useLiveState<SecretsChoice>(ALL_SECRETS);
  const gate = useSecretsGate(source, sourceLabel);
  const choice = gate.clamp(chosen);
  const homeSupported = machines.find((entry) => entry.id === machine)?.homeSecretFiles === true;
  const skip = copy ? (repositoryChoices ?? planRepositoryChoices(copy.rows)).skip : [];
  const { candidates, paths } = travellingSecrets({ summary, copy, skip, homeSupported, choice });
  const machinesNow = useRef(machines);
  machinesNow.current = machines;

  const choose = (next: SecretsChoice) => {
    setChosen(next);
    keep(next);
  };

  /**
   * The copy's secrets choice goes to the source before every approval (see sendableSecrets).
   * Included secrets are never approved blind: a summary a reopened copy has not read yet is
   * read first, and when it cannot be read nothing is approved.
   */
  const sendTicked = async (operationId: string) => {
    const saved = latestPending.current;
    const there = machinesNow.current.find(({ id }) => id === (saved?.environmentId ?? machine));
    const sending = gate.clamp(saved ? pendingSecrets(saved) : chosenNow.current);
    if (!summaryNow.current && sending.included && saved) await readSummary(saved);
    if (!summaryNow.current && sending.included) throw new Error(secretsUnreadText(sourceLabel));
    const list = sendableSecrets({
      summary: summaryNow.current,
      plan: copyNow.current,
      repositories: repositoryDraft.current,
      machine: there,
      choice: sending,
    });
    if (!list) return;
    const input = { operationId, paths: list, destinationLabel: there?.label ?? targetLabel };
    await sendSecretsOrWithdraw(
      { blocked: gate.blocked, sourceLabel, empty: list.length === 0 },
      {
        send: () => sendSecrets({ environmentId: source, input }),
        status: () => sourceStatus({ environmentId: source, input: { operationId } }),
      },
    );
  };

  const left = done ? secretsLeft(summary?.secretFiles, copy?.secrets) : 0;
  // A fresh copy with every secret ticked would carry some of what stayed.
  const sendable =
    left > 0 &&
    secretsLeftSendable(
      summary?.secretFiles,
      copy?.secrets,
      travellingSecrets({ summary, copy, skip, homeSupported, choice: ALL_SECRETS }).paths,
    );
  return {
    /** The person's choice, before what this window may send. */
    chosen,
    setChosen,
    gate,
    /** The choice this window works with: none travel when it may not send them. */
    choice,
    candidates,
    paths,
    choose,
    sendTicked,
    /** The pointer of a copy started or approved while the form showed the warning. */
    told: (saved: PendingCopy): PendingCopy =>
      gate.blocked && !saved.secretsStay ? { ...saved, secretsStay: true } : saved,
    /** What stayed on the source once the copy is done, with the action that sends it. */
    leftNote: secretsLeftText(
      left,
      sourceLabel,
      gate.sender === "here" && !sendable ? null : gate.sender,
    ),
    /** A fresh copy from this window would carry some of what stayed. */
    canSendLeft: sendable && gate.sender === "here",
  };
}
