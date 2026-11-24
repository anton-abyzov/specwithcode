/**
 * "Use my Percy on <machine>" (1448 D-12, AC-22): the owner's switch for the
 * window's own machine, the account's machines with each one's state, and
 * "Undo the merge". Percy belongs to the SpecWithCode Connect account; each
 * machine joins once its own switch is on, and the servers link themselves.
 *
 * The switch is saved by `personalLink.setShared` on the machine it changes,
 * never through the general settings update, and needs settings write there.
 *
 * @module PercySharedSetting
 */
import { squashAtomCommandFailure } from "@specweave-studio/client-runtime/state/runtime";
import {
  AuthSettingsWriteScope,
  type EnvironmentId,
  type PersonalShareStatus,
} from "@specweave-studio/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { usePrimarySettings } from "~/hooks/useSettings";

import { useTx } from "../../i18n";
import { useProjects } from "../../state/entities";
import {
  useEnvironments,
  usePrimaryEnvironmentId,
  useRelayEnvironmentDiscovery,
} from "../../state/environments";
import { useEnvironmentScopeAccess, useEnvironmentsScopeAccess } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { useMachineNicknames } from "../../studio/machineNickname";
import {
  findMachineAssistant,
  personalRoutineRunnerOf,
  USE_MY_PERCY_PHRASE,
} from "../../studio/personalAssistant";
import {
  newestBeforeLinkRestorePoint,
  PERCY_SHARED_DESCRIPTION,
  shareAccessBlockedText,
  shareConfirmCalls,
  shareMachineRows,
  shareMachineStateText,
  shareRefusalText,
  type ShareSeat,
} from "../../studio/personalShare";
import {
  personalLinkPreviewCommand,
  personalShareStatusCommand,
  setPersonalSharedCommand,
  undoPersonalShareCommand,
} from "../../studio/personalShareCommands";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Switch } from "../ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import {
  PercySharedConfirmDialog,
  type ShareCandidate,
  type ShareConfirmChoice,
} from "./PercySharedConfirmDialog";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const failureText = (failure: unknown): string =>
  failure instanceof Error
    ? failure.message
    : typeof failure === "object" && failure !== null && "message" in failure
      ? String((failure as { readonly message: unknown }).message)
      : String(failure);

const longDate = (iso: string): string => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleDateString(undefined, { dateStyle: "long" });
};

/**
 * The machines the relay lists under this window's signed-in Connect account.
 * The list is empty while it is read again, so the last settled one is kept;
 * signing in to another account clears it.
 */
function useConnectAccountMachineIds(): ReadonlySet<string> {
  const discovery = useRelayEnvironmentDiscovery();
  const settled = useRef(discovery.environments);
  if (!discovery.refreshing) settled.current = discovery.environments;
  const environments = settled.current;
  return useMemo(() => new Set(environments.keys()), [environments]);
}

export function PercySharedSetting() {
  const tx = useTx();
  const ownId = usePrimaryEnvironmentId();
  const { environments } = useEnvironments();
  const nickname = useMachineNicknames();
  const projects = useProjects();
  const saved = usePrimarySettings((settings) => settings.personalAssistantShared);
  const aideEnabled = usePrimarySettings((settings) => settings.aideEnabled);
  const ownAccess = useEnvironmentScopeAccess(ownId, AuthSettingsWriteScope);
  const otherIds = useMemo(
    () =>
      environments
        .map((environment) => environment.environmentId)
        .filter((environmentId) => environmentId !== ownId),
    [environments, ownId],
  );
  const otherAccess = useEnvironmentsScopeAccess(otherIds, AuthSettingsWriteScope);
  const accountIds = useConnectAccountMachineIds();
  const readStatus = useAtomCommand(personalShareStatusCommand, { reportFailure: false });
  const setShared = useAtomCommand(setPersonalSharedCommand, { reportFailure: false });
  const undoShare = useAtomCommand(undoPersonalShareCommand, { reportFailure: false });
  const readPreview = useAtomCommand(personalLinkPreviewCommand, { reportFailure: false });

  const [status, setStatus] = useState<PersonalShareStatus | null>(null);
  // A change that failed, kept until the next change; a failed read is said apart from it.
  const [error, setError] = useState<string | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<"confirm" | "undo" | null>(null);
  const [counts, setCounts] = useState<Readonly<Record<string, number | null>> | null>(null);

  const labelOf = useCallback(
    (environmentId: string, fallback: string | null = null) => {
      const label = environments.find((e) => e.environmentId === environmentId)?.label ?? fallback;
      const name = nickname(environmentId, label);
      return label || name !== environmentId ? name : (fallback ?? environmentId);
    },
    [environments, nickname],
  );
  const ownLabel =
    ownId === null ? tx("this machine") : labelOf(ownId, status?.machineLabel ?? null);
  const access = ownId === null ? "no-machine" : ownAccess;
  const canChange = access === "granted";
  // A machine the window reaches with settings write: its switch can be changed from here.
  const writable = useMemo(
    () =>
      new Set<string>(
        environments
          .filter(
            (environment) =>
              environment.environmentId !== ownId &&
              environment.connection.phase === "connected" &&
              otherAccess.get(environment.environmentId) === "granted",
          )
          .map((environment) => environment.environmentId),
      ),
    [environments, otherAccess, ownId],
  );

  const refresh = useCallback(async () => {
    if (ownId === null || !canChange) return;
    const result = await readStatus({ environmentId: ownId, input: {} });
    if (result._tag === "Success") {
      setStatus(result.value);
      setReadError(null);
    } else setReadError(failureText(squashAtomCommandFailure(result)));
  }, [canChange, ownId, readStatus]);
  // Read again when the saved switch changes: the command line and another window change it too.
  const savedKey = `${saved?.enabled === true} ${(saved?.machines ?? []).join(" ")}`;
  useEffect(() => {
    void refresh();
  }, [refresh, savedKey]);

  const checked = status?.enabled ?? saved?.enabled === true;
  const refusal = status?.refusal ?? (aideEnabled === false ? "assistant_off" : null);
  const blocked = shareAccessBlockedText(access, ownLabel);
  const refused = shareRefusalText(refusal, ownLabel);

  // Each machine's own assistant: the earliest live personal project there.
  const liveAssistants = useMemo(
    () =>
      projects.filter(
        (project) =>
          project.workspaceSettings?.kind === "personal" &&
          project.workspaceSettings.archived !== true,
      ),
    [projects],
  );
  const seatOf = (environmentId: string) => findMachineAssistant(liveAssistants, environmentId);
  const candidates = useMemo((): ShareCandidate[] => {
    const byId = new Map<string, ShareCandidate>();
    for (const environmentId of otherIds) {
      byId.set(environmentId, {
        environmentId,
        label: labelOf(environmentId),
        writable: writable.has(environmentId),
        blocked: null,
        account: accountIds.has(environmentId),
      });
    }
    // Machines this machine's server knows from its own grants, saved in this window or not.
    for (const machine of status?.machines ?? []) {
      if (machine.environmentId === ownId) continue;
      const label = labelOf(machine.environmentId, machine.label);
      byId.set(machine.environmentId, {
        environmentId: machine.environmentId,
        label,
        writable: writable.has(machine.environmentId),
        blocked:
          machine.state === "other_account" ? shareMachineStateText(machine.state, label) : null,
        account:
          machine.state !== "other_account" &&
          (machine.state === "joined" || accountIds.has(machine.environmentId)),
      });
    }
    return [...byId.values()];
  }, [accountIds, labelOf, otherIds, ownId, status?.machines, writable]);
  const seats = useMemo((): ShareSeat[] => {
    if (ownId === null) return [];
    return [ownId, ...candidates.map((machine) => machine.environmentId)].flatMap(
      (environmentId) => {
        const seat = findMachineAssistant(liveAssistants, environmentId);
        return seat
          ? [
              {
                environmentId,
                title: seat.title,
                linked: (seat.workspaceSettings?.logicalProject?.members.length ?? 0) > 1,
                memoryFileCount: counts?.[environmentId] ?? null,
              },
            ]
          : [];
      },
    );
  }, [candidates, counts, liveAssistants, ownId]);

  const openConfirm = () => {
    setDialogError(null);
    setCounts(null);
    setDialog("confirm");
    if (ownId === null) return;
    // The "Start from" default is the assistant with the most memory files.
    const toRead = [ownId, ...candidates.map((machine) => machine.environmentId)].flatMap(
      (environmentId) => {
        const seat = seatOf(environmentId);
        return seat ? [{ environmentId, projectId: seat.id }] : [];
      },
    );
    void Promise.all(
      toRead.map(async ({ environmentId, projectId }) => {
        const result = await readPreview({ environmentId, input: { projectId } });
        return [
          environmentId,
          result._tag === "Success" ? result.value.memoryFileCount : null,
        ] as const;
      }),
    ).then((entries) => setCounts(Object.fromEntries(entries)));
  };

  const confirm = async (choice: ShareConfirmChoice) => {
    if (ownId === null) return;
    const { calls } = shareConfirmCalls({
      ownEnvironmentId: ownId,
      ticked: choice.ticked,
      writable,
      startEnvironmentId: choice.startEnvironmentId,
      name: choice.name,
    });
    setBusy(true);
    setDialogError(null);
    const failed: string[] = [];
    for (const call of calls) {
      const result = await setShared({ environmentId: call.environmentId, input: call.input });
      if (result._tag === "Success") {
        if (call.environmentId === ownId) setStatus(result.value);
        continue;
      }
      const message = failureText(squashAtomCommandFailure(result));
      if (call.environmentId === ownId) {
        // Nothing else is turned on while this machine refused.
        setBusy(false);
        setDialogError(message);
        return;
      }
      failed.push(`${labelOf(call.environmentId)}: ${message}`);
    }
    setBusy(false);
    setDialog(null);
    setError(
      failed.length > 0
        ? tx("It is on here. These machines did not take it: {machines}", {
            machines: failed.join("; "),
          })
        : null,
    );
    await refresh();
  };

  const turnOff = async () => {
    if (ownId === null) return;
    setBusy(true);
    const result = await setShared({ environmentId: ownId, input: { enabled: false } });
    setBusy(false);
    if (result._tag === "Success") {
      setStatus(result.value);
      setError(null);
    } else setError(failureText(squashAtomCommandFailure(result)));
  };

  // Another machine's switch, through that machine's own session (1448 AC-22).
  const turnOnMachine = async (environmentId: EnvironmentId) => {
    if (ownId === null) return;
    const confirmed = (saved?.machines ?? []).filter((id) => id !== environmentId);
    setBusy(true);
    const there = await setShared({
      environmentId,
      input: { enabled: true, machines: [ownId, ...confirmed] },
    });
    if (there._tag !== "Success") {
      setBusy(false);
      setError(`${labelOf(environmentId)}: ${failureText(squashAtomCommandFailure(there))}`);
      return;
    }
    // This machine lists it too, with its own switch left as it is.
    const here = await setShared({
      environmentId: ownId,
      input: { enabled: checked, machines: [...confirmed, environmentId] },
    });
    setBusy(false);
    if (here._tag === "Success") {
      setStatus(here.value);
      setError(null);
    } else setError(failureText(squashAtomCommandFailure(here)));
    await refresh();
  };

  const restorePoint = newestBeforeLinkRestorePoint(status);
  const undo = async () => {
    if (ownId === null) return;
    setBusy(true);
    setDialogError(null);
    const result = await undoShare({ environmentId: ownId, input: {} });
    setBusy(false);
    if (result._tag !== "Success") {
      setDialogError(failureText(squashAtomCommandFailure(result)));
      return;
    }
    setStatus(result.value);
    setError(null);
    setDialog(null);
  };

  const linkedSeats = liveAssistants.filter(
    (project) => (project.workspaceSettings?.logicalProject?.members.length ?? 0) > 1,
  );
  const rows = status
    ? shareMachineRows({
        status,
        labelOf,
        runnerEnvironmentId: personalRoutineRunnerOf(linkedSeats)?.environmentId ?? null,
        canTurnOn: (environmentId) => writable.has(environmentId),
      })
    : [];
  const anchor = searchableSetting("percy-shared");
  const title = tx(USE_MY_PERCY_PHRASE, { machine: ownLabel });
  const note = blocked ?? (checked ? null : refused);

  return (
    <>
      <SettingsRow
        id={anchor.id}
        title={title}
        literal
        // A node, so the full text stays in view on a compact page.
        description={<>{tx(PERCY_SHARED_DESCRIPTION, { machine: ownLabel })}</>}
        status={
          note || error || readError ? (
            <span className="grid gap-0.5">
              {note ? (
                <span role="status" data-percy-shared-note>
                  {tx(note.text, note.values)}
                </span>
              ) : null}
              {(error ?? readError) ? (
                <span role="alert" className="text-error-foreground" data-percy-shared-error>
                  {error ?? readError}
                </span>
              ) : null}
            </span>
          ) : null
        }
        control={
          <Switch
            checked={checked}
            disabled={!canChange || busy || (!checked && refused !== null)}
            onCheckedChange={(next) => (next ? openConfirm() : void turnOff())}
            aria-label={title}
          />
        }
      >
        {status ? (
          <div className="mt-3 grid gap-3 pb-2" data-percy-shared-machines>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{tx("Machine")}</TableHead>
                  <TableHead>{tx("Percy")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.environmentId} data-share-machine={row.environmentId}>
                    <TableCell className="align-top whitespace-normal">
                      {row.label}
                      {row.own ? (
                        <span className="text-muted-foreground"> {tx("(this machine)")}</span>
                      ) : null}
                    </TableCell>
                    <TableCell className="align-top whitespace-normal">
                      <span className="grid gap-0.5">
                        <span
                          className={row.on ? "text-success-foreground" : undefined}
                          data-share-state
                        >
                          {tx(row.state.text, row.state.values)}
                        </span>
                        {row.detail ? (
                          <span className="text-muted-foreground">{row.detail}</span>
                        ) : null}
                        {row.runsRoutines ? (
                          <span className="text-muted-foreground" data-share-runner>
                            {tx("Runs the shared routines")}
                          </span>
                        ) : null}
                        {row.lastSyncedAt ? (
                          <span className="text-muted-foreground" data-share-synced>
                            {tx("Memory in step {when}", {
                              when: formatRelativeTimeLabel(row.lastSyncedAt),
                            })}
                          </span>
                        ) : null}
                        {row.action === "turn-on" ? (
                          <span>
                            <Button
                              size="xs"
                              variant="outline"
                              disabled={!canChange || busy}
                              data-share-turn-on
                              onClick={() => void turnOnMachine(row.environmentId as EnvironmentId)}
                            >
                              {tx("Turn on")}
                            </Button>
                          </span>
                        ) : row.action === "manual" ? (
                          <span className="text-muted-foreground" data-share-manual>
                            {tx("Turn it on in Settings on {machine}", { machine: row.label })}
                          </span>
                        ) : null}
                      </span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <p className="max-w-xl text-muted-foreground text-xs">
              {tx(
                "A machine joins only when its own switch is on, it is signed in to the same Connect account, and your machines already let each other run work. Another person's machine, a team grant or an agent can never turn it on.",
              )}
            </p>
            {restorePoint ? (
              <div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!canChange || busy}
                  data-percy-shared-undo
                  onClick={() => {
                    setDialogError(null);
                    setDialog("undo");
                  }}
                >
                  {tx("Undo the merge on {machine}…", { machine: ownLabel })}
                </Button>
              </div>
            ) : null}
          </div>
        ) : null}
      </SettingsRow>
      {dialog === "confirm" && ownId !== null ? (
        <PercySharedConfirmDialog
          ownEnvironmentId={ownId}
          ownLabel={ownLabel}
          candidates={candidates}
          seats={seats}
          reading={counts === null}
          busy={busy}
          error={dialogError}
          onConfirm={(choice) => void confirm(choice)}
          onCancel={() => setDialog(null)}
        />
      ) : null}
      {dialog === "undo" && restorePoint ? (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open && !busy) setDialog(null);
          }}
        >
          <DialogPopup showCloseButton={!busy} data-percy-shared-undo-dialog>
            <DialogHeader>
              <DialogTitle>{tx("Undo the merge on {machine}?", { machine: ownLabel })}</DialogTitle>
              <DialogDescription>
                {tx(
                  "This puts Percy's memory and settings on {machine} back as they were on {date} and turns the switch off. A copy of the current state is kept, so this can be undone too. No chat is touched, and your other machines keep their own Percy.",
                  { machine: ownLabel, date: longDate(restorePoint.savedAt) },
                )}
              </DialogDescription>
              {dialogError ? (
                <p role="alert" className="text-error-foreground text-xs">
                  {dialogError}
                </p>
              ) : null}
            </DialogHeader>
            <DialogFooter variant="bare">
              <Button variant="outline" disabled={busy} onClick={() => setDialog(null)}>
                {tx("Cancel")}
              </Button>
              <Button
                variant="destructive"
                disabled={busy}
                data-percy-shared-undo-confirm
                onClick={() => void undo()}
              >
                {busy ? tx("Putting it back…") : tx("Undo the merge")}
              </Button>
            </DialogFooter>
          </DialogPopup>
        </Dialog>
      ) : null}
    </>
  );
}
