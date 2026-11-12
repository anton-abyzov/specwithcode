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
import {
  canMatchRemoteCopies,
  halfLinkedRemoteCopies,
  unlinkedRemoteCopies,
} from "../../../fleet/remoteWorkerMatching.ts";
import { runAgentCopy } from "../../../fleet/folderTransfer/agentCopy.ts";
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
  `To put this project there, call studio_project_add_to_machine {machine:"${machine.label}", projectId:"${projectId}"}: it clones the repository there, or copies the project folder when it has no Git remote. Then launch again with machine:"${machine.label}" and the machineProjectId it returns.`;

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
  // No remote another machine could clone (or no Git at all): the folder is copied instead.
  return { project, cloneUrl: identity == null ? null : cloneUrlOf(identity) };
});

/** What the agent does about the secret files a folder copy left here. */
const secretsNext = (
  machineLabel: string,
  workspaceRoot: string,
  secrets: ReadonlyArray<string>,
) =>
  secrets.length === 0
    ? ""
    : ` Secret files stayed here: ${secrets.join(", ")}. Send each one the work there needs with studio_file_transfer {machine:"${machineLabel}", direction:"send", path, destinationPath} (under ${workspaceRoot} for a file in the project); the owner approves each one.`;

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
  // The repository is already there as a project of its own: link it rather than
  // cloning a second copy, which every machine would list as one more project.
  if (source !== undefined && input.destinationPath === undefined) {
    // This project already names a copy there (linked, or saved as its project on that
    // machine). One that cannot be used is repaired or relinked, never replaced by
    // linking or cloning another, which would undo an unlink or make two copies there.
    const listedThere =
      source.project.workspaceSettings?.logicalProject?.members.find(
        (member) => member.environmentId === machine.environmentId,
      )?.projectId ?? RemoteWorkers.savedWorkerMachine(source.project, machine)?.projectId;
    if (listedThere != null)
      return yield* invalid(
        `This project already has ${listedThere} as its copy on ${machine.label}. Launch there with machineProjectId:"${listedThere}"; if that copy is gone or was unlinked, ask the user to relink it (its sidebar menu > Link…) or remove it in Settings > Machines, or pass destinationPath to clone one more copy.`,
      );
    // A failed search is reported, not read as "no copy": cloning then would add the
    // very duplicate this check prevents.
    const existing = yield* linkExistingCopy({ project: source.project, machine }).pipe(
      Effect.mapError((error) =>
        invalid(
          `Could not check ${machine.label} for a project of this repository it already has: ${error.message} Retry, or pass destinationPath to clone one more copy anyway.`,
        ),
      ),
    );
    if (existing.kind === "ambiguous")
      return yield* invalid(
        `${machine.label} already has ${existing.candidates.length} projects of this repository: ${existing.candidates
          .map((copy) => `${copy.title} (${copy.id}, ${copy.workspaceRoot})`)
          .join(
            ", ",
          )}. Ask the user which one to link (its sidebar menu > Link…), or pass destinationPath to clone one more copy.`,
      );
    if (existing.kind === "linked" || existing.kind === "unlinked")
      return {
        machine,
        projectId: existing.copy.id,
        title: existing.copy.title,
        workspaceRoot: existing.copy.workspaceRoot,
        ...(source.cloneUrl === null ? {} : { remoteUrl: source.cloneUrl }),
        ...(existing.kind === "linked"
          ? { linked: true, existingCopy: true }
          : { linked: false, existingCopy: true, linkProblem: existing.problem }),
        next: `Launch there with studio_thread_launch {machine:"${machine.label}", machineProjectId:"${existing.copy.id}"}.`,
      };
  }
  if (source !== undefined && source.cloneUrl === null)
    return yield* copyProjectFolder({
      project: source.project,
      machine,
      destinationPath: input.destinationPath ?? destinationFor(source.project.workspaceRoot),
      branch: input.branch,
    });
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

/**
 * A project with no Git remote (or no Git at all) goes there as a folder copy: the
 * same engine as Handoff > Copy files, into a folder that does not exist yet there,
 * without secrets or rebuildable folders, then linked as a member of this project.
 */
const copyProjectFolder = Effect.fn("mcp.addToMachine.copyProjectFolder")(function* (input: {
  readonly project: Project;
  readonly machine: OrchestratorMcpMachineRef;
  readonly destinationPath: string;
  readonly branch: string | undefined;
}) {
  const remote = yield* RemoteWorkers.RemoteWorkers;
  const { machine } = input;
  const copied = yield* runAgentCopy({
    projectId: input.project.id,
    workspaceRoot: input.project.workspaceRoot,
    machine,
    targetFolder: input.destinationPath,
    receive: (args, timeoutMs) =>
      remote.proxy({
        machine,
        tool: "studio_folder_copy_receive",
        arguments: args as unknown as Record<string, unknown>,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      }),
  });
  const strategy =
    input.branch === undefined
      ? ""
      : `, workspaceStrategy:{type:"worktree",baseRef:"${input.branch}",branch:"<new branch>",startFromOrigin:false}`;
  return {
    machine,
    projectId: copied.projectId,
    title: input.project.title,
    workspaceRoot: copied.workspaceRoot,
    copied: true,
    leftOut: copied.leftOut,
    ...(input.branch === undefined ? {} : { branch: input.branch }),
    ...(copied.linked ? { linked: true } : { linked: false, linkProblem: copied.linkProblem }),
    next: `Launch there with studio_thread_launch {machine:"${machine.label}", machineProjectId:"${copied.projectId}"${strategy}}.${secretsNext(machine.label, copied.workspaceRoot, copied.leftOut.secretFiles)}`,
  };
});

const decodeListedProject = Schema.decodeUnknownOption(Project);

// A machine lists at most this many pages of 100 projects for a copy search.
const MAX_COPY_SEARCH_PAGES = 10;

/** Every project another machine lists, newest snapshot, for finding a copy there. */
const listProjectsOn = Effect.fn("mcp.addToMachine.listProjectsOn")(function* (
  machine: OrchestratorMcpMachineRef,
) {
  const remote = yield* RemoteWorkers.RemoteWorkers;
  const listed: Project[] = [];
  let cursor: number | null = 0;
  for (let page = 0; page < MAX_COPY_SEARCH_PAGES && cursor !== null; page++) {
    const answer: unknown = yield* remote.proxy({
      machine,
      tool: "studio_project_list",
      arguments: { cursor, limit: 100 },
    });
    const record = typeof answer === "object" && answer !== null ? answer : {};
    const rows = "projects" in record && Array.isArray(record.projects) ? record.projects : [];
    for (const row of rows) {
      const decoded = decodeListedProject(row);
      if (Option.isSome(decoded)) listed.push(decoded.value);
    }
    cursor =
      "nextCursor" in record && typeof record.nextCursor === "number" ? record.nextCursor : null;
  }
  if (cursor !== null)
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message: `${machine.label} lists more than ${MAX_COPY_SEARCH_PAGES * 100} projects, so not all of them were checked.`,
    });
  return listed;
});

export type ExistingCopyOutcome =
  | { readonly kind: "none" }
  | { readonly kind: "ambiguous"; readonly candidates: ReadonlyArray<Project> }
  | { readonly kind: "linked"; readonly copy: Project }
  | { readonly kind: "unlinked"; readonly copy: Project; readonly problem: string };

/**
 * True only when the project `copyId` on `machine` has never had a thread, archived
 * and subagent ones included. Linking a copy hands its coordinating to this project,
 * so a copy with history of its own is left for the person to link with Link…, where
 * they compare both and choose what to keep. An answer that cannot be read counts
 * as history.
 */
const copyHasNoThreads = (machine: OrchestratorMcpMachineRef, copyId: ProjectId) =>
  Effect.gen(function* () {
    const remote = yield* RemoteWorkers.RemoteWorkers;
    const answer: unknown = yield* remote.proxy({
      machine,
      tool: "studio_thread_list",
      arguments: { projectId: copyId, includeArchived: true, includeSubagents: true, limit: 1 },
    });
    const record = typeof answer === "object" && answer !== null ? answer : {};
    const threads = "threads" in record && Array.isArray(record.threads) ? record.threads : null;
    const total = "total" in record && typeof record.total === "number" ? record.total : null;
    // An older machine ignores includeArchived and lists only active threads; it says
    // so by not echoing the flag, and then archived history cannot be ruled out.
    const archivedCounted = "includeArchived" in record && record.includeArchived === true;
    return archivedCounted && threads !== null && threads.length === 0 && total === 0;
  }).pipe(Effect.orElseSucceed(() => false));

/**
 * The same repository was added on `machine` on its own, so it is listed there as a
 * second project with the same name. Links that copy into this project, as Link…
 * does, so one project spans both machines. Only a single certain copy that has no
 * threads of its own is linked; several are left for the person to choose, and one
 * with history for them to link with Link…. A copy that already joined this project
 * there, when the link's last step here did not finish, is linked again to finish it.
 */
export const linkExistingCopy = Effect.fn("mcp.addToMachine.linkExistingCopy")(function* (input: {
  readonly project: Project;
  readonly machine: OrchestratorMcpMachineRef;
}) {
  const shared = input.project.workspaceSettings?.logicalProject != null;
  if (!shared && !canMatchRemoteCopies(input.project))
    return { kind: "none" } as ExistingCopyOutcome;
  const listed = yield* listProjectsOn(input.machine);
  const halfLinked = halfLinkedRemoteCopies({
    local: input.project,
    environmentId: input.machine.environmentId,
    remote: listed,
  });
  if (halfLinked.length > 1)
    return { kind: "ambiguous", candidates: halfLinked } as ExistingCopyOutcome;
  const resumed = halfLinked[0];
  if (resumed === undefined && !canMatchRemoteCopies(input.project))
    return { kind: "none" } as ExistingCopyOutcome;
  const copies =
    resumed === undefined ? unlinkedRemoteCopies({ local: input.project, remote: listed }) : [];
  if (resumed === undefined && copies.length === 0) return { kind: "none" } as ExistingCopyOutcome;
  if (copies.length > 1) return { kind: "ambiguous", candidates: copies } as ExistingCopyOutcome;
  const copy = resumed ?? copies[0]!;
  if (resumed === undefined && !(yield* copyHasNoThreads(input.machine, copy.id)))
    return {
      kind: "unlinked",
      copy,
      problem: `It has threads of its own, so it was not linked automatically: linking makes this project's coordinator the one for both copies. Open its menu in the sidebar and choose Link… to compare both and choose what to keep.`,
    } as ExistingCopyOutcome;
  const outcome = yield* linkCopy({
    sourceId: input.project.id,
    machine: input.machine,
    copyId: copy.id,
  });
  return (
    outcome.linked ? { kind: "linked", copy } : { kind: "unlinked", copy, problem: outcome.problem }
  ) as ExistingCopyOutcome;
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
        ...(prepared.sharedIcon ? { sharedIcon: prepared.sharedIcon } : {}),
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
