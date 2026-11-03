import type {
  LogicalProjectMember,
  Project,
  ProjectCoordinatorBinding,
  ProjectId,
} from "@specweave-studio/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

import * as ProjectService from "./ProjectService.ts";

/**
 * Whether this machine's copy of a project runs its coordinator, and the
 * changes to that on this machine, for server code that acts only where it
 * coordinates (routines failover, for one).
 *
 * A copy's role is its own `workspaceSettings.coordinatorBinding`: it
 * coordinates while the binding is `active`, at the binding's epoch. A copy
 * with no binding, linked or not, is active at epoch 0. Each machine may run
 * its own coordinator, so several copies can be active at once; among them
 * the highest epoch is the project's newest, as `logicalCoordinator` in the
 * web client orders them. This service knows only this machine's copies: a
 * copy another machine superseded without reaching this one still reads as
 * active here until its lease loop hears of it and gives way.
 *
 * Changes are published where they happen, after they are written:
 * `took-over` from a person's or an automatic takeover and from starting this
 * copy's own coordinator; `gave-way` when this copy is superseded, including
 * the lease loop giving way to a standby that took over; `standby-armed` and
 * `standby-released` when this machine starts or stops standing by for
 * another copy's coordinator. A handoff of the whole project to another
 * machine is not published yet; read `roleOf` again after one. Subscribers
 * see only changes published after they subscribe.
 */

/** This machine's copy of a project as a coordinator. */
export interface CoordinatorRoleStatus {
  readonly projectId: ProjectId;
  /** The logical project shared across machines, or null when this copy is not linked. */
  readonly logicalProjectId: string | null;
  /** Whether this copy runs the project's coordinator. */
  readonly active: boolean;
  readonly epoch: number;
  readonly state: ProjectCoordinatorBinding["state"];
}

interface RoleChangeBase {
  /** This machine's copy. */
  readonly projectId: ProjectId;
  readonly logicalProjectId: string | null;
  /** When it was written here, on this machine's clock. */
  readonly at: string;
}

export type CoordinatorRoleChange =
  | (RoleChangeBase & {
      /** This copy coordinates now, at `epoch`. */
      readonly kind: "took-over";
      readonly epoch: number;
      /** The copy it replaced; null when it started its own coordinator beside the others. */
      readonly predecessor: LogicalProjectMember | null;
      readonly takenOverBy: "person" | "auto";
    })
  | (RoleChangeBase & {
      /** This copy no longer coordinates: another took over at `epoch`. */
      readonly kind: "gave-way";
      readonly epoch: number;
      readonly successor: LogicalProjectMember | null;
    })
  | (RoleChangeBase & {
      /** This machine stands by to take over `coordinator` automatically. */
      readonly kind: "standby-armed";
      readonly coordinator: LogicalProjectMember;
      readonly epoch: number;
      readonly afterMinutes: number;
    })
  | (RoleChangeBase & {
      /** This machine stopped standing by for the project's coordinator. */
      readonly kind: "standby-released";
      readonly reason: string;
    });

/** `Omit` over each change kind, so each keeps its own fields. */
type WithoutTime<Change> = Change extends unknown ? Omit<Change, "at"> : never;
export type CoordinatorRoleChangeInput = WithoutTime<CoordinatorRoleChange>;

/** The role a project's own binding gives this copy. */
export function coordinatorRoleOf(
  project: Pick<Project, "id" | "workspaceSettings">,
): CoordinatorRoleStatus {
  const settings = project.workspaceSettings;
  const binding = settings?.coordinatorBinding ?? { epoch: 0, state: "active" as const };
  return {
    projectId: project.id,
    logicalProjectId: settings?.logicalProject?.id ?? null,
    active: binding.state === "active",
    epoch: binding.epoch,
    state: binding.state,
  };
}

export interface CoordinatorRoleShape {
  /** This copy's role, or none when this machine has no such project (or it was deleted). */
  readonly roleOf: (projectId: ProjectId) => Effect.Effect<Option.Option<CoordinatorRoleStatus>>;
  /** Role changes on this machine from the moment of subscription. */
  readonly changes: Stream.Stream<CoordinatorRoleChange>;
  /** Records a change; called where the change is written. Never fails. */
  readonly publish: (change: CoordinatorRoleChangeInput) => Effect.Effect<void>;
}

export class CoordinatorRole extends Context.Service<CoordinatorRole, CoordinatorRoleShape>()(
  "specweave-studio/project/CoordinatorRole",
) {}

/**
 * The publish function for a service built with or without CoordinatorRole:
 * resolved when the publisher is made, since its handlers run in their
 * callers' context. Without the service nothing is published.
 */
export const publisher: Effect.Effect<CoordinatorRoleShape["publish"]> = Effect.map(
  Effect.serviceOption(CoordinatorRole),
  Option.match({
    onNone: () => () => Effect.void,
    onSome: (role) => role.publish,
  }),
);

export const make = Effect.gen(function* () {
  const projects = yield* ProjectService.ProjectService;
  const hub = yield* PubSub.unbounded<CoordinatorRoleChange>();

  const roleOf: CoordinatorRoleShape["roleOf"] = (projectId) =>
    projects.getById(projectId).pipe(
      Effect.map(
        Option.flatMap((project) =>
          project.deletedAt === null ? Option.some(coordinatorRoleOf(project)) : Option.none(),
        ),
      ),
      Effect.orElseSucceed(() => Option.none<CoordinatorRoleStatus>()),
    );

  const publish: CoordinatorRoleShape["publish"] = (change) =>
    Effect.gen(function* () {
      const at = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis));
      yield* PubSub.publish(hub, { ...change, at } as CoordinatorRoleChange);
      yield* Effect.logInfo("Coordinator role changed", {
        kind: change.kind,
        projectId: change.projectId,
        logicalProjectId: change.logicalProjectId,
      });
    });

  return CoordinatorRole.of({ roleOf, changes: Stream.fromPubSub(hub), publish });
});

/** Needs `ProjectService`. */
export const layer = Layer.effect(CoordinatorRole, make);
