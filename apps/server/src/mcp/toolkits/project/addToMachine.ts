import {
  OrchestratorMcpFailure,
  type OrchestratorMcpMachineRef,
  Project,
  type ProjectId,
  ProjectLinkAcceptResult,
  type RepositoryIdentity,
  SourceControlCloneRepositoryResult,
  ThreadId,
  type SourceControlCloneProtocol,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as RemoteWorkers from "../../../fleet/RemoteWorkers.ts";
import { randomUuidV4 } from "../../../orchestration-v2/RandomUuid.ts";
import * as ProjectLink from "../../../project/ProjectLink.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as RepositoryIdentityResolver from "../../../project/RepositoryIdentityResolver.ts";
import { SETUP_GIT_COMMAND } from "../../../provision/plan.ts";
import { readCaller, unavailable } from "../../threadAccess.ts";
import { workGrantOf } from "../../workGrantAccess.ts";
import { fleetPrincipalOf } from "../orchestrator/remote.ts";

export interface AddToMachineInput {
  readonly machine: string;
  readonly projectId?: ProjectId | undefined;
  readonly cloneUrl?: string | undefined;
  readonly destinationPath?: string | undefined;
  readonly title?: string | undefined;
  readonly branch?: string | undefined;
  readonly protocol?: SourceControlCloneProtocol | undefined;
}

// A clone of a large repository over a slow link takes minutes; registering it does not.
const CLONE_TIMEOUT_MS = 10 * 60 * 1_000;
const CREATE_TIMEOUT_MS = 60 * 1_000;
// Accepting a link fingerprints the fresh clone there.
const LINK_TIMEOUT_MS = 60 * 1_000;

const invalid = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });

/** The URL another machine clones: a fork's own remote, else the repository's. */
export const cloneUrlOf = (identity: RepositoryIdentity): string =>
  identity.origin?.remoteUrl ?? identity.locator.remoteUrl;

const HOME_PREFIX =
  /^(?:\/Users\/[^/]+|\/home\/[^/]+|\/root|[A-Za-z]:[\\/]Users[\\/][^\\/]+)(?=$|[\\/])/u;

/** The folder relative to home here, so it lands in the same place there; outside home, its name under home. */
export function destinationFor(sourceRoot: string): string {
  const trimmed = sourceRoot.replace(/[\\/]+$/u, "");
  if (trimmed === "~" || trimmed.startsWith("~/")) return trimmed;
  const home = HOME_PREFIX.exec(trimmed);
  if (home) {
    const rest = trimmed.slice(home[0].length).replaceAll("\\", "/").replace(/^\/+/u, "");
    if (rest) return `~/${rest}`;
  }
  const name = trimmed.split(/[\\/]/u).findLast(Boolean);
  return `~/${name ?? "project"}`;
}

/** `repo` from `git@host:owner/repo.git`, `https://host/owner/repo` or a path. */
export function repositoryNameOf(cloneUrl: string): string {
  const last = cloneUrl
    .replace(/[\\/]+$/u, "")
    .split(/[/:\\]/u)
    .findLast(Boolean);
  return (last ?? "project").replace(/\.git$/iu, "") || "project";
}

/** Git's words for a remote the machine has no working credentials for. */
const CREDENTIAL_FAILURE =
  /authentication failed|could not read (?:username|password)|terminal prompts disabled|permission denied \(publickey|host key verification failed|invalid username or password|password authentication is not supported|repository not found|returned error: 40[13]|access denied/iu;

export const isCredentialFailure = (message: string) => CREDENTIAL_FAILURE.test(message);

/** What the user does on `label` so its git can read the repository. */
export const credentialHint = (label: string) =>
  `${label} has no working git credentials for this repository. On ${label}, sign in with gh auth login if gh is not signed in, then run ${SETUP_GIT_COMMAND} so git uses it (provisioning ${label} again runs it too), or retry with protocol "https" when its SSH key is refused. Then call studio_project_add_to_machine again.`;

/** The hint a launch adds when the project is not on the machine yet. */
export const addToMachineHint = (
  machine: Pick<OrchestratorMcpMachineRef, "label">,
  projectId: ProjectId,
) =>
  `To put this project there, call studio_project_add_to_machine {machine:"${machine.label}", projectId:"${projectId}"}, then launch again with machine:"${machine.label}" and the machineProjectId it returns.`;

const readCloneUrl = Effect.fn("mcp.addToMachine.readCloneUrl")(function* (projectId: ProjectId) {
  const projects = yield* ProjectService.ProjectService;
  const project = Option.getOrUndefined(
    yield* projects.getById(projectId).pipe(Effect.mapError(unavailable)),
  );
  if (project === undefined) return yield* invalid("The project was not found.");
  // A checkout added a moment ago may have no cached identity yet.
  const identity =
    project.repositoryIdentity ??
    (yield* Effect.serviceOption(RepositoryIdentityResolver.RepositoryIdentityResolver).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.succeed(null),
          onSome: (resolver) => resolver.resolve(project.workspaceRoot, { refresh: true }),
        }),
      ),
    ));
  if (identity == null)
    return yield* invalid(
      `Project "${project.title}" has no git remote another machine could clone. Push it to a remote first, or pass cloneUrl.`,
    );
  return { project, cloneUrl: cloneUrlOf(identity) };
});

/**
 * Clones a repository on another machine with that machine's own credentials
 * and registers it there. That machine decides: its clone and create refuse
 * a grant that does not cover all of its projects. Only an agent in a thread
 * here or an outside client the user approved here may ask; work another
 * machine started here may not reach a third one this way.
 */
export const addProjectToMachine = Effect.fn("mcp.addProjectToMachine")(function* (
  input: AddToMachineInput,
) {
  const context = yield* readCaller();
  yield* fleetPrincipalOf(context, "act");
  if ((yield* workGrantOf(context)) !== undefined)
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message:
        "Work another machine started here cannot add projects to other machines. Ask the user on the machine the work came from.",
    });
  if ((input.projectId === undefined) === (input.cloneUrl === undefined))
    return yield* invalid("Pass either projectId (a project here) or cloneUrl, not both.");
  const remote = yield* RemoteWorkers.RemoteWorkers;
  const target = yield* remote.resolveMachine(input.machine);
  if (target.kind !== "remote")
    return yield* invalid(
      "That is this machine. Use studio_project_clone, then studio_project_create, to add a repository here.",
    );
  const machine = target.machine;
  const source = input.projectId === undefined ? undefined : yield* readCloneUrl(input.projectId);
  const cloneUrl = source?.cloneUrl ?? input.cloneUrl!;
  const destinationPath =
    input.destinationPath ??
    (source ? destinationFor(source.project.workspaceRoot) : `~/${repositoryNameOf(cloneUrl)}`);
  const cloned = yield* remote
    .proxy({
      machine,
      tool: "studio_project_clone",
      arguments: {
        remoteUrl: cloneUrl,
        destinationPath,
        ...(input.protocol === undefined ? {} : { protocol: input.protocol }),
      },
      timeoutMs: CLONE_TIMEOUT_MS,
    })
    .pipe(
      Effect.mapError((error) =>
        error.code === "orchestration_error" && isCredentialFailure(error.message)
          ? new OrchestratorMcpFailure({
              code: error.code,
              message: `${error.message} ${credentialHint(machine.label)}`,
            })
          : error,
      ),
      Effect.flatMap((answer) =>
        Schema.decodeUnknownEffect(SourceControlCloneRepositoryResult)(answer).pipe(
          Effect.mapError(
            () =>
              new OrchestratorMcpFailure({
                code: "orchestration_error",
                message: `${machine.label} cloned the repository but sent an answer this machine could not read.`,
              }),
          ),
        ),
      ),
    );
  const title = input.title ?? source?.project.title ?? repositoryNameOf(cloneUrl);
  const created = yield* remote
    .proxy({
      machine,
      tool: "studio_project_create",
      arguments: {
        title,
        workspaceRoot: cloned.cwd,
        // A check's project stays a check's project there; a folder guess is never saved.
        ...(source?.project.workspaceSettings?.origin === "automated"
          ? { origin: "automated" }
          : {}),
      },
      timeoutMs: CREATE_TIMEOUT_MS,
    })
    .pipe(
      Effect.mapError(
        (error) =>
          new OrchestratorMcpFailure({
            code: error.code,
            message: `${error.message} The clone is at ${cloned.cwd} on ${machine.label}; ask the user to add that folder as a project there.`,
          }),
      ),
      Effect.flatMap((answer) =>
        Schema.decodeUnknownEffect(Project)(answer).pipe(
          Effect.mapError(
            () =>
              new OrchestratorMcpFailure({
                code: "orchestration_error",
                message: `${machine.label} registered the project but sent an answer this machine could not read. studio_machine_list shows its projects there.`,
              }),
          ),
        ),
      ),
    );
  const link =
    source === undefined
      ? undefined
      : yield* linkCopy({ sourceId: source.project.id, machine, copyId: created.id });
  const strategy =
    input.branch === undefined
      ? ""
      : `, workspaceStrategy:{type:"worktree",baseRef:"${input.branch}",branch:"<new branch>",startFromOrigin:true}`;
  return {
    machine,
    projectId: created.id,
    title: created.title,
    workspaceRoot: created.workspaceRoot,
    remoteUrl: cloned.remoteUrl,
    ...(input.branch === undefined ? {} : { branch: input.branch }),
    ...(link === undefined
      ? {}
      : link.linked
        ? { linked: true }
        : { linked: false, linkProblem: link.problem }),
    next: `Launch there with studio_thread_launch {machine:"${machine.label}", machineProjectId:"${created.id}"${strategy}}.`,
  };
});

type LinkOutcome = { readonly linked: true } | { readonly linked: false; readonly problem: string };

/**
 * Makes the copy on `machine` the same project as the one here, as the app's
 * Link… does: prepare here, accept there, commit here. Without it the copy has
 * its own identity and every machine lists it as a second project. A copy that
 * cannot link stays registered; the answer says why and how to link it.
 */
const linkCopy = Effect.fn("mcp.addToMachine.linkCopy")(function* (input: {
  readonly sourceId: ProjectId;
  readonly machine: OrchestratorMcpMachineRef;
  readonly copyId: ProjectId;
}) {
  const unlinked = (reason: string): LinkOutcome => ({
    linked: false,
    problem: `${reason} It is listed as a separate project until you link it: open its menu in the sidebar and choose Link….`,
  });
  const link = Option.getOrUndefined(yield* Effect.serviceOption(ProjectLink.ProjectLink));
  if (link === undefined) return unlinked("This machine could not link the copy.");
  const remote = yield* RemoteWorkers.RemoteWorkers;
  const operationId = yield* randomUuidV4;
  const linked = Effect.gen(function* () {
    const prepared = yield* link.prepare({
      operationId,
      projectId: input.sourceId,
      joining: {
        environmentId: input.machine.environmentId,
        projectId: input.copyId,
        coordinatorThreadId: ThreadId.make(`project-coordinator:${input.copyId}`),
      },
    });
    const answer = yield* remote.proxy({
      machine: input.machine,
      tool: "studio_project_link_accept",
      arguments: {
        operationId,
        projectId: input.copyId,
        kept: prepared.kept,
        logicalProject: prepared.logicalProject,
        coordinatorBinding: prepared.coordinatorBinding,
        keptFingerprint: prepared.fingerprint,
      },
      timeoutMs: LINK_TIMEOUT_MS,
    });
    const accepted = yield* Schema.decodeUnknownEffect(ProjectLinkAcceptResult)(answer);
    yield* link.commit({
      operationId,
      projectId: input.sourceId,
      joining: accepted.member,
      notes: [],
    });
    return { linked: true } as LinkOutcome;
  });
  return yield* linked.pipe(
    Effect.catch((error) =>
      Effect.succeed(
        unlinked(`The copy on ${input.machine.label} was not linked: ${error.message}`),
      ),
    ),
  );
});
