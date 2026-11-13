/**
 * Which other machines' work may read the owner's Gmail, Calendar and Drive on
 * this machine. A machine link, a work grant and a project's own Google switch
 * never imply it: each source is turned on here, per machine. Refused reads
 * wait here as requests, and the log shows what was allowed, refused and read.
 *
 * @module PersonalDataAccessSection
 */
import {
  type EnvironmentId,
  PERSONAL_DATA_SOURCE_LABELS,
  PERSONAL_DATA_SOURCES,
  type PersonalDataAccessStatus,
  type PersonalDataLogEntry,
  type PersonalDataMachineAccess,
  type PersonalDataSetAccessInput,
  type PersonalDataSource,
} from "@specweave-studio/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@specweave-studio/client-runtime/state/runtime";
import { useEffect, useState } from "react";

import { useTx } from "../../i18n";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";

const LOG_VERBS: Readonly<Record<PersonalDataLogEntry["action"], string>> = {
  granted: "You allowed {machine} to read {source}",
  revoked: "You stopped {machine} reading {source}",
  dismissed: "You dismissed {machine}'s request for {source}",
  refused: "{machine} asked for {source} and was refused",
  used: "{machine} read {source}",
};

/** How many log lines show before "Show all". */
export const PERSONAL_DATA_LOG_PREVIEW = 5;

/** Every pending request, one per machine and source, in list order. */
export function pendingPersonalDataRequests(
  machines: ReadonlyArray<PersonalDataMachineAccess>,
): ReadonlyArray<{
  readonly machine: PersonalDataMachineAccess;
  readonly source: PersonalDataSource;
}> {
  return machines.flatMap((machine) =>
    machine.ownMachine ? [] : machine.requested.map((source) => ({ machine, source })),
  );
}

/** One line under a machine's name: what its work may read here. */
export function personalDataSummary(machine: PersonalDataMachineAccess): string {
  if (machine.ownMachine) return "Your own machine. Its work reads what you can.";
  if (machine.sources.length === 0) return "Reads none of your personal data.";
  return `Reads ${machine.sources.map((source) => PERSONAL_DATA_SOURCE_LABELS[source]).join(", ")}.`;
}

export function PersonalDataAccessView(props: {
  readonly status: PersonalDataAccessStatus;
  readonly canWrite: boolean;
  readonly busy: boolean;
  readonly error: string | null;
  readonly showAllLog: boolean;
  readonly onShowAllLog: () => void;
  readonly onChange: (input: PersonalDataSetAccessInput) => void;
}) {
  const tx = useTx();
  const { status } = props;
  const pending = pendingPersonalDataRequests(status.machines);
  const log = props.showAllLog ? status.log : status.log.slice(0, PERSONAL_DATA_LOG_PREVIEW);
  const locked = !props.canWrite || props.busy;
  return (
    <div className="border-t px-3 py-3 sm:px-4" data-testid="personal-data-access">
      <p className="text-sm font-medium text-foreground">{tx("Other machines")}</p>
      <p className="mt-1 text-xs text-muted-foreground">
        {tx(
          "Your mail, calendar and files are personal. Linking a machine or letting it run work in a project does not share them. Turn a source on for a machine only if its work should read it here. Percy's chats, memory and routines are never shared.",
        )}
      </p>

      {pending.length > 0 ? (
        <ul
          className="mt-3 divide-y divide-border/50 rounded-md border border-warning/40 bg-warning-surface"
          aria-label={tx("Requests")}
        >
          {pending.map(({ machine, source }) => (
            <li
              key={`${machine.environmentId}:${source}`}
              className="flex min-w-0 flex-wrap items-center gap-2 px-3 py-2"
              data-personal-data-request
            >
              <p className="min-w-0 flex-1 text-sm text-foreground">
                {tx("Work from {machine} asked to read your {source}.", {
                  machine: machine.label,
                  source: tx(PERSONAL_DATA_SOURCE_LABELS[source]),
                })}
              </p>
              <Button
                size="xs"
                variant="outline"
                disabled={locked}
                onClick={() =>
                  props.onChange({
                    environmentId: machine.environmentId,
                    source,
                    change: "dismiss",
                  })
                }
              >
                {tx("Dismiss")}
              </Button>
              <Button
                size="xs"
                disabled={locked}
                onClick={() =>
                  props.onChange({ environmentId: machine.environmentId, source, change: "allow" })
                }
              >
                {tx("Allow")}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}

      {status.machines.length === 0 ? (
        <p className="mt-3 text-xs text-muted-foreground">
          {tx("No other machine may run work here, so nothing else can ask.")}
        </p>
      ) : (
        <ul className="mt-3 divide-y divide-border/50 rounded-md border border-border/60">
          {status.machines.map((machine) => (
            <li
              key={machine.environmentId}
              className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2"
              data-personal-data-machine={machine.label}
            >
              <div className="min-w-40 flex-1">
                <p className="truncate text-sm text-foreground">{machine.label}</p>
                <p className="text-xs text-muted-foreground">{tx(personalDataSummary(machine))}</p>
              </div>
              {machine.ownMachine ? null : (
                <div className="flex items-center gap-3">
                  {PERSONAL_DATA_SOURCES.map((source) => {
                    const on = machine.sources.includes(source);
                    return (
                      <label
                        key={source}
                        className="flex items-center gap-1.5 text-xs text-muted-foreground"
                      >
                        <Switch
                          size="sm"
                          checked={on}
                          disabled={locked}
                          aria-label={tx("{source} for work from {machine}", {
                            source: tx(PERSONAL_DATA_SOURCE_LABELS[source]),
                            machine: machine.label,
                          })}
                          onCheckedChange={(checked) =>
                            props.onChange({
                              environmentId: machine.environmentId,
                              source,
                              change: checked ? "allow" : "revoke",
                            })
                          }
                        />
                        {tx(PERSONAL_DATA_SOURCE_LABELS[source])}
                      </label>
                    );
                  })}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {status.log.length > 0 ? (
        <div className="mt-3">
          <p className="text-xs font-medium text-foreground">{tx("Recent activity")}</p>
          <ul className="mt-1 space-y-0.5" data-testid="personal-data-log">
            {log.map((entry, index) => (
              <li
                key={`${entry.at}:${index}`}
                className="flex min-w-0 gap-2 text-xs text-muted-foreground"
              >
                <span className="min-w-0 flex-1 truncate">
                  {tx(LOG_VERBS[entry.action], {
                    machine: entry.label,
                    source: tx(PERSONAL_DATA_SOURCE_LABELS[entry.source]),
                  })}
                </span>
                <time dateTime={entry.at} className="shrink-0">
                  {formatRelativeTimeLabel(entry.at)}
                </time>
              </li>
            ))}
          </ul>
          {!props.showAllLog && status.log.length > PERSONAL_DATA_LOG_PREVIEW ? (
            <button
              type="button"
              className="mt-1 text-xs text-muted-foreground underline underline-offset-2 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              onClick={props.onShowAllLog}
            >
              {tx("Show all {count}", { count: status.log.length })}
            </button>
          ) : null}
        </div>
      ) : null}

      {props.error !== null ? (
        <p role="alert" className="mt-2 text-xs text-destructive-foreground">
          {tx(props.error)}
        </p>
      ) : null}
    </div>
  );
}

/** Loads and saves through the machine's server; renders nothing on a server from before this existed. */
export function PersonalDataAccessSection(props: {
  readonly environmentId: EnvironmentId;
  readonly canWrite: boolean;
}) {
  const { environmentId } = props;
  const load = useAtomCommand(serverEnvironment.personalDataStatus, { reportFailure: false });
  const save = useAtomCommand(serverEnvironment.setPersonalDataAccess, { reportFailure: false });
  const [status, setStatus] = useState<PersonalDataAccessStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAllLog, setShowAllLog] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void load({ environmentId, input: {} }).then((result) => {
      if (cancelled || result._tag !== "Success") return;
      setStatus(result.value);
    });
    return () => {
      cancelled = true;
    };
  }, [environmentId, load]);

  if (status === null) return null;

  const change = async (input: PersonalDataSetAccessInput) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const result = await save({ environmentId, input });
    setBusy(false);
    if (result._tag === "Success") {
      setStatus(result.value);
      return;
    }
    if (isAtomCommandInterrupted(result)) return;
    const failure = squashAtomCommandFailure(result);
    setError(
      failure instanceof Error && failure.message ? failure.message : "Could not save the change.",
    );
  };

  return (
    <PersonalDataAccessView
      status={status}
      canWrite={props.canWrite}
      busy={busy}
      error={error}
      showAllLog={showAllLog}
      onShowAllLog={() => setShowAllLog(true)}
      onChange={(input) => void change(input)}
    />
  );
}
