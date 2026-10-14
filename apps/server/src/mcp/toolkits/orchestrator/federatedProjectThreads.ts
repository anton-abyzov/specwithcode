import {
  OrchestratorMcpFailure,
  OrchestratorMcpThreadListResult,
  Project,
  type LogicalProjectMember,
  type OrchestratorMcpMachineRef,
  type OrchestratorMcpProjectThreadInventoryMember,
  type OrchestratorMcpThreadListInput,
  type OrchestratorMcpThreadListItem,
  logicalProjectMemberKey,
} from "@specweave-studio/contracts";
import {
  formatStudioThreadHref,
  formatStudioThreadLink,
} from "@specweave-studio/shared/studioThreadLinks";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { isLogicalProjectBinding } from "../../../fleet/remoteWorkerMatching.ts";
import * as RemoteWorkers from "../../../fleet/RemoteWorkers.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as OrchestratorMcpService from "../../OrchestratorMcpService.ts";
import { readCaller } from "../../threadAccess.ts";

const MAX_PAGES_PER_MEMBER = 20;
const PAGE_SIZE = 100;

interface MemberResult {
  readonly member: OrchestratorMcpProjectThreadInventoryMember;
  readonly threads: ReadonlyArray<OrchestratorMcpThreadListItem>;
}

const failure = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });

function qualifyThread(
  thread: OrchestratorMcpThreadListItem,
  member: LogicalProjectMember,
  machine: OrchestratorMcpMachineRef,
): OrchestratorMcpThreadListItem {
  return {
    ...thread,
    projectId: member.projectId,
    environmentId: member.environmentId,
    machine,
    threadRef: formatStudioThreadHref(thread.threadId, member.environmentId),
    threadLink: formatStudioThreadLink(thread.threadId, thread.title, member.environmentId),
  };
}

/** Fetch enough of each ordered member to form a correct global page, with bounded work. */
export const collectMemberThreads = (options: {
  readonly member: LogicalProjectMember;
  readonly machine: OrchestratorMcpMachineRef;
  readonly input: OrchestratorMcpThreadListInput;
  readonly fetchPage: (
    input: OrchestratorMcpThreadListInput,
  ) => Effect.Effect<OrchestratorMcpThreadListResult, OrchestratorMcpFailure>;
}): Effect.Effect<MemberResult, OrchestratorMcpFailure> =>
  Effect.gen(function* () {
    const { member, machine, input, fetchPage } = options;
    const needed = (input.cursor ?? 0) + (input.limit ?? 50);
    const found = new Map<string, OrchestratorMcpThreadListItem>();
    let cursor = 0;
    let total = 0;
    let code: string | undefined;
    let message: string | undefined;
    let nextCursor: number | null = 0;
    for (let page = 0; page < MAX_PAGES_PER_MEMBER; page++) {
      const result = yield* fetchPage({
        ...input,
        machine: "local", // A peer must never transitively federate this request.
        projectId: member.projectId,
        cursor,
        limit: PAGE_SIZE,
      });
      if (
        result.projectId !== member.projectId ||
        result.threads.some(
          (thread) =>
            (thread.projectId !== undefined && thread.projectId !== member.projectId) ||
            (thread.environmentId !== undefined && thread.environmentId !== member.environmentId),
        )
      )
        return yield* failure("The machine returned threads from a different project binding.");
      total = result.total;
      for (const thread of result.threads)
        found.set(thread.threadId, qualifyThread(thread, member, machine));
      if (input.includeArchived && result.includeArchived !== true) {
        code = "archive_inventory_unsupported";
        message =
          "This machine did not confirm archive support. Its archived threads may be missing.";
      }
      if (result.partial) {
        code = "remote_inventory_partial";
        message = "This machine returned an incomplete inventory.";
      }
      nextCursor = result.nextCursor;
      if (nextCursor !== null && nextCursor <= cursor)
        return yield* failure("The machine returned a non-advancing thread cursor.");
      if (nextCursor === null || found.size >= needed) break;
      cursor = nextCursor;
    }
    if (nextCursor !== null && found.size < needed) {
      code = "inventory_page_limit";
      message = "The inventory page limit was reached. List this binding explicitly to continue.";
    }
    return {
      member: {
        environmentId: member.environmentId,
        projectId: member.projectId,
        machine,
        status: code === undefined ? "complete" : "partial",
        total,
        ...(code === undefined ? {} : { code, message }),
      },
      threads: [...found.values()],
    };
  });

/** Only the project's own coordinator may use its machine grants to federate by default. */
export const listFederatedProjectThreads = (input: OrchestratorMcpThreadListInput) =>
  Effect.gen(function* () {
    const { caller, scope } = yield* readCaller();
    const service = yield* OrchestratorMcpService.OrchestratorMcpService;
    const local = () => service.listThreads(scope, input);
    if (
      input.machine !== undefined ||
      caller === undefined ||
      (input.projectId !== undefined && input.projectId !== caller.projectId)
    )
      return yield* local();
    const projects = yield* ProjectService.ProjectService;
    const project = yield* projects.getById(caller.projectId).pipe(
      Effect.map(Option.getOrUndefined),
      Effect.mapError(() => failure("The coordinator's project could not be read.")),
    );
    const logical = project?.workspaceSettings?.logicalProject;
    if (logical == null || project?.workspaceSettings?.coordinatorThreadId !== caller.id)
      return yield* local();

    const workers = yield* RemoteWorkers.RemoteWorkers;
    const ownMember: LogicalProjectMember = {
      environmentId: scope.environmentId,
      projectId: caller.projectId,
      coordinatorThreadId: caller.id,
    };
    // New projects have no transfer members yet. The caller's own binding is always explicit.
    const members = [
      ...new Map(
        [...logical.members, ownMember].map((member) => [logicalProjectMemberKey(member), member]),
      ).values(),
    ];
    const request = { ...input, includeArchived: input.includeArchived ?? true };
    const collected = yield* Effect.forEach(
      members,
      (member) =>
        Effect.gen(function* () {
          const target =
            member.environmentId === scope.environmentId
              ? { kind: "local" as const }
              : yield* workers.resolveMachine(member.environmentId);
          if (target.kind === "local" && member.environmentId !== scope.environmentId)
            return yield* failure("The configured machine does not match the project binding.");
          const machine: OrchestratorMcpMachineRef =
            target.kind === "remote"
              ? target.machine
              : { id: "local", label: "This machine", environmentId: scope.environmentId };
          if (machine.environmentId !== member.environmentId)
            return yield* failure("The configured machine identity changed.");
          if (logicalProjectMemberKey(member) !== logicalProjectMemberKey(ownMember)) {
            const linked =
              target.kind === "local"
                ? yield* projects.getById(member.projectId).pipe(
                    Effect.map(Option.getOrUndefined),
                    Effect.mapError(() => failure("The linked project could not be read.")),
                  )
                : yield* workers
                    .proxy({
                      machine,
                      tool: "studio_project_read",
                      arguments: { projectId: member.projectId },
                    })
                    .pipe(
                      Effect.flatMap(Schema.decodeUnknownEffect(Project)),
                      Effect.mapError((error) =>
                        Schema.is(OrchestratorMcpFailure)(error)
                          ? error
                          : failure("The linked project could not be verified."),
                      ),
                    );
            if (linked === undefined || !isLogicalProjectBinding(linked, logical, member))
              return yield* failure(
                "The linked project no longer belongs to this logical project.",
              );
          }
          return yield* collectMemberThreads({
            member,
            machine,
            input: request,
            fetchPage:
              target.kind === "local"
                ? (page) => service.listThreads(scope, page)
                : (page) =>
                    workers.proxy({ machine, tool: "studio_thread_list", arguments: page }).pipe(
                      Effect.flatMap(Schema.decodeUnknownEffect(OrchestratorMcpThreadListResult)),
                      Effect.mapError((error) =>
                        Schema.is(OrchestratorMcpFailure)(error)
                          ? error
                          : failure("The linked thread inventory could not be decoded."),
                      ),
                    ),
          });
        }).pipe(
          Effect.catch((error: OrchestratorMcpFailure): Effect.Effect<MemberResult> =>
            Effect.succeed({
              member: {
                environmentId: member.environmentId,
                projectId: member.projectId,
                status: "unavailable",
                code: error.code,
                message: error.message,
              },
              threads: [],
            }),
          ),
        ),
      { concurrency: 4 },
    );
    const inventory = collected.map((result) => result.member);
    const unique = new Map(
      collected
        .flatMap((result) => result.threads)
        .map((thread) => [JSON.stringify([thread.environmentId, thread.threadId]), thread]),
    );
    const ordered = [...unique.values()].sort(
      (left, right) =>
        right.updatedAt.localeCompare(left.updatedAt) ||
        right.threadRef!.localeCompare(left.threadRef!),
    );
    const cursor = input.cursor ?? 0;
    const threads = ordered.slice(cursor, cursor + (input.limit ?? 50));
    const total = inventory.reduce((sum, member) => sum + (member.total ?? 0), 0);
    return {
      projectId: caller.projectId,
      logicalProjectId: logical.id,
      currentThreadId: caller.id,
      includeArchived: request.includeArchived,
      partial: inventory.some((member) => member.status !== "complete"),
      members: inventory,
      threads,
      total,
      nextCursor:
        threads.length > 0 && cursor + threads.length < total ? cursor + threads.length : null,
    } satisfies OrchestratorMcpThreadListResult;
  });
