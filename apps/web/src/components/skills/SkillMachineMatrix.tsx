import type { EnvironmentId, ProjectId, ProjectSkillsSnapshot } from "@specweave-studio/contracts";
import type { StudioFleetMachine } from "@specweave-studio/contracts/studioFleet";
import { SearchIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { useTx } from "../../i18n";
import { paginate } from "~/lib/pagination";
import { projectSkillLevelLabel } from "../settings/ProjectSkillsSettings.logic";
import { Input } from "../ui/input";
import { useEnvironment } from "../../state/environments";
import { useStudioFleet } from "../../studio/fleet";
import { useMachineNicknames } from "../../studio/machineNickname";
import {
  buildSkillMatrix,
  filterSkillMatrixRows,
  type SkillMatrixCell,
  type SkillMatrixColumn,
  type SkillMatrixMachine,
} from "./SkillMachineMatrix.logic";
import { SkillStatusChip } from "./SkillStatusChip";
import { SkillsPager } from "./SkillsPager";
import { useSkillMachineRead } from "./skillMachineReads";

/** The most machines read at once, as in "Available on". */
const MAX_REMOTE_MACHINES = 31;
/** Rows per page of the table; search runs over every row first. */
export const SKILL_MATRIX_PAGE_SIZE = 25;

type RemoteRead = Pick<
  SkillMatrixMachine,
  "linked" | "connected" | "error" | "pending" | "successful" | "snapshot"
>;

/** Reads one other machine through the shared per-machine read and reports it up. */
function RemoteMachineRead({
  machine,
  projectId,
  userLevel,
  onRead,
}: {
  machine: StudioFleetMachine;
  projectId: ProjectId | null;
  userLevel: boolean;
  onRead: (id: string, read: RemoteRead) => void;
}) {
  const { connected, query } = useSkillMachineRead({
    environmentId: machine.environmentId,
    projectId,
    reachable: machine.status === "reachable",
    userLevel,
  });
  const linked = projectId !== null;
  const { error, isPending, isSuccess, data } = query;
  useEffect(() => {
    onRead(machine.id, {
      linked,
      connected,
      error: error ?? null,
      pending: isPending,
      successful: isSuccess,
      snapshot: data ?? null,
    });
  }, [machine.id, linked, connected, error, isPending, isSuccess, data, onRead]);
  return null;
}

function ColumnNote({ column }: { column: SkillMatrixColumn }) {
  const tx = useTx();
  if (column.readAt !== null) {
    const at = new Date(column.readAt);
    const time = at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    return (
      <time dateTime={column.readAt} title={at.toLocaleString()}>
        {column.state === "partial"
          ? tx("Read {time}, scan incomplete", { time })
          : tx("Read {time}", { time })}
      </time>
    );
  }
  switch (column.state) {
    case "offline":
      return <>{tx("Offline, not read")}</>;
    case "needs-sign-in":
      return <>{tx("Needs sign-in")}</>;
    case "checking":
      return <>{tx("Reading…")}</>;
    case "unlinked":
      return <>{tx("No project there, not read")}</>;
    default:
      return <>{tx("Could not be read")}</>;
  }
}

function MatrixCell({ cell, column }: { cell: SkillMatrixCell; column: SkillMatrixColumn }) {
  const tx = useTx();
  switch (cell.kind) {
    case "installed":
      return (
        <span className="flex flex-wrap items-center gap-1">
          <SkillStatusChip status={{ kind: "installed", version: cell.version }} />
          {cell.scopes && cell.scopes.length > 0 ? (
            <span className="text-xs text-muted-foreground" data-testid="matrix-scope">
              {cell.scopes.map(projectSkillLevelLabel).join(" + ")}
            </span>
          ) : null}
          {cell.differs ? (
            <span className="text-xs text-muted-foreground">{tx("copies differ")}</span>
          ) : null}
          {cell.update ? (
            <SkillStatusChip status={{ kind: "update-available", version: cell.update }} />
          ) : null}
        </span>
      );
    case "missing":
      return <SkillStatusChip status={{ kind: "not-on", machine: column.label }} />;
    case "unreported":
      return (
        <span
          className="text-xs text-muted-foreground"
          data-status="unreported"
          title={tx(
            "This machine did not report built-in skills. They may be there with a different agent version.",
          )}
        >
          {tx("Not reported here")}
        </span>
      );
    case "offline":
      return <SkillStatusChip status={{ kind: "offline" }} />;
    case "needs-sign-in":
      return <SkillStatusChip status={{ kind: "needs-sign-in" }} />;
    case "unknown":
      return <SkillStatusChip status={{ kind: "not-read", reason: cell.reason }} />;
  }
}

/**
 * "Across machines": one row per skill, one column per machine, read-only.
 * Each machine reports its own skills through the read "Available on" uses; a
 * machine that was not read shows why, never "Not on".
 */
export function SkillMachineMatrix({
  environmentId,
  userLevel,
  current,
  projectIdFor,
  latest,
}: {
  /** The machine the page is set up for. */
  environmentId: EnvironmentId;
  userLevel: boolean;
  /** That machine's read, which the page already holds. */
  current: {
    readonly snapshot: ProjectSkillsSnapshot | null;
    readonly error: string | null;
    readonly pending: boolean;
    /** False once the machine drops: a kept snapshot is then not a current read. */
    readonly connected: boolean;
    readonly successful: boolean;
  };
  /** The project on another machine that can carry its read. */
  projectIdFor: (environmentId: EnvironmentId) => ProjectId | null;
  /** Newer versions known per skill name; drives "Update available". */
  latest?: ReadonlyMap<string, string> | undefined;
}) {
  const tx = useTx();
  const fleet = useStudioFleet(environmentId);
  const local = useEnvironment(environmentId);
  const nickname = useMachineNicknames();
  const others = useMemo(
    () =>
      (fleet.snapshot?.machines ?? []).filter((machine) => machine.environmentId !== environmentId),
    [fleet.snapshot, environmentId],
  );
  const remote = others.slice(0, MAX_REMOTE_MACHINES);
  const [reads, setReads] = useState<Readonly<Record<string, RemoteRead>>>({});
  const [search, setSearch] = useState("");
  const [pageNumber, setPageNumber] = useState(1);
  const onRead = useCallback((id: string, read: RemoteRead) => {
    setReads((prior) => ({ ...prior, [id]: read }));
  }, []);

  const matrix = useMemo(() => {
    const machines: SkillMatrixMachine[] = [
      {
        id: environmentId,
        label: nickname(environmentId, local?.label ?? null),
        current: true,
        linked: true,
        connected: current.connected,
        error: current.error,
        pending: current.pending,
        successful: current.successful,
        snapshot: current.snapshot,
      },
      ...remote.map((machine) => ({
        id: machine.id,
        label: nickname(machine.environmentId, machine.machineName ?? machine.label),
        current: false,
        ...(reads[machine.id] ?? {
          linked: projectIdFor(machine.environmentId) !== null,
          connected: machine.status === "reachable",
          error: null,
          pending: true,
          successful: false,
          snapshot: null,
        }),
      })),
    ];
    return buildSkillMatrix(machines, latest ? { latest } : {});
    // `remote` is rebuilt each render; `others` is its stable source.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, environmentId, latest, local?.label, nickname, others, projectIdFor, reads]);

  // Search every row first, then page what matched.
  const matched = useMemo(() => filterSkillMatrixRows(matrix.rows, search), [matrix.rows, search]);
  const page = paginate(matched, pageNumber, SKILL_MATRIX_PAGE_SIZE);
  const searching = search.trim() !== "";

  return (
    <section className="space-y-3" aria-label={tx("Across machines")} data-testid="skills-matrix">
      {remote.map((machine) => (
        <RemoteMachineRead
          key={machine.id}
          machine={machine}
          projectId={projectIdFor(machine.environmentId)}
          userLevel={userLevel}
          onRead={onRead}
        />
      ))}
      <p className="text-sm text-muted-foreground">
        {tx(
          "Read-only. Each machine reports its own skills. Only “Not on” means a machine was read and does not have the skill; a machine that was not read says why instead.",
        )}
      </p>
      {matrix.rows.length > 0 ? (
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative min-w-0 flex-1 basis-56">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 z-10 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              size="sm"
              type="search"
              className="w-full"
              aria-label={tx("Search skills across machines")}
              placeholder={tx("Search skills across machines")}
              value={search}
              onChange={(event) => {
                setSearch(event.currentTarget.value);
                setPageNumber(1);
              }}
              style={{ paddingLeft: "1.75rem" }}
            />
          </div>
          <p
            className="text-xs text-muted-foreground tabular-nums"
            role="status"
            data-testid="matrix-count"
          >
            {searching
              ? tx("{matched} of {total} skills match", {
                  matched: matched.length,
                  total: matrix.rows.length,
                })
              : tx("{total} skills", { total: matrix.rows.length })}
          </p>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          {tx("No skills on the machines that were read.")}
        </p>
      )}
      {matrix.rows.length > 0 && matched.length === 0 ? (
        <p className="text-sm text-muted-foreground">{tx("No skills match.")}</p>
      ) : null}
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full min-w-max border-collapse text-left text-sm">
          <thead>
            <tr className="border-b bg-muted/40">
              <th scope="col" className="sticky left-0 z-10 bg-muted px-3 py-2 font-medium">
                {tx("Skill")}
              </th>
              {matrix.columns.map((column) => (
                <th key={column.id} scope="col" className="px-3 py-2 align-top font-medium">
                  <span className="block">{column.label}</span>
                  <span className="block text-xs font-normal text-muted-foreground">
                    <ColumnNote column={column} />
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {page.items.map((row) => (
              <tr key={row.name} data-skill={row.name} className="border-b last:border-b-0">
                <th
                  scope="row"
                  className="sticky left-0 z-10 max-w-44 bg-background px-3 py-2 text-left font-normal sm:max-w-72"
                >
                  <span className="block truncate font-medium" title={row.name}>
                    {row.name}
                  </span>
                  {row.builtIn ? (
                    <span className="block text-xs text-muted-foreground">
                      {tx("Built into the agent")}
                    </span>
                  ) : null}
                </th>
                {row.cells.map((cell, index) => {
                  const column = matrix.columns[index]!;
                  return (
                    <td key={column.id} className="px-3 py-2 align-top">
                      <MatrixCell cell={cell} column={column} />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <SkillsPager page={page} onPage={setPageNumber} label={tx("skills")} />
      {others.length > MAX_REMOTE_MACHINES ? (
        <p className="text-xs text-muted-foreground">
          {tx("Showing the first 32 machines. Open Connections to inspect the rest.")}
        </p>
      ) : null}
      {fleet.failed ? (
        <p className="text-xs text-muted-foreground">
          {tx("The machine list could not be refreshed. Listed machines may be out of date.")}
        </p>
      ) : null}
    </section>
  );
}
