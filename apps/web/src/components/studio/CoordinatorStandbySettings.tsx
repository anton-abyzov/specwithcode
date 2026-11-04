import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";
import { squashAtomCommandFailure } from "@specweave-studio/client-runtime/state/runtime";
import {
  COORDINATOR_STANDBY_AFTER_MINUTES,
  type CoordinatorStandbyAfterMinutes,
  DEFAULT_COORDINATOR_STANDBY_AFTER_MINUTES,
  type EnvironmentId,
  type ProjectAcceptStandbyInput,
  type ProjectLinkSyncMembersInput,
  type ProjectSetStandbyInput,
  type ProjectStandbyRearmStatus,
} from "@specweave-studio/contracts";
import type {
  StudioFleetSnapshot,
  StudioFleetWorkerAccess,
} from "@specweave-studio/contracts/studioFleet";
import { isElectron } from "../../env";
import { randomUUID } from "../../lib/utils";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import { useProjectRemoteWorkers, useStudioFleet } from "../../studio/fleet";
import { highestEpoch, linkMemberOf, projectLink } from "../../studio/projectLink";
import {
  armStandby,
  disarmStandby,
  type RearmMachineResult,
  rearmReadiness,
  saveRearmList,
  STANDBY_REARM_NEXT_MAX,
  standbyArmingProblem,
  standbyWorkerMachines,
  type StandbyMachineResult,
  type StandbyRearmPlan,
  type StandbySide,
} from "../../studio/standbyArming";
import { hasFullAccess, liveStandbyArmingCommands } from "../../studio/standbyArmingCommands";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsRow } from "../settings/settingsLayout";
import { ProjectMachineHandoff } from "./ProjectMachineHandoff";
import {
  rearmProblemText,
  rearmStandbyOldText,
  rearmStatusText,
  StandbyRearmList,
  type StandbyRearmListProps,
} from "./StandbyRearmList";
import { useLinkMachines } from "./useLinkMachines";

/* ---------- Copy: short plain sentences, one place for every line. ---------- */

const clock = (value: string) =>
  new Date(value).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

/** "If this Mac goes quiet", or the coordinator's name when this app runs elsewhere. */
export const standbySectionTitle = (coordinatorLabel: string, coordinatorIsHere: boolean) =>
  `If ${coordinatorIsHere ? "this Mac" : coordinatorLabel} goes quiet`;

export type StandbyRowState = "unknown" | "ready" | "failed";

/** One worker machine's arming row. */
export const standbyRowText = (worker: string, standby: string, state: StandbyRowState) =>
  state === "ready"
    ? `Ready. ${standby} can take over.`
    : state === "failed"
      ? `Not ready. ${worker} has not allowed ${standby} yet.`
      : `${worker} lets ${standby} take over.`;

export const standbyWarningText = (
  standby: string,
  coordinatorLabel: string,
  coordinatorIsHere: boolean,
) =>
  `${standby} must stay awake. If it is off, ${coordinatorIsHere ? "this Mac" : coordinatorLabel} pauses its coordinator.`;

/** Shown on the machine that took over. */
export const tookOverText = (standby: string, previous: string, at: string) =>
  `${standby} took over from ${previous} at ${clock(at)}. ${previous} went quiet.`;

export const workersReportHereText = (count: number, machine: string) =>
  count === 1
    ? `1 worker on ${machine} reports here now.`
    : `${count} workers on ${machine} report here now.`;

/** Shown for the machine that returned after an automatic takeover. */
export const returnedText = (successor: string, returned: string, returnedIsHere: boolean) =>
  returnedIsHere
    ? `${successor} took over while this Mac was away. This Mac now runs workers.`
    : `${successor} took over while ${returned} was away. ${returned} now runs workers.`;

export const handBackHint = (successor: string) =>
  `Open ${successor} and hand the coordinator back.`;

const afterLabel = (minutes: number) => `${minutes} minutes`;

const failureText = (cause: unknown, fallback: string) =>
  cause instanceof Error && cause.message ? cause.message : fallback;

const isStandbyUnreachable = (cause: unknown) =>
  typeof cause === "object" &&
  cause !== null &&
  (cause as { readonly code?: unknown }).code === "standby_unreachable";

/* ---------- View: no data wiring, so tests and fixtures render it. ---------- */

export interface StandbyChoice {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}

export interface StandbyRow {
  readonly environmentId: EnvironmentId;
  readonly text: string;
  readonly state: StandbyRowState;
  readonly error: string | null;
}

export interface CoordinatorStandbyViewProps {
  readonly title: string;
  readonly choices: ReadonlyArray<StandbyChoice>;
  readonly standby: EnvironmentId | null;
  readonly afterMinutes: CoordinatorStandbyAfterMinutes;
  readonly rows: ReadonlyArray<StandbyRow>;
  readonly warning: string | null;
  /** Why arming cannot start from this app; turning it off still works. */
  readonly problem: string | null;
  /** Shown while the coordinator may be paused waiting for its standby. */
  readonly fenceNote: string | null;
  /** The "if it takes over, arm next" list; null hides it. */
  readonly rearm?: StandbyRearmListProps | null;
  /** Why the chosen standby cannot hold that list, or null. */
  readonly rearmNote?: string | null;
  /** On the machine that took over automatically: how re-arming its own standby goes. */
  readonly rearmStatus?: string | null;
  readonly pending: boolean;
  readonly message: { readonly text: string; readonly error: boolean } | null;
  readonly canChangeAnyway: boolean;
  readonly onStandby: (environmentId: EnvironmentId | null) => void;
  readonly onAfter: (minutes: CoordinatorStandbyAfterMinutes) => void;
  readonly onAllow: () => void;
  readonly onChangeAnyway: () => void;
  readonly onRunHereAnyway: () => void;
}

export function CoordinatorStandbyView(props: CoordinatorStandbyViewProps) {
  const chosen = props.choices.find((choice) => choice.environmentId === props.standby);
  return (
    <div data-coordinator-standby="">
      <SettingsRow
        title={props.title}
        description={
          <>
            <span className="block">
              Another copy can take over this coordinator when this machine stops answering.
            </span>
            {props.problem ? <span className="block">{props.problem}</span> : null}
          </>
        }
        control={
          <Select
            value={props.standby ?? "off"}
            disabled={props.pending}
            onValueChange={(value) =>
              props.onStandby(value === "off" ? null : (value as EnvironmentId))
            }
          >
            <SelectTrigger size="sm" aria-label="Take over automatically on">
              <SelectValue>{chosen ? chosen.label : "Off"}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectItem value="off">Off</SelectItem>
              {props.choices.map((choice) => (
                <SelectItem
                  key={choice.environmentId}
                  value={choice.environmentId}
                  disabled={props.problem !== null && choice.environmentId !== props.standby}
                >
                  {choice.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      {props.rearmStatus ? (
        <p
          role="status"
          data-standby-rearm-status=""
          className="px-3 py-2 text-sm text-muted-foreground sm:px-4"
        >
          {props.rearmStatus}
        </p>
      ) : null}
      {props.standby !== null ? (
        <SettingsRow
          title="After"
          description="How long this machine must stay quiet before the other copy takes over."
          control={
            <Select
              value={String(props.afterMinutes)}
              disabled={props.pending || props.problem !== null}
              onValueChange={(value) =>
                props.onAfter(Number(value) as CoordinatorStandbyAfterMinutes)
              }
            >
              <SelectTrigger size="sm" aria-label="Take over after">
                <SelectValue>{afterLabel(props.afterMinutes)}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {COORDINATOR_STANDBY_AFTER_MINUTES.map((minutes) => (
                  <SelectItem key={minutes} value={String(minutes)}>
                    {afterLabel(minutes)}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
      ) : null}
      {props.standby !== null && props.rearm ? <StandbyRearmList {...props.rearm} /> : null}
      {props.standby !== null && props.rearmNote ? (
        <p className="px-3 py-2 text-sm text-muted-foreground sm:px-4">{props.rearmNote}</p>
      ) : null}
      {props.rows.map((row) => (
        <SettingsRow
          key={row.environmentId}
          data-standby-machine=""
          title={row.text}
          description={row.error ?? undefined}
          control={
            row.state === "ready" ? null : (
              <Button
                size="sm"
                variant="outline"
                disabled={props.pending || props.problem !== null}
                title={props.problem ?? undefined}
                onClick={props.onAllow}
              >
                Allow
              </Button>
            )
          }
        />
      ))}
      {props.warning ? (
        <p className="px-3 py-2 text-sm text-muted-foreground sm:px-4">{props.warning}</p>
      ) : null}
      {props.fenceNote ? (
        <SettingsRow
          title={props.fenceNote}
          description="This turns off automatic takeover."
          control={
            <Button
              size="sm"
              variant="outline"
              disabled={props.pending}
              onClick={props.onRunHereAnyway}
            >
              Run here anyway
            </Button>
          }
        />
      ) : null}
      {props.message ? (
        <div
          role={props.message.error ? "alert" : "status"}
          className={`flex flex-wrap items-center gap-2 px-3 py-2 text-sm sm:px-4 ${props.message.error ? "text-destructive-foreground" : "text-muted-foreground"}`}
        >
          <span>{props.message.text}</span>
          {props.canChangeAnyway ? (
            <Button
              size="sm"
              variant="outline"
              disabled={props.pending}
              onClick={props.onChangeAnyway}
            >
              Change anyway
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/* ---------- Container: Settings > Project > Machines. ---------- */

type PendingChange =
  | {
      readonly kind: "arm";
      readonly standby: EnvironmentId;
      readonly afterMinutes: number;
      readonly order: ReadonlyArray<EnvironmentId>;
    }
  | { readonly kind: "list"; readonly order: ReadonlyArray<EnvironmentId> }
  | { readonly kind: "off" };

type RearmConsent = NonNullable<ProjectStandbyRearmStatus["consent"]>;

/** What the machines said about re-arming when the page opened or after the last change. */
interface RearmSeen {
  /** Each answering machine's consent; null for none. Absent machines did not answer. */
  readonly consents: ReadonlyMap<EnvironmentId, RearmConsent | null>;
  /** The coordinator's own re-arm after an automatic takeover. */
  readonly run: ProjectStandbyRearmStatus["run"];
  /** Each listed machine's fleet, for its worker grants. */
  readonly fleets: ReadonlyMap<EnvironmentId, StudioFleetSnapshot>;
}

const NO_REARM_SEEN: RearmSeen = { consents: new Map(), run: null, fleets: new Map() };

/** Without a known access on that machine, a listed machine gets the narrowest. */
const FALLBACK_REARM_ACCESS: StudioFleetWorkerAccess = "approval-required";

const sameOrder = (left: ReadonlyArray<EnvironmentId>, right: ReadonlyArray<EnvironmentId>) =>
  left.length === right.length &&
  left.every((environmentId, index) => right[index] === environmentId);

/**
 * "If this Mac goes quiet": the opt-in standby for one shared project's
 * coordinator, the arming rows for each worker machine, and what a takeover
 * changed. Only the desktop app arms it; any client can turn it off.
 */
export function CoordinatorStandbySettings({
  coordinator,
  shared,
}: {
  readonly coordinator: EnvironmentProject;
  readonly shared: ReadonlyArray<EnvironmentProject>;
}) {
  const machines = useLinkMachines();
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const setStandbyCommand = useAtomCommand(projectLink.setStandby, { reportFailure: false });
  const acceptStandbyCommand = useAtomCommand(projectLink.acceptStandby, {
    reportFailure: false,
  });
  const syncStatusCommand = useAtomCommand(projectLink.syncStatus, { reportFailure: false });
  const syncMembersCommand = useAtomCommand(projectLink.syncMembers, { reportFailure: false });
  const binding = coordinator.workspaceSettings?.coordinatorBinding;
  const identity = coordinator.workspaceSettings?.logicalProject;
  const current = binding?.state === "active" ? binding.standby : undefined;
  const [choice, setChoice] = useState<EnvironmentId | null>(current?.member.environmentId ?? null);
  const [afterMinutes, setAfterMinutes] = useState<CoordinatorStandbyAfterMinutes>(
    current?.afterMinutes ?? DEFAULT_COORDINATOR_STANDBY_AFTER_MINUTES,
  );
  const [results, setResults] = useState<ReadonlyMap<EnvironmentId, StandbyMachineResult>>(
    new Map(),
  );
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [retry, setRetry] = useState<PendingChange | null>(null);
  const running = useRef(false);
  const coordinatorFleet = useStudioFleet(coordinator.environmentId).snapshot;
  const standbyFleet = useStudioFleet(choice ?? coordinator.environmentId).snapshot;
  const remote = useProjectRemoteWorkers(coordinator.environmentId, coordinator.id);
  const capable = (environmentId: EnvironmentId) =>
    environments.find((item) => item.environmentId === environmentId)?.serverConfig?.environment
      .capabilities.coordinatorStandby === true;
  const rearmCapable = (environmentId: EnvironmentId) =>
    environments.find((item) => item.environmentId === environmentId)?.serverConfig?.environment
      .capabilities.coordinatorRearm === true;
  const membersSyncCapable = (environmentId: EnvironmentId) =>
    environments.find((item) => item.environmentId === environmentId)?.serverConfig?.environment
      .capabilities.linkedMembersSync === true;
  const [rearmSeen, setRearmSeen] = useState<RearmSeen>(NO_REARM_SEEN);
  const [rearmEdit, setRearmEdit] = useState<ReadonlyArray<EnvironmentId> | null>(null);
  const [rearmResults, setRearmResults] = useState<ReadonlyMap<EnvironmentId, RearmMachineResult>>(
    new Map(),
  );
  const [rearmRead, setRearmRead] = useState(0);

  const coordinatorLabel = machines.label(coordinator.environmentId);
  const coordinatorIsHere = coordinator.environmentId === primaryEnvironmentId;
  const copyOf = (environmentId: EnvironmentId) =>
    shared.find(
      (member) =>
        member.environmentId === environmentId &&
        member.workspaceSettings?.coordinatorBinding?.state === "transferred",
    );
  const choices = useMemo(
    () =>
      shared
        .filter(
          (member) =>
            member.environmentId !== coordinator.environmentId &&
            member.workspaceSettings?.coordinatorBinding?.state === "transferred",
        )
        .map((member) => ({
          environmentId: member.environmentId,
          label: machines.label(member.environmentId),
        })),
    [shared, coordinator.environmentId, machines],
  );
  const sideOf = (project: EnvironmentProject): StandbySide => ({
    environmentId: project.environmentId,
    projectId: project.id,
    member: linkMemberOf(project),
    label: machines.label(project.environmentId),
  });
  const workersFor = (standby: EnvironmentId) =>
    standbyWorkerMachines({
      coordinatorEnvironmentId: coordinator.environmentId,
      standbyEnvironmentId: standby,
      coordinatorFleet,
      members: shared,
      label: machines.label,
    });
  const workers = choice ? workersFor(choice) : [];
  const problemFor = (standby: EnvironmentId | null) =>
    standby
      ? standbyArmingProblem({
          desktop: isElectron,
          standbyLabel: machines.label(standby),
          standbyCapable: capable(standby),
          fullAccess: hasFullAccess,
          label: machines.label,
          coordinatorEnvironmentId: coordinator.environmentId,
          standbyEnvironmentId: standby,
          workers: workersFor(standby),
        })
      : isElectron
        ? null
        : "Set this up in the SpecWithCode desktop app.";
  const problem = problemFor(choice);

  // Every open, and after each change, asks each machine what list it holds.
  const readRearm = useRef<() => Promise<RearmSeen>>(async () => NO_REARM_SEEN);
  readRearm.current = async () => {
    const consents = new Map<EnvironmentId, RearmConsent | null>();
    let run: ProjectStandbyRearmStatus["run"] = null;
    const asked = shared.filter(
      (member) => rearmCapable(member.environmentId) && machines.connected(member.environmentId),
    );
    await Promise.all(
      asked.map(async (member) => {
        const result = await syncStatusCommand({
          environmentId: member.environmentId,
          input: { projectId: member.id },
        }).catch(() => null);
        if (result?._tag !== "Success") return;
        const status = result.value.standbyRearm;
        consents.set(member.environmentId, status?.consent ?? null);
        if (member.environmentId === coordinator.environmentId && member.id === coordinator.id)
          run = status?.run ?? null;
      }),
    );
    const listed = new Set<EnvironmentId>();
    for (const consent of consents.values())
      for (const member of consent?.members ?? []) listed.add(member.environmentId);
    const fleets = new Map<EnvironmentId, StudioFleetSnapshot>();
    await Promise.all(
      [...listed]
        .filter((environmentId) => machines.connected(environmentId))
        .map(async (environmentId) => {
          try {
            fleets.set(environmentId, await liveStandbyArmingCommands.fleet(environmentId));
          } catch {
            /* Unknown grants raise nothing. */
          }
        }),
    );
    return { consents, run, fleets };
  };
  const copiesKey = shared
    .map(
      (member) =>
        `${member.environmentId}:${member.id}:${member.workspaceSettings?.coordinatorBinding?.epoch ?? ""}`,
    )
    .join(",");
  useEffect(() => {
    let cancelled = false;
    void readRearm.current().then((seen) => {
      if (!cancelled) setRearmSeen(seen);
    });
    return () => {
      cancelled = true;
    };
  }, [copiesKey, rearmRead]);

  const sideFor = (member: { environmentId: EnvironmentId; projectId?: string }) => {
    const project =
      shared.find(
        (copy) => copy.environmentId === member.environmentId && copy.id === member.projectId,
      ) ?? shared.find((copy) => copy.environmentId === member.environmentId);
    return project ? sideOf(project) : undefined;
  };
  // The list the machines hold: the standby's first, else the coordinator's, else any.
  const listConsent =
    [
      current?.member.environmentId,
      coordinator.environmentId,
      ...shared.map((m) => m.environmentId),
    ]
      .map((environmentId) => (environmentId ? rearmSeen.consents.get(environmentId) : undefined))
      .find((consent) => consent !== undefined && consent !== null) ?? null;
  const previousRearm = (listConsent?.members ?? [])
    .map(sideFor)
    .filter((side) => side !== undefined);
  const rearmAccess = (environmentId: EnvironmentId) =>
    coordinatorFleet?.machines.find((machine) => machine.environmentId === environmentId)?.workers
      ?.access ?? FALLBACK_REARM_ACCESS;
  const rearmPlan = (
    standby: EnvironmentId,
    order: ReadonlyArray<EnvironmentId>,
  ): StandbyRearmPlan | undefined => {
    const next = rearmCapable(standby)
      ? order
          .filter((environmentId) => environmentId !== standby)
          .map((environmentId) => sideFor({ environmentId }))
          .filter((side) => side !== undefined)
      : [];
    if (next.length === 0 && previousRearm.length === 0) return undefined;
    return {
      order: next,
      previous: previousRearm,
      fromEpoch: highestEpoch(shared),
      capable: rearmCapable,
      access: rearmAccess,
      ...(identity
        ? {
            coordinator: {
              environmentId: coordinator.environmentId,
              logicalProjectId: identity.id,
              member: linkMemberOf(coordinator),
              epoch: binding?.epoch ?? 0,
              members: identity.members,
            },
          }
        : {}),
      membersSyncCapable,
    };
  };

  const projectCommands = {
    setStandby: async (environmentId: EnvironmentId, input: ProjectSetStandbyInput) => {
      const result = await setStandbyCommand({ environmentId, input });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
    },
    acceptStandby: async (environmentId: EnvironmentId, input: ProjectAcceptStandbyInput) => {
      const result = await acceptStandbyCommand({ environmentId, input });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
    },
    syncMembers: async (environmentId: EnvironmentId, input: ProjectLinkSyncMembersInput) => {
      const result = await syncMembersCommand({ environmentId, input });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
    },
  };

  /** A sentence about the list after a save, or "" when every machine is ready. */
  const rearmOutcomeText = (
    standby: EnvironmentId,
    outcome: ReadonlyMap<EnvironmentId, RearmMachineResult>,
  ) => {
    const own = outcome.get(standby);
    if (own && own.status !== "ready")
      return ` Arming the next machine after a takeover is off: ${
        own.status === "needs_update" ? `${machines.label(standby)} needs an update.` : own.message
      }`;
    return [...outcome.values()].some((result) => result.status !== "ready")
      ? " Some machines on the list are not ready yet."
      : "";
  };

  const apply = async (change: PendingChange, changeAnyway: boolean) => {
    if (running.current || !identity) return;
    running.current = true;
    setPending(true);
    setMessage(null);
    setRetry(null);
    const previous = current ? copyOf(current.member.environmentId) : undefined;
    try {
      if (change.kind === "off") {
        await disarmStandby(projectCommands, {
          logicalProjectId: identity.id,
          coordinator: sideOf(coordinator),
          standby: previous ? sideOf(previous) : null,
          operationId: randomUUID(),
          changeAnyway,
          rearmMembers: previousRearm,
          rearmCapable,
        });
        setResults(new Map());
        setRearmResults(new Map());
        setRearmEdit(null);
        setMessage({ text: "Automatic takeover is off.", error: false });
        return;
      }
      if (change.kind === "list") {
        if (!current || !previous) throw new Error("Turn automatic takeover on first.");
        const plan = rearmPlan(current.member.environmentId, change.order);
        const outcome = plan
          ? await saveRearmList(
              { ...liveStandbyArmingCommands, ...projectCommands },
              {
                logicalProjectId: identity.id,
                standby: sideOf(previous),
                afterMinutes: current.afterMinutes,
                chainId: randomUUID(),
                workers: workersFor(current.member.environmentId),
                plan,
              },
            )
          : new Map<EnvironmentId, RearmMachineResult>();
        setRearmResults(outcome);
        setRearmEdit(null);
        setMessage({
          text:
            change.order.length === 0
              ? "Nothing is armed next after a takeover."
              : `List saved.${rearmOutcomeText(current.member.environmentId, outcome)}`,
          error: false,
        });
        return;
      }
      const standby = copyOf(change.standby);
      if (!standby) throw new Error("That machine has no copy of this project.");
      const outcome = await armStandby(
        { ...liveStandbyArmingCommands, ...projectCommands },
        {
          logicalProjectId: identity.id,
          coordinator: sideOf(coordinator),
          epoch: binding?.epoch ?? 0,
          standby: sideOf(standby),
          previousStandby: previous ? sideOf(previous) : null,
          afterMinutes: change.afterMinutes as CoordinatorStandbyAfterMinutes,
          workers: workersFor(change.standby),
          operationId: randomUUID(),
          changeAnyway,
          rearm: rearmPlan(change.standby, change.order),
        },
      );
      setResults(outcome.machines);
      setRearmResults(outcome.rearm);
      if (outcome.armed) setRearmEdit(null);
      setMessage(
        outcome.armed
          ? {
              text: `${machines.label(change.standby)} takes over after ${change.afterMinutes} quiet minutes.${rearmOutcomeText(change.standby, outcome.rearm)}`,
              error: false,
            }
          : {
              text: `Not turned on yet. Allow ${machines.label(change.standby)} on every machine first.`,
              error: true,
            },
      );
    } catch (cause) {
      if (isStandbyUnreachable(cause)) setRetry(change);
      setMessage({
        text: failureText(cause, "The change did not finish. Try again."),
        error: true,
      });
    } finally {
      running.current = false;
      setPending(false);
      setRearmRead((read) => read + 1);
    }
  };

  const rows: StandbyRow[] = choice
    ? workers.map((worker) => {
        const result = results.get(worker.environmentId);
        const live = standbyFleet?.machines.some(
          (machine) =>
            machine.environmentId === worker.environmentId &&
            (machine.workers?.status === "allowed" || machine.workers?.status === "expiring"),
        );
        const state: StandbyRowState =
          result?.status === "failed"
            ? "failed"
            : result?.status === "ready" || (current?.member.environmentId === choice && live)
              ? "ready"
              : "unknown";
        return {
          environmentId: worker.environmentId,
          text: standbyRowText(worker.label, machines.label(choice), state),
          state,
          error: result?.status === "failed" ? result.message : null,
        };
      })
    : [];
  const standbyLabel = current ? machines.label(current.member.environmentId) : null;

  // "If it takes over, arm next": the other copies, then this coordinator once it gives way.
  const rearmCandidates = choice
    ? [
        ...shared.filter(
          (member) =>
            member.environmentId !== choice &&
            member.environmentId !== coordinator.environmentId &&
            member.workspaceSettings?.coordinatorBinding?.state === "transferred",
        ),
        coordinator,
      ].filter(
        (member, index, all) =>
          all.findIndex((other) => other.environmentId === member.environmentId) === index,
      )
    : [];
  const savedOrder = (listConsent?.members ?? [])
    .map((member) => member.environmentId)
    .filter((environmentId) => environmentId !== choice);
  const selectable = (environmentId: EnvironmentId) =>
    rearmCandidates.some((member) => member.environmentId === environmentId) &&
    rearmCapable(environmentId);
  const order = (rearmEdit ?? savedOrder).filter(selectable).slice(0, STANDBY_REARM_NEXT_MAX);
  const readiness =
    choice && listConsent
      ? rearmReadiness({
          members: [choice, ...savedOrder]
            .map((environmentId) => sideFor({ environmentId }))
            .filter((side) => side !== undefined),
          workers: workersFor(choice),
          capable: rearmCapable,
          grants: (from, on) => {
            const fleet = rearmSeen.fleets.get(from);
            if (!fleet) return undefined;
            return fleet.machines.find((machine) => machine.environmentId === on)?.workers ?? null;
          },
          consents: new Map(
            [...rearmSeen.consents].map(([environmentId, consent]) => [
              environmentId,
              consent?.chainId ?? null,
            ]),
          ),
          chainId: listConsent.chainId,
        })
      : [];
  const problemOfMachine = (environmentId: EnvironmentId): string | null => {
    const saved = rearmResults.get(environmentId);
    if (saved?.status === "failed") return saved.message;
    if (saved?.status === "needs_update") return rearmProblemText("needs_update");
    if (saved?.status === "ready") return null;
    const found = readiness.find((entry) => entry.member.environmentId === environmentId)?.problem;
    return found ? rearmProblemText(found) : null;
  };
  const standbyProblem = choice ? problemOfMachine(choice) : null;
  const rearmList: StandbyRearmListProps | null =
    choice && rearmCapable(choice)
      ? {
          standbyLabel: machines.label(choice),
          choices: rearmCandidates.map((member) => ({
            environmentId: member.environmentId,
            label: machines.label(member.environmentId),
            note: !rearmCapable(member.environmentId)
              ? "needs an update"
              : member.environmentId === coordinator.environmentId
                ? "only after it gives way"
                : null,
            disabled: !rearmCapable(member.environmentId),
            problem: problemOfMachine(member.environmentId),
          })),
          order,
          max: STANDBY_REARM_NEXT_MAX,
          changed: rearmEdit !== null && !sameOrder(order, savedOrder),
          needsPrepare: current !== undefined && readiness.some((entry) => entry.problem !== null),
          disabled: pending || problem !== null,
          onToggle: (environmentId, checked) =>
            setRearmEdit(
              checked
                ? [...order.filter((id) => id !== environmentId), environmentId].slice(
                    0,
                    STANDBY_REARM_NEXT_MAX,
                  )
                : order.filter((id) => id !== environmentId),
            ),
          onMove: (environmentId, by) => {
            const index = order.indexOf(environmentId);
            const target = index + by;
            if (index === -1 || target < 0 || target >= order.length) return;
            const next = [...order];
            [next[index], next[target]] = [next[target]!, next[index]!];
            setRearmEdit(next);
          },
          onSave: () => {
            if (current && current.member.environmentId === choice)
              void apply({ kind: "list", order }, false);
            else if (problemFor(choice) === null)
              void apply({ kind: "arm", standby: choice, afterMinutes, order }, false);
          },
          onPrepare: () => void apply({ kind: "list", order: savedOrder }, false),
        }
      : null;
  const rearmNote = !choice
    ? null
    : !rearmCapable(choice)
      ? rearmStandbyOldText(machines.label(choice))
      : standbyProblem
        ? `${machines.label(choice)}: ${standbyProblem}`
        : null;
  // A coordinator too old to lease to a standby offers nothing here.
  if (!capable(coordinator.environmentId) && !current) return null;

  return (
    <>
      <CoordinatorStandbyView
        title={standbySectionTitle(coordinatorLabel, coordinatorIsHere)}
        choices={choices}
        standby={choice}
        afterMinutes={afterMinutes}
        rows={rows}
        warning={
          choice
            ? standbyWarningText(machines.label(choice), coordinatorLabel, coordinatorIsHere)
            : null
        }
        problem={problem}
        rearm={rearmList}
        rearmNote={rearmNote}
        rearmStatus={rearmStatusText(rearmSeen.run, machines.label)}
        fenceNote={
          current && standbyLabel && !machines.connected(current.member.environmentId)
            ? `Checking with ${standbyLabel} before running.`
            : null
        }
        pending={pending}
        message={message}
        canChangeAnyway={retry !== null}
        onStandby={(environmentId) => {
          setChoice(environmentId);
          if (environmentId === null) {
            if (current) void apply({ kind: "off" }, false);
            return;
          }
          if (problemFor(environmentId) === null)
            void apply({ kind: "arm", standby: environmentId, afterMinutes, order }, false);
        }}
        onAfter={(minutes) => {
          setAfterMinutes(minutes);
          if (choice)
            void apply({ kind: "arm", standby: choice, afterMinutes: minutes, order }, false);
        }}
        onAllow={() =>
          choice && void apply({ kind: "arm", standby: choice, afterMinutes, order }, false)
        }
        onChangeAnyway={() => retry && void apply(retry, true)}
        onRunHereAnyway={() => {
          setChoice(null);
          void apply({ kind: "off" }, true);
        }}
      />
      <TakeoverNotices
        coordinator={coordinator}
        shared={shared}
        primaryEnvironmentId={primaryEnvironmentId}
        workers={remote.workers}
      />
    </>
  );
}

/**
 * What an automatic takeover changed: on the copy that took over, and for the
 * copy it replaced once that one is back.
 */
function TakeoverNotices({
  coordinator,
  shared,
  primaryEnvironmentId,
  workers,
}: {
  readonly coordinator: EnvironmentProject;
  readonly shared: ReadonlyArray<EnvironmentProject>;
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly workers: ReadonlyArray<{
    readonly machineLabel: string;
    readonly state: string;
  }>;
}) {
  const machines = useLinkMachines();
  const [handBack, setHandBack] = useState<string | null>(null);
  // Stable: the handoff dialog reports closing from an effect keyed on this callback.
  const handBackOpenChange = useCallback((open: boolean) => {
    if (!open) setHandBack(null);
  }, []);
  const binding = coordinator.workspaceSettings?.coordinatorBinding;
  if (binding?.state !== "active" || binding.takenOverBy !== "auto" || !binding.predecessor)
    return null;
  const predecessor = binding.predecessor;
  const successorLabel = machines.label(coordinator.environmentId);
  const previousLabel = machines.label(predecessor.environmentId);
  const reporting = new Map<string, number>();
  for (const worker of workers)
    if (worker.state === "following" || worker.state === "wake_pending" || worker.state === "idle")
      reporting.set(worker.machineLabel, (reporting.get(worker.machineLabel) ?? 0) + 1);
  const returned = shared.find(
    (member) =>
      member.environmentId === predecessor.environmentId &&
      member.id === predecessor.projectId &&
      member.workspaceSettings?.coordinatorBinding?.state === "transferred",
  );
  const handBackReady = machines.state(coordinator.environmentId) === "ready";
  return (
    <>
      {binding.takenOverAt ? (
        <SettingsRow
          title={tookOverText(successorLabel, previousLabel, binding.takenOverAt)}
          description={
            reporting.size > 0 ? (
              <>
                {[...reporting].map(([machine, count]) => (
                  <span key={machine} className="block">
                    {workersReportHereText(count, machine)}
                  </span>
                ))}
              </>
            ) : undefined
          }
        />
      ) : null}
      {returned ? (
        <SettingsRow
          data-standby-returned=""
          title={returnedText(
            successorLabel,
            previousLabel,
            returned.environmentId === primaryEnvironmentId,
          )}
          description={handBackReady ? undefined : handBackHint(successorLabel)}
          control={
            handBackReady ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setHandBack(`${returned.environmentId}:${returned.id}`)}
              >
                {returned.environmentId === primaryEnvironmentId
                  ? "Make this Mac the coordinator again"
                  : `Make ${previousLabel} the coordinator again`}
              </Button>
            ) : null
          }
        />
      ) : null}
      {returned && handBack ? (
        // The existing coordinator handoff, opened on the copy that coordinates now.
        <span className="hidden">
          <ProjectMachineHandoff
            project={coordinator}
            coordinatorId={linkMemberOf(coordinator).coordinatorThreadId}
            requestedTarget={handBack}
            onOpenChange={handBackOpenChange}
          />
        </span>
      ) : null}
    </>
  );
}
