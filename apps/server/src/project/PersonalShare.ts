/**
 * "Use my Percy on this machine" (1448 D-12): the owner's switch that lets
 * this machine join the one personal assistant of its SpecWithCode Connect
 * account, what the machine knows about that link, and undo.
 *
 * The switch is the server setting `personalAssistantShared`. Only this
 * service writes it, through `ServerSettingsService.setPersonalAssistantShared`;
 * the RPCs that reach it are owner-only (`RpcAuthorization`). Turning it on
 * never links anything by itself: the reconciler (T-14) links the seats whose
 * switches agree.
 */
import { normalizeMachineNickname } from "@specweave-studio/shared/machineNicknames";
import { machineAssistantOf } from "@specweave-studio/shared/personalAssistant";
import {
  DEFAULT_PERSONAL_ASSISTANT_NAME,
  type EnvironmentId,
  PERSONAL_ASSISTANT_SHARED_MAX_MACHINES,
  type PersonalAssistantShared,
  PersonalLinkError,
  type PersonalLinkSetSharedInput,
  type PersonalLinkUndoInput,
  type PersonalShareMachine,
  type PersonalShareMachineState,
  type PersonalShareRestorePoint,
  type PersonalShareStatus,
  type Project,
  type ServerSettings as ServerSettingsValue,
  WS_METHODS,
  WsPersonalShareRpcGroup,
} from "@specweave-studio/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as CloudLink from "../cloud/CloudLink.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as FleetTargets from "../fleet/FleetTargets.ts";
import { RpcInstrumentation } from "../observability/RpcInstrumentation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ManagedProjectFolders from "./ManagedProjectFolders.ts";
import { personalLinkIdForAccount } from "./personalLinkId.ts";
import * as PersonalLinkService from "./PersonalLinkService.ts";
import * as PersonalRestorePoint from "./personalRestorePoint.ts";
import * as ProjectService from "./ProjectService.ts";

/** Said when the switch is turned on on a machine that is not linked to Connect. */
export const PERSONAL_SHARE_NOT_CONNECTED_MESSAGE =
  "This machine is not linked to SpecWithCode Connect, so it cannot use your Percy. Link it in Settings > Machines > SpecWithCode Connect (or run `specwithcode connect` in a terminal), then turn Percy on.";

/** Said when the switch is turned on while Settings keeps the assistant off. */
export const PERSONAL_SHARE_ASSISTANT_OFF_MESSAGE =
  "The personal assistant is turned off on this machine. Turn it on in Settings > General, then turn Percy on.";

/** What the reconciler last learned about one other machine. */
export interface PersonalSharePeerState {
  readonly state: PersonalShareMachineState;
  readonly detail?: string | undefined;
  readonly lastSyncedAt?: string | undefined;
}

/**
 * The seam for the reconciler (1448 T-14): where each other machine stands,
 * by environment id, and the lock the share engine takes while it changes
 * this seat's link. Back it with state the reconciler also writes, not with
 * the reconciler itself, so this service stays below it in the layer graph.
 */
export class PersonalSharePeers extends Context.Service<
  PersonalSharePeers,
  {
    readonly states: Effect.Effect<ReadonlyMap<EnvironmentId, PersonalSharePeerState>>;
    /**
     * Runs `effect` under the engine's own lock (`PersonalShareStates.changing`),
     * so a switch change or an undo never runs while a join writes the link.
     */
    readonly changing: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  }
>()("specweave-studio/project/PersonalShare/PersonalSharePeers") {}

export class PersonalShare extends Context.Service<
  PersonalShare,
  {
    /** This machine's part in the account's Percy; reads only. */
    readonly status: Effect.Effect<PersonalShareStatus, PersonalLinkError>;
    /**
     * Turns the switch on or off. On needs a Connect link and the assistant
     * setting, and makes this machine's assistant when it has none. Off also
     * leaves the link; this machine keeps its data. Repeating a call changes
     * nothing.
     */
    readonly setShared: (
      input: PersonalLinkSetSharedInput,
    ) => Effect.Effect<PersonalShareStatus, PersonalLinkError>;
    /** Puts this machine's Percy back to a restore point (D-16). */
    readonly undo: (
      input: PersonalLinkUndoInput,
    ) => Effect.Effect<PersonalShareStatus, PersonalLinkError>;
  }
>()("specweave-studio/project/PersonalShare") {}

const NO_RESTORE_POINT_MESSAGE =
  "This machine has no saved copy of Percy to go back to. Nothing was changed.";

const refuse = (code: PersonalLinkError["code"], message: string, detail?: string) =>
  new PersonalLinkError({ code, message, ...(detail === undefined ? {} : { detail }) });

/** The confirmed machines as stored: each once, in order, never this machine. */
const confirmedMachines = (
  machines: ReadonlyArray<EnvironmentId>,
  self: EnvironmentId,
): ReadonlyArray<EnvironmentId> => [...new Set(machines)].filter((id) => id !== self);

const sameShared = (left: PersonalAssistantShared, right: PersonalAssistantShared) =>
  left.enabled === right.enabled &&
  (left.start ?? false) === (right.start ?? false) &&
  left.name === right.name &&
  left.enabledAt === right.enabledAt &&
  left.machines.length === right.machines.length &&
  left.machines.every((id, index) => id === right.machines[index]);

const make = Effect.gen(function* () {
  const projects = yield* ProjectService.ProjectService;
  const managedFolders = yield* ManagedProjectFolders.ManagedProjectFolders;
  const link = yield* PersonalLinkService.PersonalLinkService;
  const settings = yield* ServerSettings.ServerSettingsService;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const cloudLink = yield* CloudLink.CloudLink;
  const fleet = yield* FleetTargets.FleetTargets;
  const peers = yield* PersonalSharePeers;
  const restorePoints = yield* PersonalRestorePoint.PersonalRestorePoint;
  // One change at a time, and the engine's lock: two windows turning the switch never
  // interleave, and the switch never goes off while a join writes the link (1448 D-12).
  const changes = peers.changing;

  const readSettings = settings.getSettings.pipe(
    Effect.mapError((cause) =>
      refuse(
        "storage_failed",
        "Could not read this machine's settings.",
        cause.message.slice(0, 500),
      ),
    ),
  );

  /** The Connect account this machine is linked to. A failed read counts as none. */
  const readCloudUserId = cloudLink.linkState().pipe(
    Effect.map((state) => state.cloudUserId),
    Effect.orElseSucceed(() => null),
  );

  /** This machine's assistant, if it has one: the earliest personal project. */
  const readAssistant: Effect.Effect<Project | undefined, PersonalLinkError> =
    projects.snapshot.pipe(
      Effect.map((snapshot) => machineAssistantOf(snapshot.projects)),
      Effect.mapError(() => refuse("storage_failed", "Could not read this machine's projects.")),
    );

  /** Names this machine has for the others: the owner's name, else the fleet list's. */
  const labelOf = (current: ServerSettingsValue) =>
    fleet.load.pipe(
      Effect.map((config) => config?.machines ?? []),
      Effect.orElseSucceed(() => []),
      Effect.map((machines) => (id: EnvironmentId): string | null => {
        const nickname = normalizeMachineNickname(current.machineNicknames[id]?.name ?? "");
        if (nickname !== "") return nickname;
        return machines.find((machine) => machine.environmentId === id)?.label ?? null;
      }),
    );

  /** The saved copies of this machine's assistant, newest first; never a path. */
  const restorePointsOf = (assistant: Project | undefined) =>
    assistant === undefined
      ? Effect.succeed([])
      : restorePoints.list(assistant.id).pipe(
          Effect.map((points) =>
            points.map((point): PersonalShareRestorePoint => ({
              id: point.id,
              savedAt: point.savedAt,
              reason: point.reason,
              memoryFileCount: point.memoryFileCount,
            })),
          ),
          Effect.orElseSucceed((): ReadonlyArray<PersonalShareRestorePoint> => []),
        );

  const status: PersonalShare["Service"]["status"] = Effect.gen(function* () {
    const descriptor = yield* environment.getDescriptor;
    const self = descriptor.environmentId;
    const current = yield* readSettings;
    const shared = current.personalAssistantShared;
    const cloudUserId = yield* readCloudUserId;
    const assistant = yield* readAssistant;
    const identity = assistant?.workspaceSettings?.logicalProject;
    const linked = identity !== undefined && identity.members.length > 1;
    const members = linked ? identity.members : [];
    const peerStates = yield* peers.states;
    const label = yield* labelOf(current);
    const joined = new Set(members.map((member) => member.environmentId));
    const listed = confirmedMachines([...shared.machines, ...joined, ...peerStates.keys()], self);
    const machines = listed.map((environmentId): PersonalShareMachine => {
      const known = peerStates.get(environmentId);
      return {
        environmentId,
        label: label(environmentId),
        state: known?.state ?? (joined.has(environmentId) ? "joined" : "waiting"),
        ...(known?.detail === undefined ? {} : { detail: known.detail }),
        ...(known?.lastSyncedAt === undefined ? {} : { lastSyncedAt: known.lastSyncedAt }),
      };
    });
    const ownName = normalizeMachineNickname(current.machineNicknames[self]?.name ?? "");
    return {
      enabled: shared.enabled,
      environmentId: self,
      machineLabel: ownName === "" ? descriptor.label : ownName,
      connectLinked: cloudUserId !== null,
      linkId: cloudUserId === null ? null : personalLinkIdForAccount(cloudUserId),
      projectId: assistant?.id ?? null,
      assistantName: assistant?.title ?? null,
      linked,
      members,
      routineOwner: assistant?.workspaceSettings?.coordinatorBinding?.routineOwner ?? true,
      start: shared.start ?? false,
      machines,
      confirmedMachines: confirmedMachines(shared.machines, self),
      restorePoints: yield* restorePointsOf(assistant),
      refusal:
        cloudUserId === null ? "not_connected" : current.aideEnabled ? null : "assistant_off",
    };
  });

  const store = (current: PersonalAssistantShared, next: PersonalAssistantShared) => {
    if (sameShared(current, next)) return Effect.void;
    const write = settings.setPersonalAssistantShared;
    if (write === undefined)
      return Effect.fail(refuse("storage_failed", "This server cannot store the Percy switch."));
    return write(next).pipe(
      Effect.mapError((cause) =>
        refuse(
          "storage_failed",
          "Could not save the Percy switch on this machine.",
          cause.message.slice(0, 500),
        ),
      ),
      Effect.asVoid,
    );
  };

  /** This machine's assistant, made the way the app's "Set up" makes it when there is none. */
  const ensureAssistant = managedFolders
    .createNamedProject({ name: DEFAULT_PERSONAL_ASSISTANT_NAME, kind: "personal" })
    .pipe(
      Effect.mapError((cause) =>
        cause._tag === "PersonalAssistantDisabledError"
          ? refuse("assistant_off", PERSONAL_SHARE_ASSISTANT_OFF_MESSAGE)
          : refuse(
              "storage_failed",
              "Could not set up the personal assistant on this machine.",
              cause.message.slice(0, 500),
            ),
      ),
    );

  /** Leaves the link this seat is in, if any. The local memory and chats stay. */
  const leaveLink = Effect.gen(function* () {
    const assistant = yield* readAssistant;
    const members = assistant?.workspaceSettings?.logicalProject?.members ?? [];
    if (assistant === undefined || members.length <= 1) return;
    yield* link.leave({ projectId: assistant.id }).pipe(
      // Another window left it between the read and this call.
      Effect.catchIf(
        (error) => error.code === "not_linked",
        () => Effect.void,
      ),
    );
  });

  const setShared: PersonalShare["Service"]["setShared"] = (input) =>
    changes(
      Effect.gen(function* () {
        const self = yield* environment.getEnvironmentId;
        const current = yield* readSettings;
        const stored = current.personalAssistantShared;
        const machines = confirmedMachines(input.machines ?? stored.machines, self);
        if (machines.length > PERSONAL_ASSISTANT_SHARED_MAX_MACHINES)
          return yield* refuse(
            "invalid",
            `Percy can be shared with at most ${PERSONAL_ASSISTANT_SHARED_MAX_MACHINES} other machines.`,
          );
        const name = input.name ?? stored.name;
        // Turning the switch on is the owner's word: it clears an older removal of this machine.
        const enabledAt = !input.enabled
          ? undefined
          : stored.enabled && stored.enabledAt !== undefined
            ? stored.enabledAt
            : DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis));
        const next: PersonalAssistantShared = {
          enabled: input.enabled,
          machines,
          ...((input.start ?? stored.start) === true ? { start: true } : {}),
          ...(name === undefined ? {} : { name }),
          ...(enabledAt === undefined ? {} : { enabledAt }),
        };
        if (input.enabled) {
          // Refused before anything is made or stored, so a refusal changes nothing.
          if ((yield* readCloudUserId) === null)
            return yield* refuse("not_connected", PERSONAL_SHARE_NOT_CONNECTED_MESSAGE);
          if (!current.aideEnabled)
            return yield* refuse("assistant_off", PERSONAL_SHARE_ASSISTANT_OFF_MESSAGE);
          yield* ensureAssistant;
          yield* store(stored, next);
        } else {
          // Off first, so nothing links this seat again while it leaves.
          yield* store(stored, next);
          yield* leaveLink;
        }
        return yield* status;
      }),
    );

  /**
   * Puts this machine's Percy back to a saved copy (D-16): the newest one
   * saved before a link, or the one named. The switch goes off first, so
   * nothing links this seat again, then the seat leaves the link, then the
   * copy is restored; the state just before is saved as a "before-undo" point.
   */
  const undo: PersonalShare["Service"]["undo"] = (input) =>
    changes(
      Effect.gen(function* () {
        const assistant = yield* readAssistant;
        const points =
          assistant === undefined
            ? []
            : yield* restorePoints
                .list(assistant.id)
                .pipe(
                  Effect.mapError((cause) =>
                    refuse("storage_failed", cause.message, cause.message.slice(0, 500)),
                  ),
                );
        const chosen =
          input.restorePointId === undefined
            ? points.find((point) => point.reason === "before-link")
            : points.find((point) => point.id === input.restorePointId);
        if (assistant === undefined || chosen === undefined)
          return yield* refuse(
            "no_restore_point",
            input.restorePointId === undefined
              ? NO_RESTORE_POINT_MESSAGE
              : "That saved copy of Percy is not on this machine. Nothing was changed.",
          );
        const current = yield* readSettings;
        const { enabledAt: _on, ...stored } = current.personalAssistantShared;
        yield* store(current.personalAssistantShared, { ...stored, enabled: false });
        yield* leaveLink;
        yield* restorePoints
          .restore(assistant.id, chosen.id)
          .pipe(
            Effect.mapError((cause) =>
              cause._tag === "PersonalRestorePointMissingError"
                ? refuse("no_restore_point", cause.message)
                : refuse("storage_failed", cause.message),
            ),
          );
        return yield* status;
      }),
    );

  return PersonalShare.of({ status, setShared, undo });
});

export const layer = Layer.effect(PersonalShare, make);

export const layerRpcHandlers = WsPersonalShareRpcGroup.middleware(RpcInstrumentation).toLayer(
  Effect.gen(function* () {
    const service = yield* PersonalShare;
    return {
      [WS_METHODS.personalLinkSetShared]: (input) => service.setShared(input),
      [WS_METHODS.personalLinkShareStatus]: () => service.status,
      [WS_METHODS.personalLinkUndo]: (input) => service.undo(input),
    };
  }),
);
