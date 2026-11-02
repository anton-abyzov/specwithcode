// @effect-diagnostics nodeBuiltinImport:off - paths on this machine, and transfer ids.
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";

import {
  OrchestratorMcpFailure,
  type OrchestratorMcpMachineRef,
  type ProjectId,
  type ThreadId,
} from "@specweave-studio/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../../../config.ts";
import {
  assertRoomFor,
  chunkCount,
  FileTransferRefusal,
  IncomingFile,
  inboxFolder,
  isCredentialLocation,
  isWithin,
  landingPath,
  MAX_SECRET_FILE_BYTES,
  type PinnedFile,
  pinResolved,
  readPinned,
  realRoots,
  resolveFile,
  safeFileName,
  sha256Pinned,
} from "../../../fleet/fileTransfer/files.ts";
import { FileOffers, type OfferCaller } from "../../../fleet/fileTransfer/offers.ts";
import { newReceivingKey, seal, unseal } from "../../../fleet/fileTransfer/seal.ts";
import * as RemoteWorkers from "../../../fleet/RemoteWorkers.ts";
import { projectInGrant } from "../../../fleet/workGrantPolicy.ts";
import * as ProjectActionRequests from "../../../project/ProjectActionRequests.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { assertFullAccess, readCaller } from "../../threadAccess.ts";
import { refuseRevoked, workGrantOf } from "../../workGrantAccess.ts";
import { fleetPrincipalOf } from "../orchestrator/remote.ts";
import {
  FileChunkAnswer,
  FileOfferAnswer,
  FileTransferResult,
  FileTransferToolkit,
} from "./tools.ts";

const invalid = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });

/** A refusal's own words; anything else is a fixed sentence, so no file content can leak out. */
const io = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) =>
      cause instanceof FileTransferRefusal
        ? invalid(cause.message)
        : new OrchestratorMcpFailure({
            code: "orchestration_error",
            message:
              (cause as NodeJS.ErrnoException).code === "ENOSPC"
                ? "This machine ran out of disk space. Clear space here, or rebuild the file where there is room."
                : "The file could not be read or written on this machine.",
          }),
  });

const OFFER_TIMEOUT_MS = 5 * 60 * 1000;
const CHUNK_TIMEOUT_MS = 60 * 1000;
const ANSWER_WITHIN_MS = 45 * 1000;
const MAX_REMEMBERED_JOBS = 64;

const offersByState = new Map<string, FileOffers>();
const offersFor = (baseDir: string, stateDir: string) => {
  let offers = offersByState.get(stateDir);
  if (offers === undefined) {
    offers = new FileOffers(baseDir, stateDir);
    offersByState.set(stateDir, offers);
  }
  return offers;
};

type Result = typeof FileTransferResult.Type;
interface Job {
  readonly threadId: ThreadId;
  readonly done: Deferred.Deferred<Result, OrchestratorMcpFailure>;
  bytes: number;
}
const jobs = new Map<string, Job>();

/** The grant-holding machine asking here. Everyone else, agents included, is refused. */
const offerCaller = Effect.gen(function* () {
  const context = yield* readCaller();
  const client = context.scope.client;
  const work = yield* workGrantOf(context);
  if (context.caller !== undefined || client === undefined || work === undefined)
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message:
        "This tool runs between SpecWithCode machines under a worker grant. Use studio_file_transfer.",
    });
  yield* refuseRevoked(work);
  const config = yield* ServerConfig.ServerConfig;
  const projects = yield* ProjectService.ProjectService;
  const shells = yield* projects
    .listShells()
    .pipe(Effect.mapError(() => invalid("This machine could not read its projects. Try again.")));
  const covered = shells.filter((shell) =>
    projectInGrant(work.grant.projects, work.grant.coordinatorEnvironmentId, shell),
  );
  const roots = yield* io(() =>
    realRoots([
      ...covered.flatMap((shell) => [
        shell.workspaceRoot,
        ...(shell.workspaceSettings?.environment?.additionalFolders ?? []),
      ]),
      // These hold every project's checkouts, so they belong to a grant over all of them.
      ...(work.grant.projects.kind === "all"
        ? [config.worktreesDir, NodePath.join(config.baseDir, "scratch")]
        : []),
    ]),
  );
  return {
    offers: offersFor(config.baseDir, config.stateDir),
    caller: {
      coordinatorEnvironmentId: work.grant.coordinatorEnvironmentId,
      coordinatorLabel: work.coordinatorLabel,
      mayCarrySecrets:
        work.grant.owner === "self" &&
        McpInvocationContext.clientRuntimeModeCeiling(client) === "full-access",
      roots,
    } satisfies OfferCaller,
  };
});

/** What the calling thread may read and write on this machine, real paths. */
const localRoots = (thread: {
  readonly projectId: ProjectId;
  readonly worktreePath?: string | null | undefined;
}) =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const projects = yield* ProjectService.ProjectService;
    const project = yield* projects.getById(thread.projectId).pipe(
      Effect.map(Option.getOrUndefined),
      Effect.orElseSucceed(() => undefined),
    );
    return yield* io(() =>
      realRoots([
        ...(project === undefined
          ? []
          : [
              project.workspaceRoot,
              ...(project.workspaceSettings?.environment?.additionalFolders ?? []),
            ]),
        ...(thread.worktreePath ? [thread.worktreePath] : []),
        inboxFolder(config.stateDir),
      ]),
    );
  });

const refuseProtected = (real: string, asked: string) =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    if (yield* io(() => isCredentialLocation(real, config.baseDir, config.stateDir)))
      return yield* invalid(
        `${asked} is in a credential or app folder, which never moves between machines. To reach another machine, the user allows it in Settings > Connections > Your private machines.`,
      );
  });

const describeProxyFailure = (machineLabel: string) => (error: OrchestratorMcpFailure) =>
  error.code === "machine_unsupported"
    ? new OrchestratorMcpFailure({
        code: error.code,
        message: `${machineLabel} runs an older SpecWithCode without file transfer. Update it, then try again.`,
      })
    : error.code === "machine_not_authorized"
      ? new OrchestratorMcpFailure({
          code: error.code,
          message: `This machine may not reach ${machineLabel}. Only the user allows that, in Settings > Connections > Your private machines. Until then, end your turn naming the file and its path: whoever holds access, such as your coordinator, can move it with studio_file_transfer.`,
        })
      : error;

const unreadable = (machineLabel: string) =>
  new OrchestratorMcpFailure({
    code: "orchestration_error",
    message: `${machineLabel} sent an answer this machine could not read. It may need updating.`,
  });
const decodeOfferAnswer = Schema.decodeUnknownEffect(FileOfferAnswer);
const decodeChunkAnswer = Schema.decodeUnknownEffect(FileChunkAnswer);
const decodeOffer = (machineLabel: string, answer: unknown) =>
  decodeOfferAnswer(answer).pipe(Effect.mapError(() => unreadable(machineLabel)));
const decodeChunk = (machineLabel: string, answer: unknown) =>
  decodeChunkAnswer(answer).pipe(Effect.mapError(() => unreadable(machineLabel)));

interface TransferPlan {
  readonly remote: RemoteWorkers.RemoteWorkersShape;
  readonly machine: OrchestratorMcpMachineRef;
  readonly baseDir: string;
  readonly stateDir: string;
  readonly roots: ReadonlyArray<string>;
  readonly transferId: string;
  readonly destinationPath: string | undefined;
  readonly job: Job;
}

const call = (
  plan: TransferPlan,
  tool: "studio_file_offer" | "studio_file_chunk",
  args: Record<string, unknown>,
  timeoutMs = OFFER_TIMEOUT_MS,
) =>
  plan.remote
    .proxy({
      machine: plan.machine,
      tool,
      arguments: args,
      timeoutMs,
    })
    .pipe(Effect.mapError(describeProxyFailure(plan.machine.label)));

/** A dropped connection repeats one chunk; chunks are addressed by index, so that is safe. */
const callChunk = (
  plan: TransferPlan,
  args: Record<string, unknown>,
  timeoutMs = CHUNK_TIMEOUT_MS,
) =>
  call(plan, "studio_file_chunk", args, timeoutMs).pipe(
    Effect.retry({
      times: 4,
      schedule: Schedule.spaced("2 seconds"),
      while: (error) => error.code === "machine_unreachable",
    }),
    Effect.flatMap((answer) => decodeChunk(plan.machine.label, answer)),
  );

const pull = Effect.fn("mcp.fileTransfer.pull")(function* (
  plan: TransferPlan,
  path: string,
  approvedPath: string | null,
) {
  const key = approvedPath !== null ? newReceivingKey() : null;
  const offer = yield* call(plan, "studio_file_offer", {
    direction: "get",
    path,
    ...(key === null ? {} : { recipientKey: key.publicKey }),
  }).pipe(Effect.flatMap((answer) => decodeOffer(plan.machine.label, answer)));
  if (offer.secret && offer.sealed === null)
    return {
      kind: "needs_approval" as const,
      sizeBytes: offer.sizeBytes ?? 0,
      path: offer.path ?? path,
    };
  // The name may lead elsewhere by now; what the owner approved is that one file.
  if (approvedPath !== null && offer.path !== approvedPath)
    return yield* invalid(
      "That approval does not cover this transfer: the path now leads to another file. Nothing was kept. Call again without approvalId to ask the owner.",
    );
  const size = offer.sizeBytes ?? 0;
  const final = yield* io(() =>
    landingPath({
      name: offer.name ?? "file",
      destinationPath: plan.destinationPath,
      roots: plan.roots,
      inbox: inboxFolder(plan.stateDir),
      id: plan.transferId,
    }),
  );
  if (yield* io(() => isCredentialLocation(final, plan.baseDir, plan.stateDir)))
    return yield* invalid(
      `${plan.destinationPath ?? final} is in a credential or app folder. Omit destinationPath to receive it in the transfer inbox.`,
    );
  yield* io(() => assertRoomFor(inboxFolder(plan.stateDir), size, "This machine"));
  yield* io(() => assertRoomFor(final, size, "This machine"));
  const incoming = yield* io(() =>
    IncomingFile.open({ final, size, secret: offer.secret, inbox: inboxFolder(plan.stateDir) }),
  );
  const received = Effect.gen(function* () {
    if (offer.secret) {
      if (key === null) return yield* invalid("A secret needs the owner's approval.");
      yield* io(() => incoming.write(0, unseal(offer.sealed!, key)));
      return yield* io(() => incoming.finish(null));
    }
    if (offer.offerId === null)
      return yield* invalid(`${plan.machine.label} did not open the transfer.`);
    for (let index = 0; index < chunkCount(size); index += 1) {
      const chunk = yield* callChunk(plan, { offerId: offer.offerId, index });
      if (chunk.data === null) return yield* invalid("The other machine sent no data.");
      const bytes = Buffer.from(chunk.data, "base64");
      yield* io(() => incoming.write(index, bytes));
      plan.job.bytes += bytes.byteLength;
    }
    return yield* io(() => incoming.finish(offer.sha256));
  });
  const saved = yield* received.pipe(
    Effect.tapError(() => Effect.promise(() => incoming.abandon()).pipe(Effect.ignore)),
  );
  return {
    kind: "done" as const,
    result: {
      status: "done",
      transferId: plan.transferId,
      path: saved,
      machine: "this machine",
      sizeBytes: size,
      secret: offer.secret,
      ...(offer.sha256 === null ? {} : { sha256: offer.sha256 }),
      message: offer.secret
        ? `Saved on this machine with owner-only access. Do not print or copy its contents.`
        : "Saved on this machine and verified.",
    } satisfies Result,
  };
});

const push = Effect.fn("mcp.fileTransfer.push")(function* (
  plan: TransferPlan,
  file: PinnedFile,
): Effect.fn.Return<Result, OrchestratorMcpFailure> {
  const sha256 = file.secret ? undefined : yield* io(() => sha256Pinned(file));
  const offer = yield* call(plan, "studio_file_offer", {
    direction: "send",
    name: safeFileName(file.real),
    sizeBytes: file.size,
    secret: file.secret,
    ...(sha256 === undefined ? {} : { sha256 }),
    ...(plan.destinationPath === undefined ? {} : { destinationPath: plan.destinationPath }),
  }).pipe(Effect.flatMap((answer) => decodeOffer(plan.machine.label, answer)));
  if (offer.offerId === null)
    return yield* invalid(`${plan.machine.label} did not open the transfer.`);
  const offerId = offer.offerId;
  const recipientKey = offer.recipientKey;
  let saved: string | null = null;
  const sending = Effect.gen(function* () {
    if (file.secret) {
      if (recipientKey === null)
        return yield* invalid(
          `${plan.machine.label} offered no key for the secret; nothing was sent.`,
        );
      const bytes = yield* io(() => readPinned(file, 0));
      const answer = yield* callChunk(plan, {
        offerId,
        index: 0,
        sealed: seal(bytes, recipientKey),
      });
      saved = answer.path;
    } else {
      const chunks = chunkCount(file.size);
      for (let index = 0; index < chunks; index += 1) {
        const bytes = yield* io(() => readPinned(file, index));
        const answer = yield* callChunk(
          plan,
          { offerId, index, data: bytes.toString("base64") },
          // The last chunk waits while that machine hashes the whole file.
          index + 1 === chunks ? OFFER_TIMEOUT_MS : CHUNK_TIMEOUT_MS,
        );
        plan.job.bytes += bytes.byteLength;
        saved = answer.path ?? saved;
      }
    }
  });
  // A failed send leaves nothing staged on that machine, best effort: its sweep catches the rest.
  yield* sending.pipe(
    Effect.tapError(() =>
      call(plan, "studio_file_chunk", { offerId, index: 0, abort: true }, CHUNK_TIMEOUT_MS).pipe(
        Effect.ignore,
      ),
    ),
  );
  if (saved === null)
    return yield* invalid(`${plan.machine.label} did not confirm the file was saved.`);
  return {
    status: "done",
    transferId: plan.transferId,
    path: saved,
    machine: plan.machine.label,
    sizeBytes: file.size,
    secret: file.secret,
    ...(sha256 === undefined ? {} : { sha256 }),
    message: file.secret
      ? `Saved on ${plan.machine.label} with owner-only access. Do not print or copy its contents.`
      : `Saved on ${plan.machine.label} and verified.`,
  } satisfies Result;
});

const answerWithin = (transferId: string, job: Job) =>
  Deferred.await(job.done).pipe(
    Effect.timeoutOption(`${ANSWER_WITHIN_MS} millis`),
    Effect.map(
      Option.getOrElse((): Result => ({
        status: "running",
        transferId,
        message: `${Math.floor(job.bytes / (1024 * 1024))} MB moved so far. Call again with transferId alone to read it.`,
      })),
    ),
  );

const askOwner = (
  requests: ProjectActionRequests.ProjectActionRequests["Service"],
  input: {
    readonly threadId: ThreadId;
    readonly projectId: ProjectId;
    readonly reason: string | undefined;
    readonly transfer: ProjectActionRequests.SecretTransfer;
  },
) =>
  Effect.gen(function* () {
    const { requestId } = yield* requests
      .request({
        threadId: input.threadId,
        projectId: input.projectId,
        action: "transfer_secret",
        reason: input.reason ?? "No reason given.",
        secretTransfer: input.transfer,
      })
      .pipe(Effect.mapError((error) => invalid(error.message)));
    return {
      status: "awaiting_user",
      approvalId: requestId,
      secret: true,
      sizeBytes: input.transfer.sizeBytes,
      message:
        "This file is a secret, so the owner decides. They see an approval card in this thread. End your turn now; if they approve, call again with the same arguments and approvalId.",
    } satisfies Result;
  });

export const layer = McpToolAccess.toLayer(FileTransferToolkit, {
  studio_file_transfer: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const context = yield* readCaller();
      yield* fleetPrincipalOf(context, "act");
      const thread = context.caller;
      if (thread === undefined)
        return yield* invalid("Only an agent in a SpecWithCode thread can move a file this way.");
      if (input.transferId !== undefined) {
        const running = jobs.get(input.transferId);
        if (running === undefined || running.threadId !== thread.id)
          return yield* invalid(
            "This machine has no such transfer. It may have restarted; start it again.",
          );
        return yield* answerWithin(input.transferId, running);
      }
      const work = yield* workGrantOf(context);
      if (work !== undefined)
        return yield* new OrchestratorMcpFailure({
          code: "capability_denied",
          message: `${work.coordinatorLabel} started this work, and work reaches other machines only through its coordinator. End your turn naming the file and where it is; the coordinator on ${work.coordinatorLabel} moves it here with studio_file_transfer. Do not use SSH or paste the file.`,
        });
      if (input.machine === undefined || input.direction === undefined || input.path === undefined)
        return yield* invalid("Pass machine, direction and path, or transferId alone.");
      const { machine: machineName, direction, path } = input;
      const remote = yield* RemoteWorkers.RemoteWorkers;
      const target = yield* remote.resolveMachine(machineName);
      if (target.kind !== "remote")
        return yield* invalid("That is this machine; nothing needs moving.");
      const machine = target.machine;
      const config = yield* ServerConfig.ServerConfig;
      const roots = yield* localRoots(thread);
      // Writing into a project can change what agents there run, so the caller's own limits apply.
      if (input.destinationPath !== undefined)
        yield* assertFullAccess(
          context,
          "Only a full-access thread can choose where a transferred file lands. Omit destinationPath to receive it in the transfer inbox.",
        );
      // The card and the approval name the file itself: a link could lead anywhere, or change later.
      const sending = direction === "send" ? yield* io(() => resolveFile(path)) : null;
      let approved = false;
      let approvedPath: string | null = null;
      if (input.approvalId !== undefined) {
        const requests = yield* ProjectActionRequests.ProjectActionRequests;
        // Spent here, before anything moves: one approval moves one file, even if this fails.
        const covered = yield* requests.useSecretTransfer({
          requestId: input.approvalId,
          threadId: thread.id,
        });
        if (
          covered === undefined ||
          covered.machineId !== machine.id ||
          covered.direction !== direction ||
          (sending !== null && covered.path !== sending.real) ||
          covered.destinationPath !== input.destinationPath
        )
          return yield* invalid(
            "That approval does not cover this transfer, or it was already used. Call again without approvalId to ask the owner.",
          );
        approved = true;
        approvedPath = covered.path;
      }
      const transferId = NodeCrypto.randomUUID();
      const done = yield* Deferred.make<Result, OrchestratorMcpFailure>();
      const job: Job = { threadId: thread.id, done, bytes: 0 };
      const plan: TransferPlan = {
        remote,
        machine,
        baseDir: config.baseDir,
        stateDir: config.stateDir,
        roots,
        transferId,
        destinationPath: input.destinationPath,
        job,
      };
      const requests = yield* ProjectActionRequests.ProjectActionRequests;
      const ownerCard = (
        cardPath: string,
        sizeBytes: number,
      ): Effect.Effect<Result, OrchestratorMcpFailure> =>
        askOwner(requests, {
          threadId: thread.id,
          projectId: thread.projectId,
          reason: input.reason,
          transfer: {
            machineId: machine.id,
            machineLabel: machine.label,
            direction,
            path: cardPath,
            sizeBytes,
            ...(input.destinationPath === undefined
              ? {}
              : { destinationPath: input.destinationPath }),
          },
        });
      let moving: Effect.Effect<Result, OrchestratorMcpFailure>;
      if (sending !== null) {
        const { real } = sending;
        yield* refuseProtected(real, path);
        const file = yield* io(() => pinResolved(real));
        const secret = file.secret;
        if (secret && file.size > MAX_SECRET_FILE_BYTES)
          return yield* invalid(`${path} looks like a secret, and secrets are limited to 1 MB.`);
        if (secret && !approved) return yield* ownerCard(real, file.size);
        if (!secret && !roots.some((root) => isWithin(root, real)))
          return yield* invalid(
            `${path} is outside this thread's project and approved folders. Copy it into one, or ask the user to add the folder.`,
          );
        moving = push(plan, file);
      } else {
        // Only the machine holding the file can say whether it is a secret.
        moving = pull(plan, path, approvedPath).pipe(
          Effect.flatMap((pulled): Effect.Effect<Result, OrchestratorMcpFailure> =>
            pulled.kind === "done"
              ? Effect.succeed(pulled.result)
              : ownerCard(pulled.path, pulled.sizeBytes),
          ),
        );
      }
      if (jobs.size >= MAX_REMEMBERED_JOBS) jobs.delete(jobs.keys().next().value!);
      jobs.set(transferId, job);
      yield* moving.pipe(
        Effect.exit,
        Effect.flatMap((exit) => Deferred.done(done, exit)),
        Effect.forkDetach,
      );
      return yield* answerWithin(transferId, job);
    }),
  ),
  studio_file_offer: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const { offers, caller } = yield* offerCaller;
      if (input.direction === "get") {
        if (input.path === undefined) return yield* invalid("Pass path.");
        const path = input.path;
        const answer = yield* io(() =>
          offers.offerGet(caller, { path, recipientKey: input.recipientKey }),
        );
        return { ...answer, recipientKey: null };
      }
      if (input.name === undefined || input.sizeBytes === undefined)
        return yield* invalid("Pass name and sizeBytes.");
      const { name, sizeBytes } = input;
      const answer = yield* io(() =>
        offers.offerSend(caller, {
          name,
          sizeBytes,
          sha256: input.sha256,
          secret: input.secret ?? false,
          destinationPath: input.destinationPath,
        }),
      );
      return {
        offerId: answer.offerId,
        path: answer.path,
        name,
        sizeBytes,
        sha256: input.sha256 ?? null,
        secret: input.secret ?? false,
        sealed: null,
        recipientKey: answer.recipientKey,
      };
    }),
  ),
  studio_file_chunk: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const { offers, caller } = yield* offerCaller;
      if (input.abort === true) {
        yield* io(() => offers.abort(caller, input.offerId));
        return { data: null, last: true, path: null };
      }
      if (input.data === undefined && input.sealed === undefined) {
        const answer = yield* io(() => offers.read(caller, input.offerId, input.index));
        return { data: answer.data, last: answer.last, path: null };
      }
      const answer = yield* io(() => offers.write(caller, input));
      return { data: null, last: answer.path !== null, path: answer.path };
    }),
  ),
});
