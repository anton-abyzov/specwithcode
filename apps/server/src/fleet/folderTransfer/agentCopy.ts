// @effect-diagnostics nodeBuiltinImport:off - a bounded read-only walk names the rebuildable folders a plain folder leaves out.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  type EnvironmentId,
  type FolderCopyError,
  FolderCopyStartInput,
  FolderCopyState,
  type FolderCopyStatus,
  MachineHandoffOperationId,
  OrchestratorMcpFailure,
  ProjectId,
  ProjectLinkAcceptInput,
  ProjectLinkAcceptResult,
  ThreadId,
  type FolderCopySourceSummary,
} from "@specweave-studio/contracts";
import { teamRulesMachineLinkRefusal } from "@specweave-studio/shared/teamRules";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { randomUuidV4 } from "../../orchestration-v2/RandomUuid.ts";
import { expandHomePathWith } from "../../pathExpansion.ts";
import * as ProjectLink from "../../project/ProjectLink.ts";
import { currentTeamRules } from "../../teamRules/TeamRules.ts";
import * as MachineHandoff from "../MachineHandoff.ts";
import { DEFAULT_SELECTION, isRebuildableDirectoryName } from "./classify.ts";

/**
 * Folder copy started by an agent (studio_project_add_to_machine on a project
 * with no Git remote), with no browser on either side. The source offers the
 * folder through the same engine as Handoff > Copy files; the destination pulls
 * it and applies it only into a missing or empty folder, so there is nothing to
 * review: every class except secrets and rebuildable folders, conflicts refused.
 * Secrets never travel here; the result lists them for studio_file_transfer,
 * which keeps its owner approval card.
 */

/** Every class the person's default copy takes; rebuildable folders and secrets stay behind. */
export const AGENT_COPY_SELECTION = DEFAULT_SELECTION;

const bounded = (max: number) => Schema.String.check(Schema.isMaxLength(max));

/** Internal, between SpecWithCode machines: the destination half, one step per call. */
export const AgentCopyReceiveInput = Schema.Struct({
  action: Schema.Literals(["check", "start", "status", "link"]),
  /** check: the folder the copy will land in, `~` meaning that machine's home. */
  targetFolder: Schema.optional(bounded(4096)),
  /** start: the source's offer, with the absolute folder check returned. */
  start: Schema.optional(FolderCopyStartInput),
  /** status and link: the copy to read or link. */
  operationId: Schema.optional(MachineHandoffOperationId),
  /** link: the source's prepared link, accepted for the project the copy registered. */
  link: Schema.optional(ProjectLinkAcceptInput),
});
export type AgentCopyReceiveInput = typeof AgentCopyReceiveInput.Type;

export const AgentCopyReceiveResult = Schema.Struct({
  targetFolder: Schema.optional(bounded(4096)),
  state: Schema.optional(FolderCopyState),
  projectId: Schema.optional(Schema.NullOr(ProjectId)),
  projectFolder: Schema.optional(bounded(4096)),
  filesDone: Schema.optional(Schema.Number),
  filesTotal: Schema.optional(Schema.Number),
  link: Schema.optional(ProjectLinkAcceptResult),
});
export type AgentCopyReceiveResult = typeof AgentCopyReceiveResult.Type;

const invalid = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });
const failed = (message: string) =>
  new OrchestratorMcpFailure({ code: "orchestration_error", message });

const copyFailure = (error: FolderCopyError) =>
  error.code === "refused" || error.code === "invalid" || error.code === "not_a_folder"
    ? invalid(error.message)
    : failed(error.message);

/** Team rules that stop machines working together also stop an agent's folder copy. */
const refuseByTeamRules = Effect.gen(function* () {
  const refused = teamRulesMachineLinkRefusal(yield* currentTeamRules);
  if (refused !== null)
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: `Folder copy is off: ${refused.message}`,
    });
});

const handoffService = Effect.serviceOption(MachineHandoff.MachineHandoff).pipe(
  Effect.flatMap((found) =>
    found._tag === "Some"
      ? Effect.succeed(found.value)
      : Effect.fail(failed("This machine cannot copy folders right now.")),
  ),
);

/** The absolute folder `requested` names here, refused unless it is missing or empty. */
const emptyTarget = Effect.fn("fleet.agentCopy.emptyTarget")(function* (requested: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const target = path.resolve(expandHomePathWith(requested.trim(), path));
  if (!path.isAbsolute(target)) return yield* invalid("Pass an absolute folder or one under ~.");
  const info = yield* fs.stat(target).pipe(Effect.option);
  if (info._tag === "None") return target;
  if (info.value.type !== "Directory")
    return yield* invalid(`${target} exists and is not a folder. Pass a new destinationPath.`);
  const entries = yield* fs
    .readDirectory(target)
    .pipe(Effect.mapError(() => failed(`${target} could not be read.`)));
  if (entries.some((name) => name !== ".DS_Store"))
    return yield* invalid(
      `${target} already exists and is not empty, so nothing was copied. Pass a destinationPath that does not exist yet.`,
    );
  return target;
});

const condensed = (status: FolderCopyStatus): AgentCopyReceiveResult => ({
  targetFolder: status.targetFolder,
  state: status.state,
  projectId: status.projectId,
  ...(status.projectFolder !== undefined ? { projectFolder: status.projectFolder } : {}),
  ...(status.progress
    ? { filesDone: status.progress.filesDone, filesTotal: status.progress.filesTotal }
    : {}),
});

/** An empty destination has nothing to decide or replace; anything else means it changed. */
const previewIsClean = (status: FolderCopyStatus) =>
  !status.rows.some((row) => row.needsDecision || (row.replacing ?? 0) > 0) &&
  (status.totals?.decisionsNeeded ?? 0) === 0 &&
  (status.totals?.replacing ?? 0) === 0;

/**
 * The destination half. The caller (the MCP handler) has already checked that the
 * calling machine's grant covers every project here, as for a clone.
 */
export const receiveAgentCopy = Effect.fn("fleet.agentCopy.receive")(function* (
  input: AgentCopyReceiveInput,
  caller: { readonly environmentId: string },
) {
  yield* refuseByTeamRules;
  const handoff = yield* handoffService;
  if (input.action === "check") {
    if (input.targetFolder === undefined) return yield* invalid("Pass targetFolder.");
    return { targetFolder: yield* emptyTarget(input.targetFolder) } as AgentCopyReceiveResult;
  }
  if (input.action === "start") {
    const start = input.start;
    if (start === undefined || start.mode !== "copy-only")
      return yield* invalid("Pass the source's copy-only offer.");
    if (start.sourceEnvironmentId !== caller.environmentId)
      return yield* invalid("Only the machine that offers a folder starts its copy here.");
    const targetFolder = yield* emptyTarget(start.targetFolder);
    const status = yield* handoff
      .copyStart({ ...start, targetFolder, selection: [...AGENT_COPY_SELECTION] })
      .pipe(Effect.mapError(copyFailure));
    return condensed(status);
  }
  if (input.operationId === undefined) return yield* invalid("Pass operationId.");
  const operationId = input.operationId;
  let status = yield* handoff.copyStatus({ operationId }).pipe(Effect.mapError(copyFailure));
  if (status.sourceEnvironmentId !== caller.environmentId)
    return yield* invalid("That copy came from another machine.");
  if (input.action === "link") {
    const link = input.link;
    if (
      link === undefined ||
      status.state !== "applied" ||
      status.projectId === null ||
      link.projectId !== status.projectId ||
      link.kept.projectId !== status.sourceProjectId ||
      link.kept.environmentId !== status.sourceEnvironmentId
    )
      return yield* invalid(
        "Only the project this copy registered links to the project it came from.",
      );
    const projectLink = yield* ProjectLink.ProjectLink;
    const accepted = yield* projectLink
      .accept(link, { copiedFromKept: true })
      .pipe(Effect.mapError((error) => invalid(error.message)));
    return { ...condensed(status), link: accepted } as AgentCopyReceiveResult;
  }
  if (status.state === "previewed") {
    if (!previewIsClean(status)) {
      yield* handoff
        .copyCancel({ operationId, reason: "The destination folder was not empty." })
        .pipe(Effect.ignore);
      return yield* invalid(
        `${status.targetFolder} changed while the copy was being compared, so nothing was copied. Pass a destinationPath that does not exist yet.`,
      );
    }
    status = yield* handoff.copyApprove({ operationId }).pipe(Effect.mapError(copyFailure));
  }
  if (status.state === "failed" || status.state === "cancelled" || status.state === "undone")
    return yield* failed(
      status.error?.message ?? `The copy ${status.state === "failed" ? "failed" : "stopped"}.`,
    );
  return condensed(status);
});

export interface AgentCopyMachine {
  readonly label: string;
  readonly environmentId: EnvironmentId;
}

export interface AgentCopyLeftOut {
  /** Files left out in all: secrets plus rebuildable files counted by the scan. */
  readonly files: number;
  /** Secret files here (and `~/` ones), never sent by this copy. */
  readonly secretFiles: ReadonlyArray<string>;
  /** Rebuildable folders (dependencies, build output) left out without counting their files. */
  readonly rebuildableFolders: number;
  /** Their paths, for a plain folder with no repository; capped. */
  readonly rebuildableFolderPaths?: ReadonlyArray<string>;
}

export type AgentCopyOutcome = {
  readonly projectId: ProjectId;
  readonly workspaceRoot: string;
  readonly leftOut: AgentCopyLeftOut;
} & ({ readonly linked: true } | { readonly linked: false; readonly linkProblem: string });

const POLL_MS = 1_500;
/** A large folder over a slow link takes long; past this the copy keeps going there. */
const COPY_LIMIT_MS = 30 * 60 * 1_000;
const MAX_LISTED_FOLDERS = 50;
const MAX_WALKED_FOLDERS = 5_000;
const MAX_WALK_DEPTH = 8;

/**
 * Where a plain folder's rebuildable folders are, as the scan collapses them: a
 * folder with a rebuildable name and no `.git` inside. Bounded and best effort;
 * the scan's count stays the authority.
 */
export async function listRebuildableFolders(root: string): Promise<ReadonlyArray<string>> {
  const found: Array<string> = [];
  let walked = 0;
  const walk = async (relative: string, depth: number): Promise<void> => {
    if (found.length >= MAX_LISTED_FOLDERS || walked >= MAX_WALKED_FOLDERS) return;
    walked += 1;
    const entries = await NodeFSP.readdir(NodePath.join(root, relative), {
      withFileTypes: true,
    }).catch(() => []);
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() || entry.name === ".git") continue;
      const child = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (isRebuildableDirectoryName(entry.name)) {
        const repository = await NodeFSP.lstat(NodePath.join(root, child, ".git")).then(
          () => true,
          () => false,
        );
        if (!repository) {
          found.push(child);
          if (found.length >= MAX_LISTED_FOLDERS) return;
          continue;
        }
      }
      if (depth < MAX_WALK_DEPTH) await walk(child, depth + 1);
    }
  };
  await walk("", 1);
  return found;
}

const leftOutOf = (summary: FolderCopySourceSummary, paths: ReadonlyArray<string> | null) => {
  const rebuildableFolders = summary.skipped?.rebuildableFolders ?? 0;
  return {
    files: summary.secretFiles.length + summary.totals.rebuildable.files,
    secretFiles: summary.secretFiles.map((file) => file.path),
    rebuildableFolders,
    ...(paths !== null && paths.length > 0 ? { rebuildableFolderPaths: paths } : {}),
  } satisfies AgentCopyLeftOut;
};

const decodeReceived = Schema.decodeUnknownEffect(AgentCopyReceiveResult);

/**
 * The source half: checks the destination, offers the project folder, lets the
 * destination pull and apply it, then links the registered copy as a member of
 * this project. `receive` calls the destination's studio_folder_copy_receive.
 * Any refusal before Apply leaves nothing written there; the offer is withdrawn.
 */
export const runAgentCopy = Effect.fn("fleet.agentCopy.run")(function* (input: {
  readonly projectId: ProjectId;
  readonly workspaceRoot: string;
  readonly machine: AgentCopyMachine;
  readonly targetFolder: string;
  readonly receive: (
    args: AgentCopyReceiveInput,
    timeoutMs?: number,
  ) => Effect.Effect<unknown, OrchestratorMcpFailure>;
  /** Between status reads; tests shorten it. */
  readonly pollMs?: number;
}) {
  const { machine } = input;
  const POLL = Duration.millis(input.pollMs ?? POLL_MS);
  yield* refuseByTeamRules;
  const handoff = yield* handoffService;
  const ask = (args: AgentCopyReceiveInput, timeoutMs?: number) =>
    input.receive(args, timeoutMs).pipe(
      Effect.mapError((error) =>
        error.code === "machine_unsupported"
          ? new OrchestratorMcpFailure({
              code: error.code,
              message: `${machine.label} runs a SpecWithCode without folder copy for agents, so nothing was copied. Update SpecWithCode on ${machine.label}, then call studio_project_add_to_machine again.`,
            })
          : error,
      ),
      Effect.flatMap((answer) =>
        decodeReceived(answer).pipe(
          Effect.mapError(() =>
            failed(`${machine.label} sent an answer this machine could not read.`),
          ),
        ),
      ),
    );
  const checked = yield* ask({ action: "check", targetFolder: input.targetFolder });
  const targetFolder = checked.targetFolder;
  if (targetFolder === undefined) return yield* failed(`${machine.label} did not name the folder.`);
  const operationId = yield* randomUuidV4;
  const offer = yield* handoff
    .copyOffer({
      projectId: input.projectId,
      operationId,
      mode: "copy-only",
      destinationEnvironmentId: machine.environmentId,
    })
    .pipe(Effect.mapError(copyFailure));
  const withdraw = (reason: string) =>
    handoff.copySourceCancel({ operationId, reason }).pipe(Effect.ignore);
  const copied = Effect.gen(function* () {
    let scanned = offer.status;
    while (scanned.state === "scanning") {
      yield* Effect.sleep(POLL);
      scanned = yield* handoff.copySourceStatus({ operationId }).pipe(Effect.mapError(copyFailure));
    }
    const summary = scanned.summary;
    if (summary === null) return yield* failed(scanned.error ?? "The folder could not be read.");
    let status = yield* ask(
      {
        action: "start",
        start: {
          operationId,
          sourceEnvironmentId: offer.sourceEnvironmentId,
          sourceProjectId: offer.sourceProjectId,
          sourceUrl: offer.sourceUrl,
          ...(offer.sourceConnectUrl ? { sourceConnectUrl: offer.sourceConnectUrl } : {}),
          sourceMachine: offer.sourceMachine,
          token: offer.token,
          title: offer.title,
          mode: "copy-only",
          targetFolder,
          selection: [...AGENT_COPY_SELECTION],
        },
      },
      60_000,
    );
    while (!(status.state === "applied" && status.projectId != null)) {
      yield* Effect.sleep(POLL);
      status = yield* ask({ action: "status", operationId }, 60_000);
    }
    const paths =
      summary.repositories.length === 0 && (summary.skipped?.rebuildableFolders ?? 0) > 0
        ? yield* Effect.promise(() => listRebuildableFolders(input.workspaceRoot))
        : null;
    return {
      copyId: status.projectId,
      workspaceRoot: status.projectFolder ?? targetFolder,
      leftOut: leftOutOf(summary, paths),
    };
  }).pipe(
    // A refusal withdraws the offer; a copy still running when time is up keeps going.
    Effect.tapError(() => withdraw("The copy did not finish.")),
    Effect.timeoutOrElse({
      duration: Duration.millis(COPY_LIMIT_MS),
      orElse: () =>
        Effect.fail(
          failed(
            `The copy to ${targetFolder} on ${machine.label} is still running. When it finishes, the project there is listed on its own; ask the user to link it (its sidebar menu > Link…).`,
          ),
        ),
    }),
  );
  const result = yield* copied;
  const link = yield* linkCopied({
    sourceId: input.projectId,
    machine,
    copyId: result.copyId,
    operationId,
    ask,
  });
  return {
    projectId: result.copyId,
    workspaceRoot: result.workspaceRoot,
    leftOut: result.leftOut,
    ...link,
  } as AgentCopyOutcome;
});

/** Prepare here, accept there for the copy just registered, commit here, as Link… does. */
const linkCopied = Effect.fn("fleet.agentCopy.link")(function* (input: {
  readonly sourceId: ProjectId;
  readonly machine: AgentCopyMachine;
  readonly copyId: ProjectId;
  readonly operationId: string;
  readonly ask: (
    args: AgentCopyReceiveInput,
    timeoutMs?: number,
  ) => Effect.Effect<AgentCopyReceiveResult, OrchestratorMcpFailure>;
}) {
  const unlinked = (reason: string) => ({
    linked: false as const,
    linkProblem: `${reason} It is listed as a separate project until you link it: open its menu in the sidebar and choose Link….`,
  });
  const found = yield* Effect.serviceOption(ProjectLink.ProjectLink);
  if (found._tag === "None") return unlinked("This machine could not link the copy.");
  const link = found.value;
  const linkOperationId = yield* randomUuidV4;
  return yield* Effect.gen(function* () {
    const prepared = yield* link.prepare({
      operationId: linkOperationId,
      projectId: input.sourceId,
      joining: {
        environmentId: input.machine.environmentId,
        projectId: input.copyId,
        coordinatorThreadId: ThreadId.make(`project-coordinator:${input.copyId}`),
      },
    });
    const answer = yield* input.ask(
      {
        action: "link",
        operationId: input.operationId,
        link: {
          operationId: linkOperationId,
          projectId: input.copyId,
          kept: prepared.kept,
          logicalProject: prepared.logicalProject,
          coordinatorBinding: prepared.coordinatorBinding,
          keptFingerprint: prepared.fingerprint,
          ...(prepared.sharedIcon ? { sharedIcon: prepared.sharedIcon } : {}),
        },
      },
      60_000,
    );
    if (answer.link === undefined) return yield* failed(`${input.machine.label} did not link it.`);
    yield* link.commit({
      operationId: linkOperationId,
      projectId: input.sourceId,
      joining: answer.link.member,
      notes: [],
    });
    return { linked: true as const };
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed(
        unlinked(`The copy on ${input.machine.label} was not linked: ${error.message}`),
      ),
    ),
  );
});
