import * as DateTime from "effect/DateTime";
import {
  EnvironmentId,
  ModelSelection,
  OrchestrationV2RunStatus,
  type OrchestrationV2ThreadLaunchWorkspaceStrategy,
  OrchestratorMcpFailure,
  type OrchestratorMcpDelegation,
  type OrchestratorMcpMachine,
  type OrchestratorMcpMachineListResult,
  type OrchestratorMcpMachineProvider,
  type OrchestratorMcpMachineRef,
  Project,
  ProjectId,
  type ProjectWorkerMachine,
  type ProviderInteractionMode,
  RunId,
  type RuntimeMode,
  ThreadId,
} from "@specweave-studio/contracts";
import {
  formatStudioThreadHref,
  formatStudioThreadLink,
  parseStudioThreadTarget,
} from "@specweave-studio/shared/studioThreadLinks";
import type { StudioFleetRemoteWorker } from "@specweave-studio/contracts/studioFleet";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import type { FleetTarget } from "../studioFleet.ts";
import * as FleetTargets from "./FleetTargets.ts";
import * as PhoneLinks from "./phoneLinks.ts";
import * as FleetWorkerGrants from "./FleetWorkerGrants.ts";
import * as RemoteStudioMcpClient from "./RemoteStudioMcpClient.ts";
import * as RemoteWorkerFollower from "./RemoteWorkerFollower.ts";
import {
  clampRuntimeMode,
  grantMachineStatus,
  matchRemoteProject,
  isLogicalProjectBinding,
  logicalProjectBindingMatch,
  matchLogicalRemoteProject,
  type RemoteProjectMatch,
  translateModel,
} from "./remoteWorkerMatching.ts";
import * as RemoteWorkerStore from "./RemoteWorkerStore.ts";

const PROBE_TTL = Duration.seconds(60);
/**
 * A machine reads its projects' repositories in the background after it
 * starts, so its first project list can lack them. Ask again a few times.
 */
const COLD_IDENTITY_RETRIES = 3;
const COLD_IDENTITY_DELAY = Duration.millis(500);
const MAX_REMOTE_PROJECT_PAGES = 5;
const LAUNCH_TIMEOUT_MS = 60_000;

export type MachineTarget =
  | { readonly kind: "local" }
  | { readonly kind: "remote"; readonly machine: OrchestratorMcpMachineRef };

export interface RemoteLaunchInput {
  readonly machine: OrchestratorMcpMachineRef;
  readonly commandId: string;
  readonly callerThreadId: ThreadId;
  readonly localProject: Project;
  readonly machineProjectId: ProjectId | undefined;
  readonly title: string;
  /** What the agent asked for; an unavailable model is then an error. */
  readonly explicitModelSelection: ModelSelection | undefined;
  /** What the thread would inherit here; the other machine's default replaces an unavailable one. */
  readonly inheritedModelSelection: ModelSelection | undefined;
  readonly runtimeMode: RuntimeMode;
  readonly requestedRuntimeMode: RuntimeMode | undefined;
  readonly interactionMode: ProviderInteractionMode;
  readonly workspaceStrategy: OrchestrationV2ThreadLaunchWorkspaceStrategy | undefined;
  readonly message: string | undefined;
  /** The SpecWeave increment ref, passed on unresolved. */
  readonly increment?: string | undefined;
  readonly reportBack: boolean;
  /** The machines this launch came through, ending with this one. */
  readonly delegation: OrchestratorMcpDelegation;
}

const RemoteLaunchAnswer = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  modelSelection: ModelSelection,
  runId: Schema.NullOr(RunId),
  status: Schema.NullOr(OrchestrationV2RunStatus),
});
const decodeLaunchAnswer = Schema.decodeUnknownOption(RemoteLaunchAnswer);
const decodeRunStatus = Schema.decodeUnknownOption(OrchestrationV2RunStatus);
const decodeThreadId = Schema.decodeUnknownOption(ThreadId);
const decodeRunId = Schema.decodeUnknownOption(RunId);

export interface RemoteLaunchResult {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  /** Unknown only for a launch found again after its answer was lost. */
  readonly modelSelection?: ModelSelection;
  readonly runId: RunId | null;
  readonly status: OrchestrationV2RunStatus | null;
  readonly machine: OrchestratorMcpMachineRef;
  /** `studio://thread/<environment>/<thread>`: the thread on its own machine. */
  readonly threadRef: string;
  /** Ready-made Markdown link to it, for the agent to give the user verbatim. */
  readonly threadLink: string;
  readonly reportsBack: boolean;
  /** The mode the worker was started with there. */
  readonly runtimeMode: RuntimeMode;
  /** Set when the machine's grant lowered the caller's own mode to `runtimeMode`. */
  readonly runtimeModeLoweredFrom?: RuntimeMode;
  /** Something the user should know about that machine, such as checks it is too old to make. */
  readonly machineNotice?: string;
}

/**
 * Workers a coordinator here runs on the other machines in the owner's
 * private fleet. Everything reaches another machine through its own `/mcp`
 * with a grant the user allowed in Settings, so that machine applies its own
 * checks; this side adds who may ask, which machine, which project there, and
 * a mode no broader than the grant.
 */
export interface RemoteWorkersShape {
  readonly enabled: boolean;
  readonly resolveMachine: (
    target: string | undefined,
  ) => Effect.Effect<MachineTarget, OrchestratorMcpFailure>;
  /** A thread id or `studio://thread/...` link, and the machine it lives on. */
  readonly resolveThread: (input: {
    readonly machine: string | undefined;
    readonly threadId: string;
  }) => Effect.Effect<
    { readonly target: MachineTarget; readonly threadId: ThreadId },
    OrchestratorMcpFailure
  >;
  /**
   * The configured machines and this server's grant on each. Only `probe`
   * asks each machine for its providers and matching project; callers
   * outside a Studio thread get the grant status alone.
   */
  readonly listMachines: (input: {
    readonly projectId: ProjectId | undefined;
    readonly probe: boolean;
  }) => Effect.Effect<OrchestratorMcpMachineListResult, OrchestratorMcpFailure>;
  readonly launch: (
    input: RemoteLaunchInput,
  ) => Effect.Effect<RemoteLaunchResult, OrchestratorMcpFailure>;
  /** Calls a thread tool there and labels the answer with the machine. */
  readonly proxy: (input: {
    readonly machine: OrchestratorMcpMachineRef;
    readonly tool: RemoteStudioMcpClient.RemoteTool;
    readonly arguments: Record<string, unknown>;
    readonly timeoutMs?: number | undefined;
  }) => Effect.Effect<Record<string, unknown>, OrchestratorMcpFailure>;
  /** The other machine's project matching `localProjectId`, for listing its threads. */
  readonly remoteProjectFor: (input: {
    readonly machine: OrchestratorMcpMachineRef;
    readonly localProjectId: ProjectId;
  }) => Effect.Effect<ProjectId, OrchestratorMcpFailure>;
  /**
   * A new run on a followed thread, such as after a message sent to it. Only
   * the thread that launched the worker moves its follower.
   */
  readonly noteRun: (input: {
    readonly callerThreadId: ThreadId;
    readonly machineId: string;
    readonly remoteThreadId: string;
    readonly runId: string;
  }) => Effect.Effect<void>;
  /**
   * A run the launching thread already saw finish, so its wake is not sent
   * again. Anyone else seeing it finish changes nothing.
   */
  readonly noteFinished: (input: {
    readonly callerThreadId: ThreadId;
    readonly machineId: string;
    readonly remoteThreadId: string;
    readonly runId: string | null;
    readonly status: string;
  }) => Effect.Effect<void>;
  /** Whether `callerThreadId` launched `remoteThreadId` on that machine, for steering it there. */
  readonly launchedBy: (input: {
    readonly callerThreadId: ThreadId;
    readonly machineId: string;
    readonly remoteThreadId: string;
  }) => Effect.Effect<boolean>;
  /** The machine the user chose for this project's workers, when the caller is its coordinator. */
  readonly coordinatorWorkerMachine: (input: {
    readonly projectId: ProjectId;
    readonly callerThreadId: ThreadId;
  }) => Effect.Effect<ProjectWorkerMachine | null>;
  readonly workersForProject: (
    projectId: ProjectId,
  ) => Effect.Effect<ReadonlyArray<StudioFleetRemoteWorker>>;
  /** Configured machines' names by environment id, for naming a delegation path. */
  readonly machineLabels: Effect.Effect<ReadonlyMap<string, string>>;
}

const failure = (code: OrchestratorMcpFailure["code"], message: string) =>
  new OrchestratorMcpFailure({ code, message });

const noMachines = (target: string) =>
  failure(
    "unknown_machine",
    `No machine named "${target}". studio_machine_list shows the machines this one can use.`,
  );

/** A thread link's environment (for another machine's thread) and decoded thread id. */
const parseStudioThreadRef = (value: string) => {
  const target = parseStudioThreadTarget(value);
  return target === null
    ? undefined
    : { threadId: target.candidates[0]!, environmentId: target.environmentId ?? undefined };
};

const decodeModelSelection = Schema.decodeUnknownOption(ModelSelection);

const isLocalName = (target: string | undefined) =>
  target === undefined || target.trim().toLowerCase() === "local";

/** Without a fleet, every target is this machine. Tests and servers without a fleet use this. */
const disabled: RemoteWorkersShape = {
  enabled: false,
  resolveMachine: (target) =>
    isLocalName(target) ? Effect.succeed({ kind: "local" }) : Effect.fail(noMachines(target!)),
  resolveThread: ({ machine, threadId }) => {
    const ref = parseStudioThreadRef(threadId);
    if (!isLocalName(machine)) return Effect.fail(noMachines(machine!));
    if (ref?.environmentId !== undefined) return Effect.fail(noMachines(ref.environmentId));
    return Effect.succeed({
      target: { kind: "local" },
      threadId: ThreadId.make(ref?.threadId ?? threadId),
    });
  },
  listMachines: () =>
    Effect.succeed({
      local: { id: "local", label: "This machine", environmentId: EnvironmentId.make("local") },
      machines: [],
      projectWorkerMachine: null,
    }),
  launch: (input) => Effect.fail(noMachines(input.machine.id)),
  proxy: (input) => Effect.fail(noMachines(input.machine.id)),
  remoteProjectFor: (input) => Effect.fail(noMachines(input.machine.id)),
  noteRun: () => Effect.void,
  noteFinished: () => Effect.void,
  launchedBy: () => Effect.succeed(false),
  coordinatorWorkerMachine: () => Effect.succeed(null),
  workersForProject: () => Effect.succeed([]),
  machineLabels: Effect.succeed(new Map()),
};

export class RemoteWorkers extends Context.Reference<RemoteWorkersShape>(
  "studio/fleet/RemoteWorkers",
  { defaultValue: () => disabled },
) {}

const KNOWN_FAILURE_CODES = new Set<string>(
  OrchestratorMcpFailure.fields.code.literals as ReadonlyArray<string>,
);

/** A remote call's error in the words an agent can act on. */
export function remoteFailure(
  machine: Pick<OrchestratorMcpMachineRef, "id" | "label">,
  error: RemoteStudioMcpClient.RemoteMcpError,
): OrchestratorMcpFailure {
  const { label } = machine;
  switch (error.reason) {
    case "unknown_machine":
      return noMachines(machine.id);
    case "not_authorized":
      return failure(
        "machine_not_authorized",
        error.grant === "revoked"
          ? `${label} revoked this machine's worker access. If it was revoked under "Who can run work on this Mac" there, allow this machine again on ${label} first; then allow workers again here in Settings > Connections.`
          : error.grant === "expired"
            ? `Worker access on ${label} expired. The user can allow workers again in Settings > Connections.`
            : `Workers are not allowed on ${label}. The user allows them in Settings > Connections.`,
      );
    case "unreachable":
      return failure("machine_unreachable", `${label} is unavailable right now.`);
    case "identity_mismatch":
      return failure(
        "machine_identity_mismatch",
        `The address configured for ${label} now answers as a different machine; nothing was sent.`,
      );
    case "unsupported":
      return failure(
        "machine_unsupported",
        `${label} runs a SpecWithCode version without remote workers.`,
      );
    case "refused":
      return failure("capability_denied", "That tool is not available on other machines.");
    case "invalid_response":
      return failure("orchestration_error", `${label} sent an answer this machine could not read.`);
    case "tool_failure": {
      const code =
        error.remoteCode && KNOWN_FAILURE_CODES.has(error.remoteCode)
          ? (error.remoteCode as OrchestratorMcpFailure["code"])
          : "orchestration_error";
      return failure(code, `${label}: ${error.remoteMessage ?? "the request was refused."}`);
    }
  }
}

const grantFailure = (
  machine: OrchestratorMcpMachineRef,
  error: FleetWorkerGrants.FleetWorkerGrantError,
) =>
  error.reason === "unknown_machine"
    ? noMachines(machine.id)
    : error.reason === "not_allowed" || error.reason === "revoked" || error.reason === "expired"
      ? remoteFailure(
          machine,
          new RemoteStudioMcpClient.RemoteMcpError({
            reason: "not_authorized",
            grant: error.reason,
          }),
        )
      : failure("orchestration_error", error.message);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * A worker that does not confirm its checks runs a version from before
 * per-project grants: it neither refuses delegation loops nor limits projects
 * or sign-ins. The work still starts; the agent and user are told.
 */
export const olderWorkerNotice = (machine: Pick<OrchestratorMcpMachineRef, "label">) =>
  `${machine.label} runs an older SpecWithCode that does not check delegation loops, project scope or which sign-ins remote work uses. Update SpecWithCode on ${machine.label} to enforce them there.`;

/**
 * The thread id is all a launch answer must carry: a machine on another
 * version may send a status or model shape this one cannot read, and the
 * thread it started there is followed all the same.
 */
const readLaunchAnswer = (value: unknown) => {
  const full = decodeLaunchAnswer(value);
  if (Option.isSome(full)) return full;
  if (!isRecord(value)) return Option.none();
  return Option.map(decodeThreadId(value.threadId), (threadId) => ({
    threadId,
    runId: Option.getOrNull(decodeRunId(value.runId)),
    status: Option.getOrNull(decodeRunStatus(value.status)),
    modelSelection: Option.getOrUndefined(decodeModelSelection(value.modelSelection)),
  }));
};

interface Probe {
  readonly at: number;
  readonly providers: ReadonlyArray<OrchestratorMcpMachineProvider>;
  readonly projects: ReadonlyArray<Project>;
}

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:\d{2})$/;
const isoOrNull = (value: unknown) =>
  typeof value === "string" && ISO_TIME.test(value) && Number.isFinite(Date.parse(value))
    ? value
    : null;

/**
 * The usage another machine shares for one provider, or undefined when it
 * shares none (an older version) or sends something malformed. Unknown
 * usage is never read as room.
 */
export const readProviderUsage = (
  value: unknown,
): OrchestratorMcpMachineProvider["usage"] | undefined => {
  if (!isRecord(value) || typeof value.signedIn !== "boolean") return undefined;
  const fingerprint =
    typeof value.accountFingerprint === "string" &&
    /^sha256:[a-f0-9]{64}$/.test(value.accountFingerprint)
      ? value.accountFingerprint
      : null;
  const used =
    typeof value.usedPercent === "number" &&
    Number.isFinite(value.usedPercent) &&
    value.usedPercent >= 0 &&
    value.usedPercent <= 100
      ? value.usedPercent
      : null;
  return {
    accountFingerprint: fingerprint,
    usedPercent: used,
    resetsAt: isoOrNull(value.resetsAt),
    signedIn: value.signedIn,
    observedAt: isoOrNull(value.observedAt),
    ...(value.limited === true ? { limited: true } : {}),
  } as OrchestratorMcpMachineProvider["usage"];
};

const readProviders = (capabilities: unknown): ReadonlyArray<OrchestratorMcpMachineProvider> =>
  (isRecord(capabilities) && Array.isArray(capabilities.providers) ? capabilities.providers : [])
    .filter(isRecord)
    .flatMap((provider) => {
      if (
        typeof provider.providerInstanceId !== "string" ||
        typeof provider.driverKind !== "string"
      )
        return [];
      const usage = readProviderUsage(provider.usage);
      const models = (Array.isArray(provider.models) ? provider.models : []).filter(isRecord);
      const paidModels = models.flatMap((model) =>
        typeof model.id === "string" && model.paid === true ? [model.id] : [],
      );
      return [
        {
          providerInstanceId: provider.providerInstanceId,
          driverKind: provider.driverKind,
          models: models.flatMap((model) => (typeof model.id === "string" ? [model.id] : [])),
          available: Array.isArray(provider.constraints) && provider.constraints.length === 0,
          ...(usage === undefined ? {} : { usage }),
          ...(typeof provider.allowedByGrant === "boolean"
            ? { allowedByGrant: provider.allowedByGrant }
            : {}),
          ...(paidModels.length === 0 ? {} : { paidModels }),
        } as unknown as OrchestratorMcpMachineProvider,
      ];
    });

const make = Effect.gen(function* () {
  const targets = yield* FleetTargets.FleetTargets;
  const grants = yield* FleetWorkerGrants.FleetWorkerGrants;
  const client = yield* RemoteStudioMcpClient.RemoteStudioMcpClient;
  const store = yield* RemoteWorkerStore.RemoteWorkerStore;
  const follower = yield* RemoteWorkerFollower.RemoteWorkerFollower;
  const projects = yield* ProjectService.ProjectService;
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const probes = yield* Ref.make<ReadonlyMap<string, Probe>>(new Map());

  const machines = targets.load.pipe(
    Effect.map((config) => config?.machines ?? []),
    Effect.mapError(() =>
      failure("orchestration_error", "Private machine configuration could not be read securely."),
    ),
  );
  const refOf = (target: FleetTarget): OrchestratorMcpMachineRef => ({
    id: target.id,
    label: target.label,
    environmentId: target.environmentId,
  });

  const resolveMachine: RemoteWorkersShape["resolveMachine"] = (target) =>
    Effect.gen(function* () {
      if (isLocalName(target)) return { kind: "local" } as const;
      const wanted = target!.trim();
      if (wanted === (yield* environment.getEnvironmentId)) return { kind: "local" } as const;
      const configured = yield* machines;
      const lower = wanted.toLowerCase();
      const byId = configured.find((machine) => machine.id === lower);
      if (byId) return { kind: "remote", machine: refOf(byId) } as const;
      const byEnvironment = configured.find((machine) => machine.environmentId === wanted);
      if (byEnvironment) return { kind: "remote", machine: refOf(byEnvironment) } as const;
      const byLabel = configured.filter((machine) => machine.label.toLowerCase() === lower);
      if (byLabel.length === 1) return { kind: "remote", machine: refOf(byLabel[0]!) } as const;
      return yield* noMachines(wanted);
    });

  const resolveThread: RemoteWorkersShape["resolveThread"] = ({ machine, threadId }) =>
    Effect.gen(function* () {
      const ref = parseStudioThreadRef(threadId);
      const bareId = ThreadId.make(ref?.threadId ?? threadId);
      const fromMachine = yield* resolveMachine(machine);
      if (ref?.environmentId === undefined) return { target: fromMachine, threadId: bareId };
      const fromLink = yield* resolveMachine(ref.environmentId);
      if (machine !== undefined) {
        const same =
          fromMachine.kind === fromLink.kind &&
          (fromMachine.kind === "local" ||
            (fromLink.kind === "remote" && fromLink.machine.id === fromMachine.machine.id));
        if (!same)
          return yield* failure(
            "invalid_request",
            "The thread link names a different machine than machine; pass one of them.",
          );
      }
      return { target: fromLink, threadId: bareId };
    });

  const call = (
    machine: OrchestratorMcpMachineRef,
    tool: RemoteStudioMcpClient.RemoteTool,
    args: Record<string, unknown>,
    timeoutMs?: number,
  ) =>
    client
      .call({ machineId: machine.id, tool, arguments: args, timeoutMs })
      .pipe(Effect.mapError((error) => remoteFailure(machine, error)));

  /** The other machine's providers and projects, kept for a minute. */
  const probe = (machine: OrchestratorMcpMachineRef, fresh = false) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const cached = (yield* Ref.get(probes)).get(machine.id);
      if (!fresh && cached && now - cached.at < Duration.toMillis(PROBE_TTL)) return cached;
      const capabilities = yield* client.call({
        machineId: machine.id,
        tool: "orchestrator_capabilities",
        arguments: {},
      });
      const listed: Project[] = [];
      let cursor: number | null = 0;
      for (let page = 0; page < MAX_REMOTE_PROJECT_PAGES && cursor !== null; page++) {
        const result: unknown = yield* client.call({
          machineId: machine.id,
          tool: "studio_project_list",
          arguments: { cursor, limit: 100 },
        });
        const rows = isRecord(result) && Array.isArray(result.projects) ? result.projects : [];
        listed.push(...(rows.filter(isRecord) as unknown as Project[]));
        cursor =
          isRecord(result) && typeof result.nextCursor === "number" ? result.nextCursor : null;
      }
      const next: Probe = { at: now, providers: readProviders(capabilities), projects: listed };
      yield* Ref.update(probes, (current) => new Map(current).set(machine.id, next));
      return next;
    });

  const localProject = (projectId: ProjectId) =>
    projects.getById(projectId).pipe(
      Effect.map(Option.getOrUndefined),
      Effect.mapError(() => failure("orchestration_error", "The project could not be read.")),
    );

  const matchFor = (
    machine: OrchestratorMcpMachineRef,
    project: Project,
    remoteProjects: ReadonlyArray<Project>,
    explicit: ProjectId | undefined,
  ): RemoteProjectMatch => {
    const configured = project.workspaceSettings?.workerMachine;
    // The saved project only counts on the machine it was saved for.
    const sameMachine =
      configured?.machineId === machine.id && configured.environmentId === machine.environmentId;
    const projectId = explicit ?? (sameMachine ? (configured.projectId ?? undefined) : undefined);
    const logical = project.workspaceSettings?.logicalProject;
    return logical != null
      ? matchLogicalRemoteProject({
          logical,
          environmentId: machine.environmentId,
          remote: remoteProjects,
          projectId,
        })
      : matchRemoteProject({ local: project, remote: remoteProjects, projectId });
  };

  const listMachines: RemoteWorkersShape["listMachines"] = ({ projectId, probe: probing }) =>
    Effect.gen(function* () {
      const descriptor = yield* environment.getDescriptor;
      const project = projectId === undefined ? undefined : yield* localProject(projectId);
      const configured = yield* machines;
      const rows = yield* Effect.forEach(
        configured,
        (target) =>
          Effect.gen(function* () {
            const machine = refOf(target);
            const workers = yield* grants.status(target.id);
            let status = grantMachineStatus(workers);
            const row: {
              -readonly [K in keyof OrchestratorMcpMachine]: OrchestratorMcpMachine[K];
            } = {
              ...machine,
              status,
              access: workers.access,
              grantExpiresAt: workers.expiresAt,
            };
            if (!probing || (status !== "ready" && status !== "grant_expiring")) return row;
            const probed = yield* probe(machine).pipe(Effect.result);
            if (probed._tag === "Failure") {
              const error = probed.failure;
              status =
                error.reason === "identity_mismatch"
                  ? "identity_mismatch"
                  : error.reason === "unsupported"
                    ? "unsupported"
                    : error.reason === "not_authorized"
                      ? error.grant === "expired"
                        ? "grant_expired"
                        : error.grant === "not_allowed"
                          ? "needs_grant"
                          : "grant_revoked"
                      : "unreachable";
              return { ...row, status };
            }
            row.providers = probed.success.providers;
            if (project !== undefined) {
              const { reason: _reason, ...match } = matchFor(
                machine,
                project,
                probed.success.projects,
                undefined,
              );
              row.project = match;
            }
            return row;
          }),
        { concurrency: 4 },
      );
      return {
        local: {
          id: "local" as const,
          label: descriptor.label,
          environmentId: descriptor.environmentId,
        },
        machines: rows,
        projectWorkerMachine: project?.workspaceSettings?.workerMachine?.machineId ?? null,
      };
    });

  const remoteProjectId = (
    machine: OrchestratorMcpMachineRef,
    project: Project,
    explicit: ProjectId | undefined,
  ) =>
    Effect.gen(function* () {
      const logical = project.workspaceSettings?.logicalProject;
      if (logical != null) {
        const configured = project.workspaceSettings?.workerMachine;
        const sameMachine =
          configured?.machineId === machine.id &&
          configured.environmentId === machine.environmentId;
        const selected = logicalProjectBindingMatch({
          logical,
          environmentId: machine.environmentId,
          projectId: explicit ?? (sameMachine ? (configured.projectId ?? undefined) : undefined),
        });
        if (selected.match === "ambiguous")
          return yield* failure(
            "project_ambiguous_on_machine",
            `${machine.label}: ${selected.reason}`,
          );
        if (selected.match === "none" || selected.projectId === undefined)
          return yield* failure(
            "project_unavailable_on_machine",
            `${machine.label}: ${selected.reason}`,
          );
        const member = logical.members.find(
          (binding) =>
            binding.environmentId === machine.environmentId &&
            binding.projectId === selected.projectId,
        )!;
        // A fresh exact read avoids stale probe caches and the paginated project-list cap.
        const linked = yield* call(machine, "studio_project_read", {
          projectId: member.projectId,
        }).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Project)),
          Effect.mapError((error) =>
            Schema.is(OrchestratorMcpFailure)(error)
              ? error
              : failure(
                  "project_unavailable_on_machine",
                  "The destination project could not be verified.",
                ),
          ),
        );
        if (!isLogicalProjectBinding(linked, logical, member))
          return yield* failure(
            "project_unavailable_on_machine",
            "The destination project no longer belongs to this logical project.",
          );
        const capabilities = yield* call(machine, "orchestrator_capabilities", {});
        return { projectId: member.projectId, providers: readProviders(capabilities) };
      }
      const probed = yield* probe(machine).pipe(
        Effect.mapError((error) => remoteFailure(machine, error)),
      );
      let match = matchFor(machine, project, probed.projects, explicit);
      if (match.match === "none" && explicit !== undefined) {
        // The project may have been registered there in the last minute.
        const fresh = yield* probe(machine, true).pipe(
          Effect.mapError((error) => remoteFailure(machine, error)),
        );
        match = matchFor(machine, project, fresh.projects, explicit);
      }
      let listed = probed.projects;
      for (
        let attempt = 0;
        attempt < COLD_IDENTITY_RETRIES &&
        match.match === "none" &&
        listed.some((candidate) => !candidate.repositoryIdentity);
        attempt++
      ) {
        if (attempt > 0) yield* Effect.sleep(COLD_IDENTITY_DELAY);
        const fresh = yield* probe(machine, true).pipe(
          Effect.mapError((error) => remoteFailure(machine, error)),
        );
        listed = fresh.projects;
        match = matchFor(machine, project, listed, explicit);
      }
      if (match.match === "ambiguous")
        return yield* failure(
          "project_ambiguous_on_machine",
          `Several projects on ${machine.label} match this one: ${(match.candidates ?? [])
            .map((candidate) => `${candidate.title} (${candidate.projectId})`)
            .join(", ")}. Pass machineProjectId.`,
        );
      if (match.match === "none" || match.projectId === undefined)
        return yield* failure(
          "project_unavailable_on_machine",
          `${machine.label}: ${match.reason ?? "no matching project."}`,
        );
      return { projectId: match.projectId, providers: probed.providers };
    });

  const driverKindOf = (instanceId: string) =>
    providers.getProviders.pipe(
      Effect.map((list) => list.find((provider) => provider.instanceId === instanceId)?.driver),
    );

  const translate = (
    machine: OrchestratorMcpMachineRef,
    selection: ModelSelection,
    remote: ReadonlyArray<OrchestratorMcpMachineProvider>,
  ) =>
    Effect.map(driverKindOf(selection.instanceId), (driverKind) =>
      translateModel({ selection, driverKind, remote }),
    ).pipe(Effect.map((translation) => ({ machine, translation })));

  const modelUnavailable = (machine: OrchestratorMcpMachineRef, selection: ModelSelection) =>
    failure(
      "model_unavailable_on_machine",
      `${machine.label} has no provider offering ${selection.model}. studio_machine_list shows its providers and models.`,
    );

  const isoNow = Effect.map(Clock.currentTimeMillis, (millis) =>
    DateTime.formatIso(DateTime.makeUnsafe(millis)),
  );

  const writeRow = (
    rowId: string,
    change: (
      row: RemoteWorkerStore.RemoteWorkerRecord | undefined,
    ) => RemoteWorkerStore.RemoteWorkerRecord | undefined,
  ) =>
    store
      .modify(rowId, change)
      .pipe(
        Effect.mapError(() =>
          failure("orchestration_error", "The remote worker could not be recorded."),
        ),
      );

  const launch: RemoteWorkersShape["launch"] = (input) =>
    Effect.gen(function* () {
      const { machine } = input;
      const credential = yield* grants
        .credential(machine.id)
        .pipe(Effect.mapError((error) => grantFailure(machine, error)));
      const clamped = clampRuntimeMode({
        started: input.runtimeMode,
        requested: input.requestedRuntimeMode,
        ceiling: credential.access,
      });
      if (!clamped.ok)
        return yield* failure(
          "runtime_mode_escalation_denied",
          `${machine.label} allows workers up to ${credential.access}; ${input.requestedRuntimeMode} is broader.`,
        );
      if (clamped.loweredFrom !== undefined)
        yield* Effect.logWarning("Remote worker starts below its caller's mode", {
          machineId: machine.id,
          callerThreadId: input.callerThreadId,
          runtimeMode: clamped.mode,
          loweredFrom: clamped.loweredFrom,
        });
      const target = yield* remoteProjectId(machine, input.localProject, input.machineProjectId);

      let modelSelection: ModelSelection | undefined;
      if (input.explicitModelSelection !== undefined) {
        const { translation } = yield* translate(
          machine,
          input.explicitModelSelection,
          target.providers,
        );
        if (translation.type === "unavailable")
          return yield* modelUnavailable(machine, input.explicitModelSelection);
        modelSelection = translation.modelSelection;
      } else if (input.inheritedModelSelection !== undefined) {
        const { translation } = yield* translate(
          machine,
          input.inheritedModelSelection,
          target.providers,
        );
        modelSelection =
          translation.type === "unavailable" ? undefined : translation.modelSelection;
      }

      const rowId = `rwt:${input.commandId}`;
      const startedAt = yield* isoNow;
      yield* writeRow(rowId, () => ({
        id: rowId,
        callerThreadId: input.callerThreadId,
        projectId: input.localProject.id,
        machineId: machine.id,
        environmentId: machine.environmentId,
        remoteProjectId: target.projectId,
        remoteThreadId: null,
        title: input.title,
        launchStartedAt: startedAt,
        followedRunId: null,
        reportBack: input.reportBack,
        state: "launching",
        lastStatus: null,
        deliveredRunIds: [],
        lostContactNotified: false,
        lastError: null,
        updatedAt: startedAt,
      }));
      return yield* follower.trackLaunch(rowId)(
        sendAndRecord({ input, rowId, target, modelSelection, clamped }),
      );
    });

  const sendAndRecord = ({
    input,
    rowId,
    target,
    modelSelection,
    clamped,
  }: {
    readonly input: RemoteLaunchInput;
    readonly rowId: string;
    readonly target: {
      readonly projectId: ProjectId;
      readonly providers: ReadonlyArray<OrchestratorMcpMachineProvider>;
    };
    readonly modelSelection: ModelSelection | undefined;
    readonly clamped: { readonly mode: RuntimeMode; readonly loweredFrom?: RuntimeMode };
  }) =>
    Effect.gen(function* () {
      const { machine } = input;
      const dispose = (lastError: string) =>
        Effect.gen(function* () {
          const updatedAt = yield* isoNow;
          yield* store
            .modify(rowId, (row) =>
              row ? { ...row, state: "disposed", lastError, updatedAt } : undefined,
            )
            .pipe(Effect.ignore);
        });

      const send = (selection: ModelSelection | undefined) =>
        client.call({
          machineId: machine.id,
          tool: "studio_thread_launch",
          arguments: {
            projectId: target.projectId,
            title: input.title,
            ...(selection === undefined ? {} : { modelSelection: selection }),
            runtimeMode: clamped.mode,
            interactionMode: input.interactionMode,
            ...(input.workspaceStrategy === undefined
              ? {}
              : { workspaceStrategy: input.workspaceStrategy }),
            ...(input.message === undefined ? {} : { message: input.message }),
            ...(input.increment === undefined ? {} : { increment: input.increment }),
            delegation: input.delegation,
          },
          timeoutMs: LAUNCH_TIMEOUT_MS,
        });

      let attempt = yield* send(modelSelection).pipe(Effect.result);
      // The other machine's project has no default model and none was translatable.
      if (
        attempt._tag === "Failure" &&
        attempt.failure.reason === "tool_failure" &&
        modelSelection === undefined &&
        /Pass modelSelection/u.test(attempt.failure.remoteMessage ?? "")
      ) {
        const fallback = input.localProject.defaultModelSelection;
        const translated =
          fallback === null
            ? undefined
            : (yield* translate(machine, fallback, target.providers)).translation;
        if (translated === undefined || translated.type === "unavailable") {
          yield* dispose("No model available there.");
          return yield* modelUnavailable(
            machine,
            fallback ??
              input.inheritedModelSelection ??
              ({ model: "a default model" } as ModelSelection),
          );
        }
        attempt = yield* send(translated.modelSelection).pipe(Effect.result);
      }

      let launched: {
        readonly threadId: ThreadId;
        readonly runId: RunId | null;
        readonly status: OrchestrationV2RunStatus | null;
        readonly modelSelection: ModelSelection | undefined;
        /** Whether that machine said it checked the delegation path and its grant's scope. */
        readonly grantChecked: boolean | undefined;
      };
      if (attempt._tag === "Success") {
        const answer = readLaunchAnswer(attempt.success);
        if (Option.isNone(answer)) {
          yield* dispose("Unreadable launch answer.");
          return yield* failure(
            "remote_launch_unconfirmed",
            `${machine.label} sent an unreadable answer; check studio_thread_list {machine:"${machine.id}"} before retrying.`,
          );
        }
        launched = {
          ...answer.value,
          modelSelection: answer.value.modelSelection ?? modelSelection,
          grantChecked: isRecord(attempt.success) && attempt.success.delegationChecked === true,
        };
      } else {
        const error = attempt.failure;
        // Only these leave it open whether the other machine started the thread.
        if (error.reason !== "unreachable" && error.reason !== "invalid_response") {
          yield* dispose(error.message);
          return yield* remoteFailure(machine, error);
        }
        const row = yield* store.list.pipe(
          Effect.map((rows) => rows.find((candidate) => candidate.id === rowId)),
          Effect.orElseSucceed(() => undefined),
        );
        const found =
          row === undefined
            ? undefined
            : yield* follower.reconcile(row).pipe(Effect.orElseSucceed(() => undefined));
        if (found === undefined) {
          const updatedAt = yield* isoNow;
          yield* store
            .modify(rowId, (current) =>
              current
                ? { ...current, state: "launch_unknown", lastError: error.message, updatedAt }
                : undefined,
            )
            .pipe(Effect.ignore);
          return yield* failure(
            "remote_launch_unconfirmed",
            `The launch on ${machine.label} may or may not have started a thread. Check studio_thread_list {machine:"${machine.id}"} before launching again.`,
          );
        }
        const foundModel: ModelSelection | undefined =
          found.providerInstanceId !== null && found.model !== null
            ? Option.getOrUndefined(
                decodeModelSelection({
                  instanceId: found.providerInstanceId,
                  model: found.model,
                }),
              )
            : undefined;
        launched = {
          threadId: ThreadId.make(found.threadId),
          runId: found.runId === null ? null : RunId.make(found.runId),
          status: Option.getOrNull(decodeRunStatus(found.status)),
          modelSelection: foundModel ?? modelSelection,
          // A launch found again after a lost answer says nothing about its checks.
          grantChecked: undefined,
        };
      }

      const runId = launched.runId;
      // Once the thread exists there, recording and following it must not be cut off.
      yield* Effect.uninterruptible(
        Effect.gen(function* () {
          const updatedAt = yield* isoNow;
          yield* store
            .modify(rowId, (row) =>
              row
                ? {
                    ...row,
                    remoteThreadId: launched.threadId,
                    followedRunId: runId,
                    state: runId === null ? "idle" : "following",
                    lastStatus: launched.status,
                    updatedAt,
                  }
                : undefined,
            )
            .pipe(Effect.ignore);
          if (runId !== null) yield* follower.follow(rowId);
        }),
      );
      return {
        threadId: launched.threadId,
        projectId: target.projectId,
        ...(launched.modelSelection === undefined
          ? {}
          : { modelSelection: launched.modelSelection }),
        runId: launched.runId,
        status: launched.status,
        machine,
        threadRef: formatStudioThreadHref(launched.threadId, machine.environmentId),
        threadLink: formatStudioThreadLink(launched.threadId, input.title, machine.environmentId),
        reportsBack: input.reportBack,
        runtimeMode: clamped.mode,
        ...(clamped.loweredFrom === undefined
          ? {}
          : { runtimeModeLoweredFrom: clamped.loweredFrom }),
        ...(launched.grantChecked === false ? { machineNotice: olderWorkerNotice(machine) } : {}),
      };
    });

  const proxy: RemoteWorkersShape["proxy"] = (input) =>
    call(input.machine, input.tool, input.arguments, input.timeoutMs).pipe(
      Effect.flatMap((result) =>
        isRecord(result)
          ? Effect.succeed({ ...result, machine: input.machine })
          : Effect.fail(
              failure("orchestration_error", `${input.machine.label} sent an unreadable answer.`),
            ),
      ),
    );

  const remoteProjectFor: RemoteWorkersShape["remoteProjectFor"] = ({ machine, localProjectId }) =>
    Effect.gen(function* () {
      const project = yield* localProject(localProjectId);
      if (project === undefined)
        return yield* failure("invalid_request", "The project was not found.");
      const logical = project.workspaceSettings?.logicalProject;
      if (logical != null) {
        const bindings = [
          ...new Map(
            logical.members
              .filter((member) => member.environmentId === machine.environmentId)
              .map((member) => [member.projectId, member]),
          ).values(),
        ];
        if (bindings.length !== 1)
          return yield* failure(
            "invalid_request",
            bindings.length === 0
              ? "This logical project has no binding on that machine. Pass an explicit projectId."
              : "This logical project has multiple bindings on that machine. Use the default federated inventory or pass an explicit projectId.",
          );
        const member = bindings[0]!;
        const linked = yield* call(machine, "studio_project_read", {
          projectId: member.projectId,
        }).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Project)),
          Effect.mapError((error) =>
            Schema.is(OrchestratorMcpFailure)(error)
              ? error
              : failure("invalid_request", "The linked project could not be verified."),
          ),
        );
        if (!isLogicalProjectBinding(linked, logical, member))
          return yield* failure(
            "invalid_request",
            "The linked project no longer belongs to this logical project.",
          );
        return member.projectId;
      }
      return (yield* remoteProjectId(machine, project, undefined)).projectId;
    });

  const noteRun: RemoteWorkersShape["noteRun"] = ({
    callerThreadId,
    machineId,
    remoteThreadId,
    runId,
  }) =>
    Effect.gen(function* () {
      const rows = yield* store.list.pipe(Effect.orElseSucceed(() => []));
      const row = rows.find(
        (candidate) =>
          candidate.callerThreadId === callerThreadId &&
          candidate.machineId === machineId &&
          candidate.remoteThreadId === remoteThreadId &&
          candidate.state !== "disposed",
      );
      if (!row) return;
      const updatedAt = yield* isoNow;
      yield* store
        .modify(row.id, (current) =>
          current
            ? { ...current, followedRunId: runId, state: "following", lastError: null, updatedAt }
            : undefined,
        )
        .pipe(Effect.ignore);
      yield* follower.follow(row.id);
    });

  const launchedBy: RemoteWorkersShape["launchedBy"] = (input) =>
    store.list.pipe(
      Effect.map((rows) =>
        rows.some(
          (row) =>
            row.callerThreadId === input.callerThreadId &&
            row.machineId === input.machineId &&
            row.remoteThreadId === input.remoteThreadId &&
            row.state !== "disposed",
        ),
      ),
      // A store this machine cannot read names no thread.
      Effect.orElseSucceed(() => false),
    );

  const noteFinished: RemoteWorkersShape["noteFinished"] = (input) =>
    Effect.gen(function* () {
      const rows = yield* store.list.pipe(Effect.orElseSucceed(() => []));
      const row = rows.find(
        (candidate) =>
          candidate.callerThreadId === input.callerThreadId &&
          candidate.machineId === input.machineId &&
          candidate.remoteThreadId === input.remoteThreadId &&
          candidate.state === "following" &&
          (input.runId === null || candidate.followedRunId === input.runId),
      );
      if (!row) return;
      const key = input.runId ?? "no-run";
      const updatedAt = yield* isoNow;
      yield* store
        .modify(row.id, (current) =>
          current
            ? {
                ...current,
                state: "idle",
                lastStatus: input.status,
                deliveredRunIds: current.deliveredRunIds.includes(key)
                  ? current.deliveredRunIds
                  : [...current.deliveredRunIds, key].slice(-50),
                updatedAt,
              }
            : undefined,
        )
        .pipe(Effect.ignore);
    });

  const coordinatorWorkerMachine: RemoteWorkersShape["coordinatorWorkerMachine"] = (input) =>
    localProject(input.projectId).pipe(
      Effect.map((project) =>
        project?.workspaceSettings?.coordinatorThreadId === input.callerThreadId
          ? (project.workspaceSettings?.workerMachine ?? null)
          : null,
      ),
      Effect.orElseSucceed(() => null),
    );

  const workersForProject: RemoteWorkersShape["workersForProject"] = (projectId) =>
    Effect.gen(function* () {
      const rows = yield* store.list.pipe(Effect.orElseSucceed(() => []));
      const configured = yield* machines.pipe(Effect.orElseSucceed(() => []));
      const relevant = rows
        .filter((row) => row.projectId === projectId && row.state !== "disposed")
        .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .slice(0, 50);
      return yield* Effect.forEach(relevant, (row) =>
        Effect.map(follower.reachable(row.machineId), (reachable) => ({
          id: row.id,
          machineId: row.machineId,
          machineLabel:
            configured.find((machine) => machine.id === row.machineId)?.label ?? row.machineId,
          environmentId: EnvironmentId.make(row.environmentId),
          callerThreadId: ThreadId.make(row.callerThreadId),
          remoteThreadId: row.remoteThreadId === null ? null : ThreadId.make(row.remoteThreadId),
          threadRef:
            row.remoteThreadId === null
              ? null
              : formatStudioThreadHref(row.remoteThreadId, row.environmentId),
          title: row.title,
          state: row.state,
          lastStatus: row.lastStatus,
          reachable,
          updatedAt: row.updatedAt as StudioFleetRemoteWorker["updatedAt"],
        })),
      );
    });

  const machineLabels: RemoteWorkersShape["machineLabels"] = machines.pipe(
    Effect.map(
      (configured) =>
        new Map(configured.map((target) => [target.environmentId as string, target.label])),
    ),
    Effect.orElseSucceed(() => new Map<string, string>()),
  );

  return {
    enabled: true,
    machineLabels,
    resolveMachine,
    resolveThread,
    listMachines,
    launch,
    proxy,
    remoteProjectFor,
    noteRun,
    noteFinished,
    launchedBy,
    coordinatorWorkerMachine,
    workersForProject,
  } satisfies RemoteWorkersShape;
});

export const layer = Layer.effect(RemoteWorkers, make);

/** Everything remote workers need, with the follower resuming at boot. */
export const layerFleetWorkers = Layer.mergeAll(
  layer,
  RemoteWorkerFollower.layerResume,
  FleetWorkerGrants.layerRenewal,
  // Carries a phone revocation between this machine and the machines it linked the phone to.
  PhoneLinks.layerSweep,
).pipe(
  Layer.provideMerge(RemoteWorkerFollower.layer),
  Layer.provideMerge(RemoteStudioMcpClient.layer),
  Layer.provideMerge(Layer.merge(FleetWorkerGrants.layer, RemoteWorkerStore.layer)),
  Layer.provideMerge(FleetTargets.layer),
);
