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
 *
 * A sign-in command for a tool that is not installed fails, so the destination
 * also says where it has each tool. A missing tool gets an install step first;
 * a tool that is there leaves its row as short as before. "Check again" asks
 * the destination to run its checks again, and each row says when it was last
 * checked.
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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useTx } from "../../i18n";
import { renderRich } from "../../i18n/rich";
import { useAtomCommand } from "../../state/use-atom-command";
import { credentialSkipsAtom, projectCredentials } from "../../studio/projectCredentials";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { CopyCredentialCommand as Command } from "./CopyCredentialCommand";
import { CopyCredentialInstall, CopyCredentialInstallWatch } from "./CopyCredentialInstall";
import { CopySshKeySteps } from "./CopySshKeySteps";

export type CredentialProbeState =
  | "checking"
  | "ready"
  /** The destination runs a SpecWithCode from before this check, or refused it. */
  | "unavailable"
  /** The destination has the check and said it could not run it this time. */
  | "failed"
  /** Checked too often in the last minute. */
  | "busy";

export type CredentialSaveState = "idle" | "saving" | "saved" | "failed";

type Tx = ReturnType<typeof useTx>;

/**
 * A sentence with its named places filled, each once and in one pass: a
 * machine's name or a folder is put in as it is, never read as a pattern or
 * as another place to fill.
 */
export function fill(text: string, values: Readonly<Record<string, string>>): string {
  return text.replace(/\{([A-Za-z]+)\}/gu, (whole, name: string) =>
    Object.hasOwn(values, name) ? values[name]! : whole,
  );
}

/**
 * The project lists the tool as a dependency, and the destination has no copy
 * of the project to look in yet. After the copy this never holds: a copy
 * without that folder gets the plain install step instead of a wait.
 */
const comesWithProject = (
  row: ProjectCredentialRow,
  probe: ProjectCredentialProbe,
  copied: boolean,
) =>
  !copied &&
  probe.tool?.state === "missing" &&
  probe.tool.folder === null &&
  (row.packages?.length ?? 0) > 0;

/**
 * Whether the SSH check covered every place the project connects: only the
 * known Git hosts can be asked. A project that also reaches a server from a
 * script, or a remote on another host, keeps its row and its steps whatever
 * the Git hosts said.
 */
export function sshCheckCovers(row: ProjectCredentialRow): boolean {
  if (row.sshTargetsMore === true) return false;
  const checked: ReadonlyArray<string> = row.sshHosts ?? [];
  return (row.sshTargets ?? []).every(
    (target) =>
      target.kind === "git" && target.host !== null && checked.includes(target.host.toLowerCase()),
  );
}

/** The install a row offers for its missing tool, or null when it offers none. */
const installOffered = (
  row: ProjectCredentialRow,
  probe: ProjectCredentialProbe | undefined,
  copied: boolean,
): string | null =>
  probe?.tool?.state === "missing" && !comesWithProject(row, probe, copied)
    ? probe.tool.install
    : null;

/** Ready for the list: the destination said so, and its check covered the whole row. */
const rowReady = (row: ProjectCredentialRow, probe: ProjectCredentialProbe | undefined) =>
  probe?.status === "ready" && (row.id !== "ssh" || sshCheckCovers(row));

function statusLine(
  tx: Tx,
  row: ProjectCredentialRow,
  probe: ProjectCredentialProbe | undefined,
  state: CredentialProbeState,
  checking: boolean,
  copied: boolean,
  targetLabel: string,
): { readonly text: string; readonly tone: "muted" | "attention" } {
  const on = (text: string) => fill(text, { targetLabel, tool: probe?.tool?.name ?? "" });
  if (probe === undefined) {
    if (checking || state === "checking")
      return { text: on(tx("Checking {targetLabel}…")), tone: "muted" };
    // Only a machine that cannot answer at all is asked to update.
    if (state === "unavailable")
      return {
        text: on(tx("{targetLabel} could not be checked. Update SpecWithCode there to see it.")),
        tone: "muted",
      };
    return state === "failed"
      ? { text: on(tx("{targetLabel} could not be checked. Try Check again.")), tone: "muted" }
      : { text: on(tx("Not checked on {targetLabel} yet")), tone: "muted" };
  }
  if (probe.status === "ready")
    return rowReady(row, probe)
      ? { text: on(tx("Ready on {targetLabel}")), tone: "muted" }
      : {
          text: on(
            tx(
              "Its Git hosts accept a key from {targetLabel}. The other places it connects to were not checked.",
            ),
          ),
          tone: "muted",
        };
  if (probe.status === "not_signed_in")
    return row.kind === "file"
      ? {
          text: on(tx("A Git host this project uses does not accept a key from {targetLabel} yet")),
          tone: "attention",
        }
      : { text: on(tx("Not signed in on {targetLabel}")), tone: "attention" };
  if (probe.tool?.state === "missing") {
    if (comesWithProject(row, probe, copied))
      return {
        text: on(tx("{tool} comes with this project. Set it up on {targetLabel} after the copy.")),
        tone: "muted",
      };
    return {
      text:
        probe.signInFile === true
          ? on(
              tx(
                "{tool} is not installed on {targetLabel}. A sign-in file is already there, so installing it may be all that is left.",
              ),
            )
          : on(tx("{tool} is not installed on {targetLabel}")),
      tone: "attention",
    };
  }
  if (probe.status === "tool_missing")
    return { text: on(tx("Its tool was not found on {targetLabel}")), tone: "attention" };
  if (probe.ran === "waiting")
    return {
      text: on(tx("Uses this project's own {tool}. Check again runs it on {targetLabel}.")),
      tone: "muted",
    };
  if (probe.signInFile === true)
    return row.kind === "file"
      ? { text: on(tx("A key file is on {targetLabel}, but it was not checked")), tone: "muted" }
      : {
          text: on(tx("A sign-in file is on {targetLabel}, but it could not be verified")),
          tone: "muted",
        };
  return { text: on(tx("Check it on {targetLabel} yourself")), tone: "muted" };
}

/** "Checked just now", then minutes, then hours: how old a row's answer is. */
export function checkedLabel(tx: Tx, checkedAt: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - checkedAt) / 60_000);
  if (minutes < 1) return tx("Checked just now");
  if (minutes < 60)
    return minutes === 1
      ? tx("Checked 1 minute ago")
      : fill(tx("Checked {count} minutes ago"), { count: String(minutes) });
  const hours = Math.floor(minutes / 60);
  return hours === 1
    ? tx("Checked 1 hour ago")
    : fill(tx("Checked {count} hours ago"), { count: String(hours) });
}

/** What comes before the sign-in command: the install of a missing tool, or why its commands look as they do. */
function ToolSteps({
  row,
  probe,
  copied,
  targetLabel,
  disabled,
  destinationEnvironmentId,
  onInstalled,
}: {
  readonly row: ProjectCredentialRow;
  readonly probe: ProjectCredentialProbe;
  readonly copied: boolean;
  readonly targetLabel: string;
  readonly disabled: boolean;
  readonly destinationEnvironmentId: EnvironmentId | undefined;
  readonly onInstalled: () => void;
}) {
  const tx = useTx();
  const tool = probe.tool;
  const on = (text: string) => fill(text, { targetLabel, tool: tool?.name ?? "" });
  // A destination from before the tool check says only that the tool is missing.
  if (tool === undefined)
    return probe.status === "tool_missing" ? (
      <p className="text-xs text-warning-foreground">
        {on(tx("Install its command-line tool on {targetLabel} if it is missing, then sign in."))}
      </p>
    ) : null;
  if (tool.state === "terminal") return null;
  if (tool.state === "app")
    return (
      <p className="text-xs text-muted-foreground" data-slot="copy-credential-tool-note">
        {tool.name === "npm"
          ? on(
              tx(
                "npm comes with the Node.js that SpecWithCode installs. A new Terminal window finds it once Use these commands in Terminal is on for {targetLabel} (Settings > General). Until then these commands add its folder to PATH first.",
              ),
            )
          : on(
              tx(
                "{tool} is in SpecWithCode's own folder on {targetLabel}, where a new Terminal window does not look, so these commands add that folder to PATH first.",
              ),
            )}
      </p>
    );
  if (tool.state === "project")
    return (
      <p className="text-xs text-muted-foreground" data-slot="copy-credential-tool-note">
        {on(
          tx("{tool} is this project's own tool, so these commands run in the project's folder."),
        )}
      </p>
    );
  if (comesWithProject(row, probe, copied)) {
    const folder = row.packages?.[0] ?? ".";
    return (
      <p className="text-xs text-muted-foreground" data-slot="copy-credential-tool-note">
        {folder === "."
          ? on(
              tx(
                "This project brings its own {tool} (in its top folder), so nothing needs installing for it first. After the copy, this list gives the commands to run in that folder on {targetLabel}.",
              ),
            )
          : fill(
              tx(
                "This project brings its own {tool} (in {folder}), so nothing needs installing for it first. After the copy, this list gives the commands to run in that folder on {targetLabel}.",
              ),
              { targetLabel, tool: tool.name, folder },
            )}
      </p>
    );
  }
  if (tool.install === null)
    return (
      <p className="text-xs text-warning-foreground" data-slot="copy-credential-tool-note">
        {tool.name === "npm"
          ? on(
              tx(
                "npm comes with Node.js, which was not found on {targetLabel}. Install Node.js there first (Machine basics offers it), then check again.",
              ),
            )
          : tool.needsNode !== true
            ? on(tx("Install {tool} on {targetLabel} yourself, then check again."))
            : tool.folder !== null
              ? on(
                  tx(
                    "{tool} is this project's own tool, and installing the project's packages needs Node.js, which was not found on {targetLabel}. Install Node.js there first (Machine basics offers it), then check again.",
                  ),
                )
              : on(
                  tx(
                    "{tool} installs through npm, which comes with Node.js, and that was not found on {targetLabel}. Install Node.js there first (Machine basics offers it), then check again.",
                  ),
                )}
      </p>
    );
  return (
    <div className="space-y-2" data-slot="copy-credential-install-step">
      <Command
        label={
          tool.folder === null
            ? on(tx("First install {tool} on {targetLabel}:"))
            : on(
                tx(
                  "{tool} is this project's own tool. First install the project's packages on {targetLabel}:",
                ),
              )
        }
        command={tool.install}
      />
      {tool.newShell && (
        <p className="text-xs text-muted-foreground">
          {tx("Then open a new Terminal window, so it finds the new command.")}
        </p>
      )}
      {destinationEnvironmentId !== undefined && (
        <CopyCredentialInstall
          environmentId={destinationEnvironmentId}
          tool={tool.name}
          command={tool.install}
          disabled={disabled}
          onEnded={onInstalled}
        />
      )}
    </div>
  );
}

function Row({
  row,
  probe,
  state,
  checking,
  checkedAt,
  now,
  copied,
  sourceLabel,
  targetLabel,
  disabled,
  destinationEnvironmentId,
  onSkip,
  onCheck,
}: {
  readonly row: ProjectCredentialRow;
  readonly probe: ProjectCredentialProbe | undefined;
  readonly state: CredentialProbeState;
  /** The destination has its copy of the project: its own tools are looked for there. */
  readonly copied: boolean;
  /** This row is being checked on the destination right now. */
  readonly checking: boolean;
  /** When the destination last answered for this row. */
  readonly checkedAt: number | undefined;
  readonly now: number;
  readonly sourceLabel: string;
  readonly targetLabel: string;
  readonly disabled: boolean;
  readonly destinationEnvironmentId: EnvironmentId | undefined;
  readonly onSkip: (id: ProjectCredentialId) => void;
  readonly onCheck: (id: ProjectCredentialId) => void;
}) {
  const tx = useTx();
  const [open, setOpen] = useState(false);
  const status = statusLine(tx, row, probe, state, checking, copied, targetLabel);
  const why =
    row.sources.length > 0
      ? fill(tx("Used in {files}"), { files: row.sources.join(", ") })
      : tx("On this project's saved list");
  // Before the copy, a tool the project brings has no folder to run in yet: no command would work.
  const waitsForCopy = probe !== undefined && comesWithProject(row, probe, copied);
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
          {checking ? (
            <p
              className="flex items-center gap-1 text-xs text-muted-foreground"
              role="status"
              data-slot="copy-credential-checking"
            >
              <Spinner size="xs" aria-hidden />
              {fill(tx("Checking on {targetLabel}…"), { targetLabel })}
            </p>
          ) : (
            checkedAt !== undefined && (
              <p className="text-xs text-muted-foreground" data-slot="copy-credential-checked">
                {checkedLabel(tx, checkedAt, now)}
              </p>
            )
          )}
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
      {open && probe !== undefined && row.id === "ssh" && (
        <>
          <CopySshKeySteps
            row={row}
            keygen={probe.signIn}
            fallbackCheck={probe.check}
            sourceLabel={sourceLabel}
            targetLabel={targetLabel}
          />
          <Button
            variant="outline"
            size="xs"
            disabled={disabled || checking}
            data-slot="copy-credential-check"
            onClick={() => onCheck(row.id)}
          >
            {tx("Check again")}
          </Button>
        </>
      )}
      {open && probe !== undefined && row.id !== "ssh" && (
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
                <span className="font-mono break-all">
                  {row.keptIn.map((path) => `~/${path}`).join(", ")}
                </span>
              </span>
            )}
          </p>
          <ToolSteps
            row={row}
            probe={probe}
            copied={copied}
            targetLabel={targetLabel}
            disabled={disabled}
            destinationEnvironmentId={destinationEnvironmentId}
            onInstalled={() => onCheck(row.id)}
          />
          {!waitsForCopy && (
            <>
              <Command
                label={
                  probe.tool?.state === "missing" && probe.tool.install !== null
                    ? fill(tx("Then sign in, in a terminal on {targetLabel}:"), { targetLabel })
                    : fill(tx("Run this in a terminal on {targetLabel}:"), { targetLabel })
                }
                command={probe.tool?.signIn ?? probe.signIn}
              />
              {(probe.tool === undefined ? probe.check : probe.tool.check) !== null && (
                <Command
                  label={tx("Then see that it worked:")}
                  command={(probe.tool === undefined ? probe.check : probe.tool.check) ?? ""}
                />
              )}
            </>
          )}
          <Button
            variant="outline"
            size="xs"
            disabled={disabled || checking}
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

const NONE_CHECKING: ReadonlySet<ProjectCredentialId> = new Set();
const NEVER_CHECKED: ReadonlyMap<ProjectCredentialId, number> = new Map();
/** How often "Checked 2 minutes ago" is brought up to date. */
const CHECKED_TICK_MS = 30_000;

/** The section itself, from data: the container below fetches, a fixture or test passes rows. */
export function CopyCredentialsList({
  rows,
  probes,
  state,
  checking = NONE_CHECKING,
  checkedAt = NEVER_CHECKED,
  now = 0,
  copied = false,
  skipped,
  sourceLabel,
  targetLabel,
  disabled = false,
  destinationEnvironmentId,
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
  /** The rows the destination is checking right now. */
  readonly checking?: ReadonlySet<ProjectCredentialId>;
  /** When the destination last answered for each row, on this window's clock. */
  readonly checkedAt?: ReadonlyMap<ProjectCredentialId, number>;
  /** This window's clock, for "Checked 2 minutes ago". */
  readonly now?: number;
  /** The destination has its copy of the project (the Done screen). */
  readonly copied?: boolean;
  readonly skipped: ReadonlyArray<ProjectCredentialId>;
  readonly sourceLabel: string;
  readonly targetLabel: string;
  readonly disabled?: boolean;
  /** Where "Install there" runs; without it rows show the install command only. */
  readonly destinationEnvironmentId?: EnvironmentId | undefined;
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
  const isReady = (row: ProjectCredentialRow) => rowReady(row, probes.get(row.id));
  const skippedRows = rows.filter(isSkipped);
  const readyRows = rows.filter((row) => !isSkipped(row) && isReady(row));
  const needed = rows.filter((row) => !isSkipped(row) && !isReady(row));
  const names = (list: ReadonlyArray<ProjectCredentialRow>) =>
    list.map((row) => PROJECT_CREDENTIAL_LABELS[row.id]).join(", ");
  // npm's check asks the default registry; a project's own `.npmrc` may name another.
  const otherRegistry = readyRows.some((row) => row.id === "npm" && row.registryFile === true);
  // A check that failed leaves the earlier answers on screen: say that they are the earlier ones.
  const stale =
    (state === "unavailable" || state === "failed") && rows.some((row) => probes.has(row.id));
  return (
    <section className="min-w-0 space-y-2 text-sm" data-slot="copy-credentials">
      {/* Here, not in a row: an install left running is waited for with its row closed, and let
          go of when the row turns ready and leaves the list. A skipped row keeps it, unasked. */}
      {destinationEnvironmentId !== undefined &&
        rows.map((row) => {
          const probe = probes.get(row.id);
          return probe?.tool == null ? null : (
            <CopyCredentialInstallWatch
              key={row.id}
              environmentId={destinationEnvironmentId}
              tool={probe.tool.name}
              command={installOffered(row, probe, copied)}
              paused={checking.has(row.id) || isSkipped(row)}
              onCheck={() => onCheck(row.id)}
            />
          );
        })}
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
      {stale && (
        <p
          role="status"
          className="text-xs text-warning-foreground"
          data-slot="copy-credentials-stale"
        >
          {fill(
            tx("{targetLabel} did not answer the last check. The rows show what it said before."),
            {
              targetLabel,
            },
          )}
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
              checking={checking.has(row.id)}
              checkedAt={checkedAt.get(row.id)}
              now={now}
              copied={copied}
              sourceLabel={sourceLabel}
              targetLabel={targetLabel}
              disabled={disabled}
              destinationEnvironmentId={destinationEnvironmentId}
              onSkip={onSkip}
              onCheck={onCheck}
            />
          ))}
        </ul>
      ) : (
        <p className="text-xs text-success-foreground" data-slot="copy-credentials-all-ready">
          {fill(tx("{targetLabel} has everything this project uses."), { targetLabel })}
        </p>
      )}
      {readyRows.length > 0 && (
        <details className="text-xs" data-slot="copy-credentials-ready">
          <summary className="cursor-default text-muted-foreground">
            {fill(tx("Ready on {targetLabel} ({count})"), {
              targetLabel,
              count: String(readyRows.length),
            })}
          </summary>
          <p className="mt-1 pl-4">{names(readyRows)}</p>
        </details>
      )}
      {otherRegistry && (
        <p className="text-xs text-muted-foreground" data-slot="copy-credentials-registry-note">
          {fill(
            tx(
              "npm is signed in to its default registry on {targetLabel}. This project has an .npmrc, which may name another one: if it does, sign in to that registry there too.",
            ),
            { targetLabel },
          )}
        </p>
      )}
      {skippedRows.length > 0 && (
        <details className="text-xs" data-slot="copy-credentials-skipped">
          <summary className="cursor-default text-muted-foreground">
            {fill(tx("Skipped ({count})"), { count: String(skippedRows.length) })}
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
          {fill(tx("The project's saved list was not used: {problem}"), {
            problem: manifestProblem,
          })}
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
  destinationProjectId,
  sourceLabel,
  targetLabel,
  disabled = false,
}: {
  readonly sourceEnvironmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly destinationEnvironmentId: EnvironmentId;
  /** The destination's own copy of the project, once the copy made one: where its own tools are looked for. */
  readonly destinationProjectId?: ProjectId | undefined;
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
  // The rows whose latest check got no answer, and why. Per row: one row's failed check is not
  // forgotten because another row's check came back fine.
  const [failed, setFailed] = useState<
    ReadonlyMap<ProjectCredentialId, "unavailable" | "failed" | "busy">
  >(() => new Map());
  const [checking, setChecking] = useState<ReadonlySet<ProjectCredentialId>>(() => new Set());
  const [checkedAt, setCheckedAt] = useState<ReadonlyMap<ProjectCredentialId, number>>(
    () => new Map(),
  );
  const [now, setNow] = useState(() => Date.now());
  const [save, setSave] = useState<CredentialSaveState>("idle");
  // The newest check asked for each row: an older one's late answer never replaces it.
  const asked = useRef(new Map<ProjectCredentialId, number>());
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
        // The opening check starts right after: no frame says "not checked yet" in between.
        setChecking(new Set(result.value.rows.map((row) => row.id)));
        setProblem(result.value.manifestProblem);
        setTruncated(result.value.truncated);
      });
    return () => {
      live = false;
    };
  }, [projectId, sourceEnvironmentId]);

  useEffect(() => {
    if (checkedAt.size === 0) return;
    const timer = setInterval(() => setNow(Date.now()), CHECKED_TICK_MS);
    return () => clearInterval(timer);
  }, [checkedAt.size]);

  const ids = useMemo(() => rows.map((row) => row.id), [rows]);
  // What the source knows that helps the destination look: folders that bring a tool, and
  // the known Git hosts the project reaches over SSH. Left out when there is nothing to say.
  const context = useMemo(() => {
    const packages = rows.flatMap((row) =>
      row.packages !== undefined && row.packages.length > 0
        ? [{ id: row.id, folders: [...row.packages] }]
        : [],
    );
    const sshHosts = [...(rows.find((row) => row.id === "ssh")?.sshHosts ?? [])];
    return { packages, sshHosts };
  }, [rows]);
  const check = useCallback(
    /** `byPerson`: a click asked for it, so the destination checks again and may run the project's own tools. */
    async (only: ReadonlyArray<ProjectCredentialId>, byPerson: boolean) => {
      if (only.length === 0) return;
      const mine = ++request.current;
      for (const id of only) asked.current.set(id, mine);
      const settle = () =>
        setChecking((before) => {
          const next = new Set(before);
          for (const id of only) if (asked.current.get(id) === mine) next.delete(id);
          return next;
        });
      setChecking((before) => new Set([...before, ...only]));
      const packages = context.packages.filter((entry) => only.includes(entry.id));
      const result = await commands.current.probe({
        environmentId: destinationEnvironmentId,
        input: {
          ids: [...only],
          fresh: byPerson,
          ...(destinationProjectId !== undefined ? { projectId: destinationProjectId } : {}),
          ...(packages.length > 0 ? { packages } : {}),
          ...(only.includes("ssh") && context.sshHosts.length > 0
            ? { sshHosts: context.sshHosts }
            : {}),
          ...(byPerson ? { projectTools: true } : {}),
        },
      });
      const current = (id: ProjectCredentialId) => asked.current.get(id) === mine;
      settle();
      if (result._tag === "Success") {
        const at = Date.now();
        setProbes((before) => {
          const next = new Map(before);
          for (const entry of result.value.results)
            if (current(entry.id)) next.set(entry.id, entry);
          return next;
        });
        // An answer the destination kept from an earlier check is as old as it says.
        setCheckedAt((before) => {
          const next = new Map(before);
          for (const entry of result.value.results)
            if (current(entry.id)) next.set(entry.id, at - (entry.checkedMsAgo ?? 0));
          return next;
        });
        setNow(at);
        setFailed((before) => {
          const next = new Map(before);
          for (const entry of result.value.results) if (current(entry.id)) next.delete(entry.id);
          return next;
        });
        return;
      }
      const error = squashAtomCommandFailure(result) as { readonly code?: unknown } | null;
      // `failed` is the check's own word: that machine has it, and could not run it this time.
      const why =
        error?.code === "busy" ? "busy" : error?.code === "failed" ? "failed" : "unavailable";
      setFailed((before) => {
        const next = new Map(before);
        for (const id of only) if (current(id)) next.set(id, why);
        return next;
      });
    },
    [context, destinationEnvironmentId, destinationProjectId],
  );

  useEffect(() => {
    void check(ids, false);
  }, [check, ids]);

  const reasons = new Set(failed.values());
  const state: CredentialProbeState =
    checking.size > 0
      ? "checking"
      : reasons.has("busy")
        ? "busy"
        : reasons.has("unavailable")
          ? "unavailable"
          : reasons.has("failed")
            ? "failed"
            : "ready";
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
      checking={checking}
      checkedAt={checkedAt}
      now={now}
      copied={destinationProjectId !== undefined}
      skipped={skipped}
      sourceLabel={sourceLabel}
      targetLabel={targetLabel}
      disabled={disabled}
      destinationEnvironmentId={destinationEnvironmentId}
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
