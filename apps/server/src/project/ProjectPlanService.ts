import { isPersonalAssistantProject } from "@specweave-studio/shared/personalAssistant";
import { stringifyJson } from "../json.ts";
import { sha256 } from "../nodeCrypto.ts";
import * as DateTime from "effect/DateTime";
import type { EnvironmentId, ProjectId } from "@specweave-studio/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import {
  PROJECT_PLAN_EVIDENCE_LIMIT,
  PROJECT_PLAN_RELEASED_CLAIMS_LIMIT,
  ProjectPlanError,
  ProjectPlanLinkExportInput,
  ProjectPlanLinkMergeInput,
  ProjectPlanConfigureInput,
  ProjectPlanReplaceInput,
  ProjectPlanTaskInput,
  ProjectPlanReleaseInput,
  ProjectPlanReportInput,
  ProjectPlanVerifyInput,
  type ProjectPlanActor,
  type ProjectPlanAuthorityReadResult,
  type ProjectPlanClaim,
  type ProjectPlanLinkExport,
  type ProjectPlanLinkMergeResult,
  type ProjectPlanSnapshot,
  type ProjectPlanTask,
  type ProjectNativePlan,
  type ProjectPlanEvidence,
} from "../../../../packages/contracts/src/projectPlan.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProjectAdmission from "./ProjectAdmission.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProcessRunner from "../processRunner.ts";
import {
  PlanDocument,
  emptyDocument,
  emptyNative,
  equalDefinition,
  foreignMachine,
  ownerKey,
  sameOwner,
  validDefinition,
  withOwnerMachine,
  withinDocumentLimit,
} from "./plan/PlanDocument.ts";
import { mergeNativePlans, normalizePlan } from "./plan/PlanMerge.ts";
import { readSpecWeavePlan } from "./plan/SpecWeavePlanReader.ts";

/** Actor identity must be derived by the transport from its authenticated caller.
 * Never pass an agent-supplied actor through unchanged. Only a user may verify/configure.
 */
export class ProjectPlanService extends Context.Service<
  ProjectPlanService,
  {
    readonly readAuthority: (input: {
      projectId: ProjectId;
    }) => Effect.Effect<ProjectPlanAuthorityReadResult, ProjectPlanError>;
    readonly read: (input: {
      projectId: ProjectId;
    }) => Effect.Effect<ProjectPlanSnapshot, ProjectPlanError>;
    readonly replace: (
      input: ProjectPlanReplaceInput,
    ) => Effect.Effect<ProjectPlanSnapshot, ProjectPlanError>;
    readonly configure: (
      input: ProjectPlanConfigureInput,
    ) => Effect.Effect<ProjectPlanSnapshot, ProjectPlanError>;
    readonly claim: (
      input: ProjectPlanTaskInput,
    ) => Effect.Effect<ProjectPlanSnapshot, ProjectPlanError>;
    readonly release: (
      input: ProjectPlanReleaseInput,
    ) => Effect.Effect<ProjectPlanSnapshot, ProjectPlanError>;
    readonly report: (
      input: ProjectPlanReportInput,
    ) => Effect.Effect<ProjectPlanSnapshot, ProjectPlanError>;
    readonly verify: (
      input: ProjectPlanVerifyInput,
    ) => Effect.Effect<ProjectPlanSnapshot, ProjectPlanError>;
    /** This machine's native plan, for a linked copy of the project on another machine. */
    readonly exportLinked: (
      input: ProjectPlanLinkExportInput,
    ) => Effect.Effect<ProjectPlanLinkExport, ProjectPlanError>;
    /** Merges a linked copy's plan into this one; claims and evidence are never lost. */
    readonly mergeLinked: (
      input: ProjectPlanLinkMergeInput,
    ) => Effect.Effect<ProjectPlanLinkMergeResult, ProjectPlanError>;
  }
>()("specweave-studio/project/ProjectPlanService") {}

type StoredPlan = { revision: number; document: PlanDocument };
const isPlanError = Schema.is(ProjectPlanError);
const decodeDocument = Schema.decodeUnknownEffect(Schema.fromJsonString(PlanDocument));
const isReplaceInput = Schema.is(ProjectPlanReplaceInput);
const isConfigureInput = Schema.is(ProjectPlanConfigureInput);
const isTaskInput = Schema.is(ProjectPlanTaskInput);
const isReleaseInput = Schema.is(ProjectPlanReleaseInput);
const isReportInput = Schema.is(ProjectPlanReportInput);
const isVerifyInput = Schema.is(ProjectPlanVerifyInput);
const isLinkExportInput = Schema.is(ProjectPlanLinkExportInput);
const isLinkMergeInput = Schema.is(ProjectPlanLinkMergeInput);
/** A local owner hashes without its machine, so receipts from before machines were recorded stay current. */
const localOwner = (owner: ProjectPlanActor | null, home: EnvironmentId) => {
  if (owner?.kind !== "thread" || owner.environmentId !== home) return owner;
  const { environmentId: _home, ...rest } = owner;
  return rest;
};
const taskStateHash = (task: ProjectPlanTask, home: EnvironmentId) =>
  sha256(
    [stringifyJson({ owner: localOwner(task.owner, home), status: task.status, note: task.note })],
    "hex",
  );
const nowIso = () => DateTime.formatIso(DateTime.nowUnsafe());
const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const threads = yield* ProjectionStore.ProjectionStoreV2;
  const runner = yield* ProcessRunner.ProcessRunner;
  const admission = yield* ProjectAdmission.ProjectAdmission;
  const self = yield* (yield* ServerEnvironment.ServerEnvironmentIdentity).getEnvironmentId;
  const stamp = () => ({ at: nowIso(), environmentId: self });
  // Capture filesystem services at construction; the public service has no ambient requirements.
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const readExternal = (input: Parameters<typeof readSpecWeavePlan>[0]) =>
    readSpecWeavePlan(input).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );
  const fail = (projectId: ProjectId, code: ProjectPlanError["code"]) =>
    new ProjectPlanError({ projectId, code });
  const mapFailure = (projectId: ProjectId) =>
    Effect.mapError((error: unknown) =>
      isPlanError(error) ? error : fail(projectId, "operation_failed"),
    );
  const requireProject = (projectId: ProjectId) =>
    projects
      .get(projectId)
      .pipe(
        Effect.flatMap((row) =>
          Option.isSome(row)
            ? Effect.succeed(row.value)
            : Effect.fail(fail(projectId, "not_found")),
        ),
      );
  /** A claim held by a thread on another machine binds here; only the user may release it. */
  const claimedOn = (projectId: ProjectId, plan: ProjectNativePlan, machine: EnvironmentId) =>
    new ProjectPlanError({
      projectId,
      code: "claimed",
      machine:
        plan.machines?.find((entry) => entry.environmentId === machine)?.label.trim() || machine,
    });
  const actorAllowed = (projectId: ProjectId, actor: ProjectPlanActor) =>
    Effect.gen(function* () {
      if (actor.kind === "user") return;
      if (actor.environmentId !== undefined && actor.environmentId !== self)
        return yield* fail(projectId, "forbidden");
      const thread = yield* threads.getThreadShell(actor.threadId);
      if (
        !thread ||
        thread.projectId !== projectId ||
        thread.archivedAt !== null ||
        thread.deletedAt !== null
      )
        return yield* fail(projectId, "forbidden");
    });
  const load = (projectId: ProjectId) =>
    Effect.gen(function* () {
      yield* requireProject(projectId);
      const rows = yield* sql<{
        revision: number;
        document_json: string;
      }>`SELECT revision, document_json FROM project_plans WHERE project_id=${projectId}`;
      const row = rows[0];
      if (!row) return { revision: 0, document: emptyDocument() };
      const document = yield* decodeDocument(row.document_json);
      if ((document.authority.kind === "native") !== (document.native !== null))
        return yield* fail(projectId, "invalid");
      return { revision: row.revision, document };
    });
  const snapshot = (projectId: ProjectId, stored: StoredPlan) =>
    Effect.gen(function* () {
      const project = yield* requireProject(projectId);
      const { document, revision } = stored;
      const external =
        document.authority.kind === "specweave"
          ? yield* readExternal({
              projectId,
              workspaceRoot: project.workspaceRoot,
              approvedFolders: project.workspaceSettings?.environment.additionalFolders ?? [],
              authority: document.authority,
            })
          : null;
      if (external) {
        const current = yield* requireProject(projectId);
        if (
          current.workspaceRoot !== project.workspaceRoot ||
          current.workspaceSettings?.revision !== project.workspaceSettings?.revision ||
          JSON.stringify(current.workspaceSettings?.environment.additionalFolders ?? []) !==
            JSON.stringify(project.workspaceSettings?.environment.additionalFolders ?? [])
        )
          return yield* fail(projectId, "source_invalid");
      }
      return { projectId, environmentId: self, revision, ...document, external };
    });
  const persist = (projectId: ProjectId, previous: StoredPlan, document: PlanDocument) =>
    Effect.gen(function* () {
      if (!withinDocumentLimit(document)) return yield* fail(projectId, "invalid");
      const revision = previous.revision + 1;
      const value = stringifyJson(document);
      const rows =
        previous.revision === 0
          ? yield* sql`INSERT INTO project_plans (project_id,revision,document_json) VALUES (${projectId},${revision},${value}) ON CONFLICT(project_id) DO NOTHING RETURNING revision`
          : yield* sql`UPDATE project_plans SET revision=${revision}, document_json=${value} WHERE project_id=${projectId} AND revision=${previous.revision} RETURNING revision`;
      if (rows.length !== 1) return yield* fail(projectId, "conflict");
      return { revision, document };
    });
  const nativePlan = (
    projectId: ProjectId,
    stored: StoredPlan,
  ): Effect.Effect<ProjectNativePlan, ProjectPlanError> =>
    stored.document.native === null || stored.document.authority.kind !== "native"
      ? Effect.fail(fail(projectId, "read_only"))
      : Effect.succeed(stored.document.native);
  const taskAt = (projectId: ProjectId, plan: ProjectNativePlan, taskId: string) => {
    const task = plan.tasks.find((task) => task.id === taskId);
    return task ? Effect.succeed(task) : Effect.fail(fail(projectId, "not_found"));
  };
  const locked = <A, E, R>(projectId: ProjectId, effect: Effect.Effect<A, E, R>) =>
    admission.withLock(projectId, sql.withTransaction(effect)).pipe(mapFailure(projectId));
  const readAuthority = ({ projectId }: { projectId: ProjectId }) =>
    locked(
      projectId,
      Effect.gen(function* () {
        const stored = yield* load(projectId);
        return { projectId, revision: stored.revision, authority: stored.document.authority };
      }),
    );
  const read = ({ projectId }: { projectId: ProjectId }) =>
    locked(
      projectId,
      Effect.gen(function* () {
        return yield* snapshot(projectId, yield* load(projectId));
      }),
    );
  const replace = (input: ProjectPlanReplaceInput) =>
    locked(
      input.projectId,
      Effect.gen(function* () {
        const { projectId, definition, actor } = input;
        if (!isReplaceInput(input) || !validDefinition(definition))
          return yield* fail(projectId, "invalid");
        yield* actorAllowed(projectId, actor);
        const stored = yield* load(projectId);
        if (stored.revision !== input.expectedRevision) return yield* fail(projectId, "conflict");
        const plan = yield* nativePlan(projectId, stored);
        for (const previous of plan.tasks) {
          const next = definition.tasks.find((task) => task.id === previous.id);
          if (
            previous.owner &&
            (!next || !equalDefinition(previous, next)) &&
            !sameOwner(previous.owner, actor, self)
          ) {
            const machine = foreignMachine(previous.owner, self);
            return yield* machine === null
              ? fail(projectId, "claimed")
              : claimedOn(projectId, plan, machine);
          }
          // Receipts and claims survive deletion attempts; explicit release alone does not erase evidence.
          if (!next && (previous.owner || previous.evidence.length > 0))
            return yield* fail(projectId, "claimed");
        }
        const changed =
          plan.spec !== definition.spec ||
          stringifyJson(plan.criteria) !== stringifyJson(definition.criteria) ||
          plan.tasks.length !== definition.tasks.length ||
          definition.tasks.some(
            (task, i) => !plan.tasks[i] || !equalDefinition(plan.tasks[i]!, task),
          );
        if (!changed) return yield* snapshot(projectId, stored);
        const tasks: ProjectPlanTask[] = definition.tasks.map((task) => {
          const previous = plan.tasks.find((item) => item.id === task.id);
          if (!previous) return { ...task, owner: null, note: "", evidence: [], status: "planned" };
          // Claim times, conflicts and released claims stay with the task across edits.
          return previous.status === "verified"
            ? { ...previous, ...task, status: "reported_done", stateStamp: stamp() }
            : { ...previous, ...task };
        });
        return yield* snapshot(
          projectId,
          yield* persist(projectId, stored, {
            authority: { kind: "native" },
            native: {
              ...definition,
              tasks,
              contentRevision: plan.contentRevision + 1,
              definitionStamp: stamp(),
              ...(plan.machines ? { machines: plan.machines } : {}),
            },
          }),
        );
      }),
    );
  const configure = (input: ProjectPlanConfigureInput) =>
    locked(
      input.projectId,
      Effect.gen(function* () {
        const { projectId, authority } = input;
        if (!isConfigureInput(input)) return yield* fail(projectId, "invalid");
        if (authority.kind === "specweave" && !path.isAbsolute(authority.root))
          return yield* fail(projectId, "source_invalid");
        if (input.actor.kind !== "user") return yield* fail(projectId, "forbidden");
        const stored = yield* load(projectId);
        if (stored.revision !== input.expectedRevision) return yield* fail(projectId, "conflict");
        if (stringifyJson(stored.document.authority) === stringifyJson(authority))
          return yield* snapshot(projectId, stored);
        if (stored.document.native?.tasks.some((task) => task.owner !== null))
          return yield* fail(projectId, "claimed");
        if (
          stored.document.native &&
          (stored.document.native.spec ||
            stored.document.native.tasks.length ||
            stored.document.native.criteria.length) &&
          !input.discardNative
        )
          return yield* fail(projectId, "conflict");
        const normalizedAuthority =
          authority.kind === "specweave"
            ? { ...authority, root: yield* fs.realPath(authority.root) }
            : authority;
        const next = {
          authority: normalizedAuthority,
          native: authority.kind === "native" ? emptyNative() : null,
        };
        // Validate the configured source before storing its binding; never silently fall back.
        yield* snapshot(projectId, { revision: stored.revision, document: next });
        return yield* snapshot(projectId, yield* persist(projectId, stored, next));
      }),
    );
  const updateTask = (
    input: ProjectPlanTaskInput,
    change: (task: ProjectPlanTask) => ProjectPlanTask,
    releaseOwner?: ProjectPlanActor | null,
  ) =>
    locked(
      input.projectId,
      Effect.gen(function* () {
        const { projectId, actor } = input;
        if (!isTaskInput(input)) return yield* fail(projectId, "invalid");
        yield* actorAllowed(projectId, actor);
        const stored = yield* load(projectId);
        if (stored.revision !== input.expectedRevision) return yield* fail(projectId, "conflict");
        const plan = yield* nativePlan(projectId, stored);
        const task = yield* taskAt(projectId, plan, input.taskId);
        const userRelease = releaseOwner !== undefined && actor.kind === "user";
        const machine = foreignMachine(task.owner, self);
        if (machine !== null && !userRelease) return yield* claimedOn(projectId, plan, machine);
        if (
          releaseOwner !== undefined &&
          (task.owner === null
            ? releaseOwner !== null
            : releaseOwner === null || !sameOwner(task.owner, releaseOwner, self))
        )
          return yield* fail(projectId, "conflict");
        if (task.owner && !sameOwner(task.owner, actor, self) && !userRelease)
          return yield* fail(projectId, "claimed");
        const updated = change(task);
        return yield* snapshot(
          projectId,
          yield* persist(projectId, stored, {
            ...stored.document,
            native: { ...plan, tasks: plan.tasks.map((t) => (t.id === task.id ? updated : t)) },
          }),
        );
      }),
    );
  /** Later than any released claim of the same owner, so the new claim is never mistaken for it. */
  const claimTime = (task: ProjectPlanTask, owner: ProjectPlanActor) => {
    let at = DateTime.toEpochMillis(DateTime.nowUnsafe());
    for (const released of task.releasedClaims ?? [])
      if (released.claimedAt && ownerKey(released.owner, self) === ownerKey(owner, self))
        at = Math.max(at, Date.parse(released.claimedAt) + 1);
    return DateTime.formatIso(DateTime.makeUnsafe(at));
  };
  const claimed = (task: ProjectPlanTask, actor: ProjectPlanActor) => {
    const owner = withOwnerMachine(actor, self);
    return task.owner && sameOwner(task.owner, owner, self)
      ? { owner: withOwnerMachine(task.owner, self) }
      : { owner, claimedAt: claimTime(task, owner) };
  };
  const claim = (input: ProjectPlanTaskInput) =>
    updateTask(input, (task) => ({
      ...task,
      ...claimed(task, input.actor),
      status: task.status === "planned" ? "in_progress" : task.status,
      stateStamp: stamp(),
    }));
  const release = (input: ProjectPlanReleaseInput) =>
    !isReleaseInput(input as unknown)
      ? Effect.fail(fail(input.projectId, "invalid"))
      : updateTask(
          input,
          (task) => {
            const { claimedAt, claimConflict, ...rest } = task;
            const released: ProjectPlanClaim[] = [
              ...(task.releasedClaims ?? []),
              ...(task.owner
                ? [
                    {
                      owner: withOwnerMachine(task.owner, self),
                      ...(claimedAt === undefined ? {} : { claimedAt }),
                    },
                  ]
                : []),
              ...(claimConflict ? [claimConflict] : []),
            ];
            return {
              ...rest,
              owner: null,
              ...(released.length > 0
                ? { releasedClaims: released.slice(-PROJECT_PLAN_RELEASED_CLAIMS_LIMIT) }
                : {}),
              stateStamp: stamp(),
            };
          },
          input.expectedOwner,
        );
  const report = (input: ProjectPlanReportInput) =>
    !isReportInput(input as unknown)
      ? Effect.fail(fail(input.projectId, "invalid"))
      : updateTask(input, (task) => ({
          ...task,
          ...claimed(task, task.owner ?? input.actor),
          status: input.status,
          note: input.note,
          stateStamp: stamp(),
        }));
  const verify = (input: ProjectPlanVerifyInput) =>
    Effect.gen(function* () {
      const { projectId } = input;
      if (!isVerifyInput(input)) return yield* fail(projectId, "invalid");
      if (input.actor.kind !== "user") return yield* fail(projectId, "forbidden");
      const reservation = yield* locked(
        projectId,
        Effect.gen(function* () {
          const stored = yield* load(projectId);
          const plan = yield* nativePlan(projectId, stored);
          const previous = plan.tasks
            .flatMap((task) => task.evidence)
            .find((e) => e.commandId === input.commandId);
          if (previous) {
            if (previous.taskId !== input.taskId) return yield* fail(projectId, "conflict");
            return { execute: false as const, stored, receipt: previous };
          }
          if (input.recheckOnly) return yield* fail(projectId, "receipt_unavailable");
          if (stored.revision !== input.expectedRevision) return yield* fail(projectId, "conflict");
          const project = yield* requireProject(projectId);
          if (project.workspaceSettings?.paused) return yield* fail(projectId, "paused");
          if (project.workspaceSettings?.archived) return yield* fail(projectId, "archived");
          const task = yield* taskAt(projectId, plan, input.taskId);
          if (!task.verification) return yield* fail(projectId, "invalid");
          if (task.evidence.length >= PROJECT_PLAN_EVIDENCE_LIMIT)
            return yield* fail(projectId, "evidence_limit");
          const receipt: ProjectPlanEvidence = {
            commandId: input.commandId,
            taskId: task.id,
            contentRevision: plan.contentRevision,
            taskStateSha256: taskStateHash(task, self),
            startedAt: DateTime.formatIso(DateTime.nowUnsafe()),
            finishedAt: null,
            outcome: "unknown",
            command: task.verification,
            workspaceRoot: project.workspaceRoot,
            exitCode: null,
            stdout: "",
            stderr: "",
            outputSha256: "",
            truncated: false,
          };
          const next = yield* persist(projectId, stored, {
            ...stored.document,
            native: {
              ...plan,
              tasks: plan.tasks.map((t) =>
                t.id === task.id ? { ...t, evidence: [...t.evidence, receipt] } : t,
              ),
            },
          });
          return { execute: true as const, stored: next, receipt };
        }),
      );
      if (!reservation.execute)
        return yield* snapshot(projectId, reservation.stored).pipe(mapFailure(projectId));
      const receipt = reservation.receipt;
      // Outside the project lock: a long test must not block other work or lifecycle controls.
      // An interrupted process leaves an explicit unknown receipt; replay does not execute again.
      const result = yield* runner
        .run({
          command: receipt.command.executable,
          args: receipt.command.args,
          cwd: receipt.workspaceRoot,
          timeout: receipt.command.timeoutMs,
          maxOutputBytes: 8_192,
          outputMode: "truncate",
          truncatedMarker: "",
          timeoutBehavior: "timedOutResult",
        })
        .pipe(Effect.result);
      const completed: ProjectPlanEvidence =
        result._tag === "Success"
          ? {
              ...receipt,
              finishedAt: DateTime.formatIso(DateTime.nowUnsafe()),
              exitCode: result.success.code === null ? null : Number(result.success.code),
              stdout: result.success.stdout,
              stderr: result.success.stderr,
              outcome: result.success.timedOut
                ? "timed_out"
                : result.success.code === 0
                  ? "passed"
                  : "failed",
              outputSha256: sha256([result.success.stdout, "\0", result.success.stderr], "hex"),
              truncated: result.success.stdoutTruncated || result.success.stderrTruncated,
            }
          : {
              ...receipt,
              finishedAt: DateTime.formatIso(DateTime.nowUnsafe()),
              outcome: "error",
              stderr: "The verification process could not complete.",
            };
      return yield* locked(
        projectId,
        Effect.gen(function* () {
          const stored = yield* load(projectId);
          const plan = yield* nativePlan(projectId, stored);
          const task = yield* taskAt(projectId, plan, input.taskId);
          const finalReceipt =
            plan.contentRevision !== receipt.contentRevision ||
            taskStateHash(task, self) !== receipt.taskStateSha256
              ? { ...completed, outcome: "stale" as const }
              : completed;
          const status =
            finalReceipt.outcome === "passed"
              ? ("verified" as const)
              : task.status === "verified"
                ? ("reported_done" as const)
                : task.status;
          const tasks = plan.tasks.map((t) =>
            t.id === task.id
              ? {
                  ...t,
                  status,
                  ...(status === t.status ? {} : { stateStamp: stamp() }),
                  evidence: t.evidence.map((e) =>
                    e.commandId === completed.commandId ? finalReceipt : e,
                  ),
                }
              : t,
          );
          return yield* snapshot(
            projectId,
            yield* persist(projectId, stored, { ...stored.document, native: { ...plan, tasks } }),
          );
        }),
      );
    }).pipe(mapFailure(input.projectId));
  const linkedIdentity = (projectId: ProjectId) =>
    Effect.gen(function* () {
      const project = yield* requireProject(projectId);
      // A personal assistant's plan never leaves its machine, nor takes another's in.
      if (isPersonalAssistantProject(project)) return yield* fail(projectId, "not_linked");
      const identity = project.workspaceSettings?.logicalProject;
      if (
        !identity?.members.some(
          (member) => member.environmentId === self && member.projectId === projectId,
        )
      )
        return yield* fail(projectId, "not_linked");
      return identity;
    });
  const exportLinked = (input: ProjectPlanLinkExportInput) =>
    locked(
      input.projectId,
      Effect.gen(function* () {
        const { projectId } = input;
        if (!isLinkExportInput(input)) return yield* fail(projectId, "invalid");
        const identity = yield* linkedIdentity(projectId);
        const plan = yield* nativePlan(projectId, yield* load(projectId));
        return {
          logicalProjectId: identity.id,
          environmentId: self,
          projectId,
          plan: normalizePlan(plan, self),
        };
      }),
    );
  const mergeLinked = (input: ProjectPlanLinkMergeInput) =>
    locked(
      input.projectId,
      Effect.gen(function* () {
        const { projectId, peer } = input;
        if (!isLinkMergeInput(input)) return yield* fail(projectId, "invalid");
        const identity = yield* linkedIdentity(projectId);
        if (
          peer.environmentId === self ||
          !identity.members.some(
            (member) =>
              member.environmentId === peer.environmentId && member.projectId === peer.projectId,
          ) ||
          input.export.logicalProjectId !== identity.id ||
          input.export.environmentId !== peer.environmentId ||
          input.export.projectId !== peer.projectId
        )
          return yield* fail(projectId, "not_linked");
        const stored = yield* load(projectId);
        const plan = yield* nativePlan(projectId, stored);
        const merged = mergeNativePlans(
          { plan, environmentId: self },
          { plan: input.export.plan, environmentId: peer.environmentId },
          peer.label,
        );
        if (!merged.changed) return { changed: false, revision: stored.revision };
        if (!validDefinition(merged.plan)) return yield* fail(projectId, "invalid");
        const next = yield* persist(projectId, stored, { ...stored.document, native: merged.plan });
        return { changed: true, revision: next.revision };
      }),
    );
  return ProjectPlanService.of({
    readAuthority,
    read,
    replace,
    configure,
    claim,
    release,
    report,
    verify,
    exportLinked,
    mergeLinked,
  });
});

export const layer = Layer.effect(ProjectPlanService, make).pipe(
  Layer.provide(ProjectAdmission.layer),
);
