/**
 * "Credentials this project uses", on the review and Done screens of a copy.
 * Sign-ins and key files never travel: each machine keeps its own. This lists
 * what the project uses, says which of them the destination already has, and
 * gives the command that sets up each missing one there, so the project works
 * on the new machine as it did on the old one.
 *
 * The list comes from the source machine (a scan of the project plus its saved
 * list), the status and commands from the destination. Only names, commands
 * from the app's own list and status words are shown.
 */
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@specweave-studio/client-runtime/state/runtime";
import {
  type EnvironmentId,
  PROJECT_CREDENTIAL_LABELS,
  PROJECT_CREDENTIALS_MANIFEST_PATH,
  type ProjectCredentialId,
  type ProjectCredentialProbe,
  type ProjectCredentialRow,
  type ProjectId,
} from "@specweave-studio/contracts";
import { CheckIcon, CopyIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { writeTextToClipboard } from "../../hooks/useCopyToClipboard";
import { useTx } from "../../i18n";
import { renderRich } from "../../i18n/rich";
import { useAtomCommand } from "../../state/use-atom-command";
import { credentialSkipsAtom, projectCredentials } from "../../studio/projectCredentials";
import { Button } from "../ui/button";

export type CredentialProbeState =
  | "checking"
  | "ready"
  /** The destination runs a SpecWithCode from before this check, or refused it. */
  | "unavailable"
  /** Checked too often in the last minute. */
  | "busy";

export type CredentialSaveState = "idle" | "saving" | "saved" | "failed";

type Tx = ReturnType<typeof useTx>;

function statusLine(
  tx: Tx,
  probe: ProjectCredentialProbe | undefined,
  state: CredentialProbeState,
  targetLabel: string,
): { readonly text: string; readonly tone: "muted" | "attention" } {
  const on = (text: string) => text.replace("{targetLabel}", targetLabel);
  if (probe === undefined)
    return state === "checking"
      ? { text: on(tx("Checking {targetLabel}…")), tone: "muted" }
      : {
          text: on(tx("{targetLabel} could not be checked. Update SpecWithCode there to see it.")),
          tone: "muted",
        };
  switch (probe.status) {
    case "not_signed_in":
      return { text: on(tx("Not signed in on {targetLabel}")), tone: "attention" };
    case "tool_missing":
      return { text: on(tx("Its tool was not found on {targetLabel}")), tone: "attention" };
    case "unknown":
      return { text: on(tx("Check it on {targetLabel} yourself")), tone: "muted" };
    case "ready":
      return { text: on(tx("Ready on {targetLabel}")), tone: "muted" };
  }
}

function Command({ label, command }: { readonly label: string; readonly command: string }) {
  const tx = useTx();
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-1" data-slot="copy-credential-command">
      {/* Label and command are separate plain text: neither is built from the other. */}
      <p className="text-xs text-muted-foreground">{label}</p>
      <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2">
        <code className="min-w-0 flex-1 overflow-x-auto font-mono text-xs whitespace-nowrap">
          {command}
        </code>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={copied ? tx("Copied") : tx("Copy command")}
          onClick={() =>
            void writeTextToClipboard(command).then(
              () => setCopied(true),
              () => {},
            )
          }
        >
          {copied ? <CheckIcon aria-hidden /> : <CopyIcon aria-hidden />}
        </Button>
      </div>
    </div>
  );
}

function Row({
  row,
  probe,
  state,
  sourceLabel,
  targetLabel,
  disabled,
  onSkip,
  onCheck,
}: {
  readonly row: ProjectCredentialRow;
  readonly probe: ProjectCredentialProbe | undefined;
  readonly state: CredentialProbeState;
  readonly sourceLabel: string;
  readonly targetLabel: string;
  readonly disabled: boolean;
  readonly onSkip: (id: ProjectCredentialId) => void;
  readonly onCheck: (id: ProjectCredentialId) => void;
}) {
  const tx = useTx();
  const [open, setOpen] = useState(false);
  const status = statusLine(tx, probe, state, targetLabel);
  const why =
    row.sources.length > 0
      ? tx("Used in {files}").replace("{files}", row.sources.join(", "))
      : tx("On this project's saved list");
  return (
    <li className="space-y-2 p-3" data-slot="copy-credential-row" data-credential={row.id}>
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="font-medium">{PROJECT_CREDENTIAL_LABELS[row.id]}</p>
          <p
            className={
              status.tone === "attention"
                ? "text-xs text-warning-foreground"
                : "text-xs text-muted-foreground"
            }
            data-slot="copy-credential-status"
          >
            {status.text}
          </p>
          <p className="text-xs break-words text-muted-foreground">
            {why}
            {row.note ? ` · ${row.note}` : ""}
          </p>
        </div>
        <div className="flex shrink-0 gap-1.5">
          {probe !== undefined && (
            <Button
              variant="outline"
              size="xs"
              aria-expanded={open}
              disabled={disabled}
              data-slot="copy-credential-sign-in"
              onClick={() => setOpen((shown) => !shown)}
            >
              {row.kind === "file" ? tx("Set up there") : tx("Sign in there")}
            </Button>
          )}
          <Button
            variant="outline"
            size="xs"
            disabled={disabled}
            data-slot="copy-credential-skip"
            onClick={() => onSkip(row.id)}
          >
            {tx("Skip")}
          </Button>
        </div>
      </div>
      {open && probe !== undefined && (
        <div className="space-y-2" data-slot="copy-credential-steps">
          <p className="text-xs text-muted-foreground">
            {row.kind === "file"
              ? renderRich(
                  tx(
                    "Stays on {sourceLabel}: key files are never copied. Create a new key on {targetLabel} and add it where the old one is trusted.",
                  ),
                  { sourceLabel, targetLabel },
                )
              : renderRich(
                  tx(
                    "Stays on {sourceLabel}: sign-ins are never copied. Sign in on {targetLabel} with the same account.",
                  ),
                  { sourceLabel, targetLabel },
                )}
            {row.keptIn.length > 0 && (
              <span className="block" data-slot="copy-credential-kept">
                {tx("Not copied:")}{" "}
                <span className="font-mono">
                  {row.keptIn.map((path) => `~/${path}`).join(", ")}
                </span>
              </span>
            )}
          </p>
          {probe.status === "tool_missing" && (
            <p className="text-xs text-warning-foreground">
              {tx(
                "Install its command-line tool on {targetLabel} if it is missing, then sign in.",
              ).replace("{targetLabel}", targetLabel)}
            </p>
          )}
          <Command
            label={tx("Run this in a terminal on {targetLabel}:").replace(
              "{targetLabel}",
              targetLabel,
            )}
            command={probe.signIn}
          />
          {probe.check !== null && (
            <Command label={tx("Then see that it worked:")} command={probe.check} />
          )}
          <Button
            variant="outline"
            size="xs"
            disabled={disabled || state === "checking"}
            data-slot="copy-credential-check"
            onClick={() => onCheck(row.id)}
          >
            {tx("Check again")}
          </Button>
        </div>
      )}
    </li>
  );
}

/** The section itself, from data: the container below fetches, a fixture or test passes rows. */
export function CopyCredentialsList({
  rows,
  probes,
  state,
  skipped,
  sourceLabel,
  targetLabel,
  disabled = false,
  manifestProblem = null,
  truncated = false,
  save,
  onSkip,
  onUnskip,
  onCheck,
  onSave,
}: {
  readonly rows: ReadonlyArray<ProjectCredentialRow>;
  readonly probes: ReadonlyMap<ProjectCredentialId, ProjectCredentialProbe>;
  readonly state: CredentialProbeState;
  readonly skipped: ReadonlyArray<ProjectCredentialId>;
  readonly sourceLabel: string;
  readonly targetLabel: string;
  readonly disabled?: boolean;
  readonly manifestProblem?: string | null;
  readonly truncated?: boolean;
  readonly save: CredentialSaveState;
  readonly onSkip: (id: ProjectCredentialId) => void;
  readonly onUnskip: (id: ProjectCredentialId) => void;
  /** One credential, or all of them when no id is given. */
  readonly onCheck: (id?: ProjectCredentialId) => void;
  readonly onSave: () => void;
}) {
  const tx = useTx();
  if (rows.length === 0) return null;
  const isSkipped = (row: ProjectCredentialRow) => skipped.includes(row.id);
  const isReady = (row: ProjectCredentialRow) => probes.get(row.id)?.status === "ready";
  const skippedRows = rows.filter(isSkipped);
  const readyRows = rows.filter((row) => !isSkipped(row) && isReady(row));
  const needed = rows.filter((row) => !isSkipped(row) && !isReady(row));
  const names = (list: ReadonlyArray<ProjectCredentialRow>) =>
    list.map((row) => PROJECT_CREDENTIAL_LABELS[row.id]).join(", ");
  return (
    <section className="min-w-0 space-y-2 text-sm" data-slot="copy-credentials">
      <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-medium">{tx("Credentials this project uses")}</h3>
        <Button
          variant="outline"
          size="xs"
          disabled={disabled || state === "checking"}
          data-slot="copy-credentials-check-all"
          onClick={() => onCheck()}
        >
          {state === "checking" ? tx("Checking…") : tx("Check again")}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        {renderRich(
          tx(
            "Sign-ins and keys are not copied: each machine keeps its own. This is what {targetLabel} needs so the project works there as it does on {sourceLabel}.",
          ),
          { sourceLabel, targetLabel },
        )}
      </p>
      {state === "busy" && (
        <p role="status" className="text-xs text-warning-foreground">
          {tx("That machine was checked several times in the last minute. Try again in a minute.")}
        </p>
      )}
      {needed.length > 0 ? (
        <ul className="divide-y rounded-lg border" data-slot="copy-credentials-needed">
          {needed.map((row) => (
            <Row
              key={row.id}
              row={row}
              probe={probes.get(row.id)}
              state={state}
              sourceLabel={sourceLabel}
              targetLabel={targetLabel}
              disabled={disabled}
              onSkip={onSkip}
              onCheck={onCheck}
            />
          ))}
        </ul>
      ) : (
        <p className="text-xs text-success-foreground" data-slot="copy-credentials-all-ready">
          {tx("{targetLabel} has everything this project uses.").replace(
            "{targetLabel}",
            targetLabel,
          )}
        </p>
      )}
      {readyRows.length > 0 && (
        <details className="text-xs" data-slot="copy-credentials-ready">
          <summary className="cursor-default text-muted-foreground">
            {tx("Ready on {targetLabel} ({count})")
              .replace("{targetLabel}", targetLabel)
              .replace("{count}", String(readyRows.length))}
          </summary>
          <p className="mt-1 pl-4">{names(readyRows)}</p>
        </details>
      )}
      {skippedRows.length > 0 && (
        <details className="text-xs" data-slot="copy-credentials-skipped">
          <summary className="cursor-default text-muted-foreground">
            {tx("Skipped ({count})").replace("{count}", String(skippedRows.length))}
          </summary>
          <ul className="mt-1 space-y-1 pl-4">
            {skippedRows.map((row) => (
              <li key={row.id} className="flex items-center gap-2">
                <span>{PROJECT_CREDENTIAL_LABELS[row.id]}</span>
                <Button
                  variant="outline"
                  size="xs"
                  disabled={disabled}
                  data-slot="copy-credential-unskip"
                  onClick={() => onUnskip(row.id)}
                >
                  {tx("Bring back")}
                </Button>
              </li>
            ))}
          </ul>
        </details>
      )}
      {manifestProblem !== null && (
        <p className="text-xs text-warning-foreground" data-slot="copy-credentials-problem">
          {tx("The project's saved list was not used: {problem}").replace(
            "{problem}",
            manifestProblem,
          )}
        </p>
      )}
      {truncated && (
        <p className="text-xs text-muted-foreground">
          {tx(
            "This project is large, so only part of it was read. It may use more than is listed.",
          )}
        </p>
      )}
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="xs"
          disabled={disabled || save === "saving"}
          data-slot="copy-credentials-save"
          onClick={onSave}
        >
          {tx("Save list to project")}
        </Button>
        <span className="min-w-0 text-xs text-muted-foreground" role="status">
          {save === "saved"
            ? renderRich(tx("Saved as {path}. It holds names only, so it is safe to commit."), {
                path: <span className="font-mono">{PROJECT_CREDENTIALS_MANIFEST_PATH}</span>,
              })
            : save === "failed"
              ? tx("The list could not be saved on that machine.")
              : tx("Names only, never a value. The next copy starts from it.")}
        </span>
      </div>
    </section>
  );
}

/** Fetches the list from the source and the status from the destination. */
export function CopyCredentialsChecklist({
  sourceEnvironmentId,
  projectId,
  destinationEnvironmentId,
  sourceLabel,
  targetLabel,
  disabled = false,
}: {
  readonly sourceEnvironmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly destinationEnvironmentId: EnvironmentId;
  readonly sourceLabel: string;
  readonly targetLabel: string;
  readonly disabled?: boolean;
}) {
  const scan = useAtomCommand(projectCredentials.scan, { reportFailure: false });
  const probe = useAtomCommand(projectCredentials.probe, { reportFailure: false });
  const saveList = useAtomCommand(projectCredentials.save, { reportFailure: false });
  const skipsAtom = credentialSkipsAtom(
    `${sourceEnvironmentId}:${projectId}:${destinationEnvironmentId}`,
  );
  const chosen = useAtomValue(skipsAtom);
  const setChosen = useAtomSet(skipsAtom);
  const [rows, setRows] = useState<ReadonlyArray<ProjectCredentialRow>>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [probes, setProbes] = useState<ReadonlyMap<ProjectCredentialId, ProjectCredentialProbe>>(
    () => new Map(),
  );
  const [state, setState] = useState<CredentialProbeState>("checking");
  const [save, setSave] = useState<CredentialSaveState>("idle");
  const request = useRef(0);
  // The commands by reference: a caller that hands over new functions on each render
  // must not start the list or the check again.
  const commands = useRef({ scan, probe });
  useEffect(() => {
    commands.current = { scan, probe };
  }, [scan, probe]);

  useEffect(() => {
    let live = true;
    void commands.current
      .scan({ environmentId: sourceEnvironmentId, input: { projectId } })
      .then((result) => {
        // A source from before this list answers nothing: the section stays out of the way.
        if (!live || result._tag !== "Success") return;
        setRows(result.value.rows);
        setProblem(result.value.manifestProblem);
        setTruncated(result.value.truncated);
      });
    return () => {
      live = false;
    };
  }, [projectId, sourceEnvironmentId]);

  const ids = useMemo(() => rows.map((row) => row.id), [rows]);
  const check = useCallback(
    async (only: ReadonlyArray<ProjectCredentialId>, fresh: boolean) => {
      if (only.length === 0) return;
      const mine = ++request.current;
      setState("checking");
      const result = await commands.current.probe({
        environmentId: destinationEnvironmentId,
        input: { ids: [...only], fresh },
      });
      if (request.current !== mine) return;
      if (result._tag === "Success") {
        setProbes((before) => {
          const next = new Map(before);
          for (const entry of result.value.results) next.set(entry.id, entry);
          return next;
        });
        setState("ready");
        return;
      }
      const error = squashAtomCommandFailure(result) as { readonly code?: unknown } | null;
      setState(error?.code === "busy" ? "busy" : "unavailable");
    },
    [destinationEnvironmentId],
  );

  useEffect(() => {
    void check(ids, false);
  }, [check, ids]);

  const skipped = chosen ?? rows.filter((row) => row.skip).map((row) => row.id);
  const onSave = useCallback(async () => {
    setSave("saving");
    const result = await saveList({
      environmentId: sourceEnvironmentId,
      input: {
        projectId,
        credentials: rows.map((row) => ({
          id: row.id,
          ...(skipped.includes(row.id) ? { skip: true } : {}),
          ...(row.note ? { note: row.note } : {}),
        })),
      },
    });
    setSave(result._tag === "Success" ? "saved" : "failed");
  }, [projectId, rows, saveList, skipped, sourceEnvironmentId]);

  return (
    <CopyCredentialsList
      rows={rows}
      probes={probes}
      state={state}
      skipped={skipped}
      sourceLabel={sourceLabel}
      targetLabel={targetLabel}
      disabled={disabled}
      manifestProblem={problem}
      truncated={truncated}
      save={save}
      onSkip={(id) => {
        setChosen([...skipped.filter((item) => item !== id), id]);
        setSave("idle");
      }}
      onUnskip={(id) => {
        setChosen(skipped.filter((item) => item !== id));
        setSave("idle");
      }}
      onCheck={(id) => void check(id === undefined ? ids : [id], true)}
      onSave={() => void onSave()}
    />
  );
}
