import { useEffect, useRef, useState, type RefObject } from "react";
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
  readPendingCopy,
  recordExclusions,
  settledSecrets,
  untickedSecrets,
  type PendingCopy,
  type SecretsChoice,
} from "./handoffFolderCopyPending";
import { useLiveState } from "./handoffFolderCopyRules";
import { refreshSealedRoute, secretsSealed } from "../../studio/copySecretsRoute";
import {
  secretsBlockedNow,
  sendSecretsOrWithdraw,
  useSecretsGate,
  withoutSecrets,
} from "./useSecretsGate";

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
  storageKey,
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
  /** Where the copy's pointer is saved, shared with the other windows on this machine. */
  readonly storageKey: string;
}) {
  const sendSecrets = useAtomCommand(machineHandoff.copySecrets, { reportFailure: false });
  const sendSealed = useAtomCommand(machineHandoff.copySealedSecrets, { reportFailure: false });
  const askRoute = useAtomCommand(machineHandoff.copySecretsRoute, { reportFailure: false });
  const sourceStatus = useAtomCommand(machineHandoff.copySourceStatus, { reportFailure: false });
  // Secrets travel by default (unless only the source's window may send them); unticked
  // files stay out through a new measure or a reopen.
  const [chosen, setChosen, chosenNow] = useLiveState<SecretsChoice>(ALL_SECRETS);
  const gate = useSecretsGate(source, sourceLabel, machine, targetLabel);
  const choice = gate.clamp(settledSecrets(storageKey, chosen));
  const homeSupported = machines.find((entry) => entry.id === machine)?.homeSecretFiles === true;
  const skip = copy ? (repositoryChoices ?? planRepositoryChoices(copy.rows)).skip : [];
  const { candidates, paths } = travellingSecrets({ summary, copy, skip, homeSupported, choice });
  const machinesNow = useRef(machines);
  machinesNow.current = machines;
  /** The list last sent for a copy, which its approval then names to the destination. */
  const sent = useRef<{ operationId: string; paths: ReadonlyArray<string> } | null>(null);

  /** The choice with every exclusion a window recorded: what may leave this one. */
  const settled = (choice?: SecretsChoice | null) =>
    settledSecrets(storageKey, choice ?? chosenNow.current);
  const choose = (next: SecretsChoice) => {
    recordExclusions(storageKey, settled(), next);
    setChosen(next);
    keep(next);
  };
  // Another window recorded an exclusion: show it here too.
  const [, heard] = useState(0);
  useEffect(() => {
    const listen = (event: StorageEvent) => {
      if (event.key === null || event.key.includes("folder-copy-exclusion:")) heard((n) => n + 1);
    };
    window.addEventListener("storage", listen);
    return () => window.removeEventListener("storage", listen);
  }, []);
  /** Leaves out secret files a refresh found that the person never reviewed. */
  const untick = (paths: ReadonlyArray<string>) => {
    const mine = latestPending.current;
    const current = mine ? pendingSecrets(mine) : chosenNow.current;
    // Merged onto the saved copy: another window's exclusions stay out.
    const stored = mine ? readPendingCopy(storageKey) : null;
    const saved = stored && stored.operationId === mine?.operationId ? pendingSecrets(stored) : null;
    const next = untickedSecrets(saved, current, paths);
    if (JSON.stringify(next) !== JSON.stringify(current)) choose(next);
  };

  /**
   * The copy's secrets choice goes to the source before every approval (see sendableSecrets).
   * Included secrets are never approved blind: a summary a reopened copy has not read yet is
   * read first, and when it cannot be read nothing is approved.
   */
  const sendTicked = async (operationId: string) => {
    const saved = latestPending.current;
    const destination = saved?.environmentId ?? machine;
    const there = machinesNow.current.find(({ id }) => id === destination);
    // Read at the call, like the approval: a long run must not send on an older render's
    // access, nor on an older answer about the sealed way to that machine.
    await refreshSealedRoute(source, destination, askRoute);
    const blocked = secretsBlockedNow(source, destination);
    const wanted = settled(saved ? pendingSecrets(saved) : null);
    const sending = blocked ? withoutSecrets(wanted) : wanted;
    if (!summaryNow.current && sending.included && saved) await readSummary(saved);
    if (!summaryNow.current && sending.included) throw new Error(secretsUnreadText(sourceLabel));
    const list = sendableSecrets({
      summary: summaryNow.current,
      plan: copyNow.current,
      repositories: repositoryDraft.current,
      machine: there,
      choice: sending,
    });
    sent.current = null;
    if (!list) return;
    const input = { operationId, paths: list, destinationLabel: there?.label ?? targetLabel };
    await sendSecretsOrWithdraw(
      { blocked, sourceLabel, empty: list.length === 0 },
      {
        // Without access:write the source seals the files to that machine; an empty list
        // only takes staged ones off, which the plain call may do.
        send: () =>
          (list.length > 0 && secretsSealed(source, destination) ? sendSealed : sendSecrets)({
            environmentId: source,
            input,
          }),
        status: () => sourceStatus({ environmentId: source, input: { operationId } }),
      },
    );
    sent.current = { operationId, paths: list };
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
    untick,
    settled,
    sendTicked,
    /** The secret files this dialog sent for that copy, or null when it sent none. */
    sentFor: (operationId: string): ReadonlyArray<string> | null =>
      sent.current?.operationId === operationId ? sent.current.paths : null,
    /** Asks the source again how secrets get to that copy's machine, before a step decides. */
    refreshRoute: (saved: PendingCopy) => refreshSealedRoute(source, saved.environmentId, askRoute),
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
