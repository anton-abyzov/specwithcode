/**
 * "Request access" for Away mode (AC-03): every missing grant in a plan goes
 * to the target machine as one pending request, and the target's owner
 * approves or declines it there.
 *
 * Both halves live here:
 * - Sending (this machine): one call to the target's away route over the
 *   fleet channel, with the management token this machine holds there (or
 *   its worker credential when it holds no management token). The same call
 *   asks how a sent request stands, and what the target's grant for this
 *   machine allows (`targetGrant`, read by the planner).
 * - Receiving (the target): a small JSON store of requests. Nothing is
 *   applied when a request arrives. Approving, by this machine's owner only,
 *   applies exactly the request's stored grant changes through
 *   `WorkGrants.update`, the code behind Settings > Machines > Who can run
 *   work here. Steps a grant cannot cover (a sign-in, a file, a link) stay
 *   listed for the owner to do by hand.
 */
import {
  AWAY_ACCESS_MAX_MISSING,
  type AwayAccessGrantChanges,
  AwayAccessRequestRecord,
  AwayAccessRequestResult,
  AwayError,
  AwayMissingGrant,
  type EnvironmentId,
  type Project,
  type ProjectId,
} from "@specweave-studio/contracts";
import {
  StudioWorkGrantProjects,
  type StudioWorkGrantUpdateInput,
} from "@specweave-studio/contracts/studioFleet";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../config.ts";
import * as FleetTargets from "../fleet/FleetTargets.ts";
import { fleetRequest } from "../fleet/fleetTransport.ts";
import * as FleetWorkerGrants from "../fleet/FleetWorkerGrants.ts";
import * as WorkGrants from "../fleet/WorkGrants.ts";
import { parseJson, stringifyJson } from "../json.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { readBoundedJson } from "../studioFleet.ts";

/** The target's route for Away access requests (machine to machine). */
export const AWAY_PEER_PATH = "/api/away/v1/access";
const FILE_NAME = "away-access-requests.json";
/** Requests kept per machine file; the oldest decided ones go first. */
const MAX_RECORDS = 50;
const PEER_TIMEOUT_MS = 20_000;
const PEER_MAX_BYTES = 256 * 1024;

/** What the target's grant for this machine allows, as the target answered. */
export const AwayTargetGrant = Schema.Struct({
  routines: Schema.Boolean,
  projects: StudioWorkGrantProjects,
  revoked: Schema.Boolean,
});
export type AwayTargetGrant = typeof AwayTargetGrant.Type;

/** One call to the target's away route. */
export const AwayPeerRequest = Schema.Union([
  Schema.Struct({ action: Schema.Literal("grant") }),
  Schema.Struct({
    action: Schema.Literal("request"),
    fromLabel: Schema.String.check(Schema.isMaxLength(120)),
    missing: Schema.Array(AwayMissingGrant).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(AWAY_ACCESS_MAX_MISSING),
    ),
  }),
  Schema.Struct({
    action: Schema.Literal("status"),
    requestId: Schema.String.check(Schema.isMaxLength(128)),
  }),
]);
export type AwayPeerRequest = typeof AwayPeerRequest.Type;

export const AwayPeerGrantResponse = Schema.Struct({ grant: Schema.NullOr(AwayTargetGrant) });

const StoreFile = Schema.Struct({
  version: Schema.Literal(1),
  requests: Schema.Array(AwayAccessRequestRecord),
});
type StoreFile = typeof StoreFile.Type;
const EMPTY: StoreFile = { version: 1, requests: [] };
const decodeStore = Schema.decodeUnknownOption(StoreFile);
const encodeStore = Schema.encodeSync(StoreFile);
const encodePeerRequest = Schema.encodeSync(AwayPeerRequest);
const decodeResult = Schema.decodeUnknownOption(AwayAccessRequestResult);
const decodeGrantResponse = Schema.decodeUnknownOption(AwayPeerGrantResponse);

// ---------------------------------------------------------------------------
// Rules, apart from storage and transport.
// ---------------------------------------------------------------------------

export type AccessRequestCheck =
  | { readonly ok: true; readonly missing: ReadonlyArray<AwayMissingGrant> }
  | { readonly ok: false; readonly message: string };

const missingKey = (item: AwayMissingGrant) =>
  JSON.stringify([item.kind, item.machineEnvironmentId, item.projectId ?? null, item.detail]);

/**
 * What a received request may carry: items for this machine or for the
 * sender's own machine (steps it takes itself), each once. A request with
 * nothing for this machine is refused: there is nothing to approve here.
 */
export function validateAccessRequest(input: {
  readonly self: EnvironmentId;
  readonly from: EnvironmentId;
  readonly missing: ReadonlyArray<AwayMissingGrant>;
}): AccessRequestCheck {
  if (input.from === input.self) {
    return { ok: false, message: "A machine cannot ask itself for access." };
  }
  const seen = new Set<string>();
  const missing: Array<AwayMissingGrant> = [];
  for (const item of input.missing) {
    if (item.machineEnvironmentId !== input.self && item.machineEnvironmentId !== input.from) {
      return { ok: false, message: "The request names a machine other than these two." };
    }
    const key = missingKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    missing.push(item);
  }
  if (!missing.some((item) => item.machineEnvironmentId === input.self)) {
    return { ok: false, message: "The request has nothing to change on this machine." };
  }
  return { ok: true, missing };
}

/** The sender's project ids map to this machine's linked copies of them. */
export function localProjectFor(
  projects: ReadonlyArray<Pick<Project, "id" | "deletedAt" | "workspaceSettings">>,
  from: EnvironmentId,
  senderProjectId: ProjectId,
): ProjectId | null {
  for (const project of projects) {
    if (project.deletedAt !== null) continue;
    const members = project.workspaceSettings?.logicalProject?.members ?? [];
    if (members.some((m) => m.environmentId === from && m.projectId === senderProjectId))
      return project.id;
  }
  return null;
}

/**
 * The grant changes a request asks of this machine: routines on, and the
 * projects a `work-grant` item names added to the grant. Sign-ins, files,
 * links and standby are steps for the owner, never applied here.
 */
export function grantChangesFor(input: {
  readonly self: EnvironmentId;
  readonly missing: ReadonlyArray<AwayMissingGrant>;
  readonly localProject: (senderProjectId: ProjectId) => ProjectId | null;
}): AwayAccessGrantChanges {
  const mine = input.missing.filter((item) => item.machineEnvironmentId === input.self);
  const routines = mine.some((item) => item.kind === "routines");
  const projectIds = new Set<ProjectId>();
  for (const item of mine) {
    if (item.kind !== "work-grant" || item.projectId === undefined) continue;
    const local = input.localProject(item.projectId);
    if (local !== null) projectIds.add(local);
  }
  return {
    ...(routines ? { routines: true } : {}),
    ...(projectIds.size === 0 ? {} : { addProjectIds: [...projectIds].toSorted() }),
  };
}

/**
 * The update approving applies to the sender's grant here, or null when
 * the grant already allows all of it. Projects are added only to a listed
 * grant: `all` covers them, and `linked` covers every linked copy.
 */
export function grantUpdateFor(
  coordinatorEnvironmentId: EnvironmentId,
  current: { readonly routines: boolean; readonly projects: StudioWorkGrantProjects },
  changes: AwayAccessGrantChanges,
): StudioWorkGrantUpdateInput | null {
  const routines = changes.routines === true && !current.routines ? { routines: true } : {};
  const add = changes.addProjectIds ?? [];
  const listed = current.projects.kind === "listed" ? current.projects.projectIds : null;
  const projects =
    listed !== null && add.some((id) => !listed.includes(id))
      ? {
          projects: {
            kind: "listed" as const,
            projectIds: [...new Set([...listed, ...add])].slice(0, 256),
          },
        }
      : {};
  return Object.keys(routines).length === 0 && Object.keys(projects).length === 0
    ? null
    : { coordinatorEnvironmentId, ...routines, ...projects };
}

/** How a stored request answers its sender. */
export function resultOf(record: AwayAccessRequestRecord): AwayAccessRequestResult {
  switch (record.status) {
    case "approved":
      return {
        requestId: record.requestId,
        status: "approved",
        detail: record.detail ?? "Approved. Check again to see what is left.",
      };
    case "declined":
      return { requestId: record.requestId, status: "declined", detail: "The owner declined it." };
    case "pending":
      return {
        requestId: record.requestId,
        status: "sent",
        detail: "Waiting for approval in Settings > Machines on that machine.",
      };
  }
}

const sameMissing = (
  left: ReadonlyArray<AwayMissingGrant>,
  right: ReadonlyArray<AwayMissingGrant>,
) =>
  JSON.stringify(left.map(missingKey).toSorted()) ===
  JSON.stringify(right.map(missingKey).toSorted());

/**
 * Adds a received request: the same pending request again answers
 * `already-pending`; a different one replaces the sender's pending one.
 * Keeps at most MAX_RECORDS, dropping the oldest decided first.
 */
export function addRequest(
  requests: ReadonlyArray<AwayAccessRequestRecord>,
  incoming: AwayAccessRequestRecord,
): {
  readonly requests: ReadonlyArray<AwayAccessRequestRecord>;
  readonly result: AwayAccessRequestResult;
} {
  const pending = requests.find(
    (record) =>
      record.status === "pending" && record.fromEnvironmentId === incoming.fromEnvironmentId,
  );
  if (pending !== undefined && sameMissing(pending.missing, incoming.missing)) {
    return {
      requests,
      result: {
        requestId: pending.requestId,
        status: "already-pending",
        detail: "Already waiting for approval in Settings > Machines on that machine.",
      },
    };
  }
  const kept = requests.filter((record) => record !== pending);
  let next = [...kept, incoming];
  while (next.length > MAX_RECORDS) {
    const oldestDecided = next.findIndex((record) => record.status !== "pending");
    next = next.filter((_, index) => index !== (oldestDecided === -1 ? 0 : oldestDecided));
  }
  return {
    requests: next,
    result: {
      requestId: incoming.requestId,
      status: "sent",
      detail: "Sent. Approve it in Settings > Machines on that machine.",
    },
  };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface AwayAccessShape {
  /** This machine to the target: sends every missing item as one request. */
  readonly send: (input: {
    readonly targetEnvironmentId: EnvironmentId;
    readonly fromLabel: string;
    readonly missing: ReadonlyArray<AwayMissingGrant>;
  }) => Effect.Effect<AwayAccessRequestResult, AwayError>;
  /** This machine to the target: how a request it sent stands. */
  readonly status: (input: {
    readonly targetEnvironmentId: EnvironmentId;
    readonly requestId: string;
  }) => Effect.Effect<AwayAccessRequestResult, AwayError>;
  /** What the target's grant for this machine allows; null when it cannot say. Never fails. */
  readonly targetGrant: (
    targetEnvironmentId: EnvironmentId,
  ) => Effect.Effect<AwayTargetGrant | null>;
  /** On the target: what its grant for `from` allows. */
  readonly grantFor: (from: EnvironmentId) => Effect.Effect<AwayTargetGrant | null, AwayError>;
  /** On the target: stores a request from `from`. Applies nothing. */
  readonly receive: (input: {
    readonly self: EnvironmentId;
    readonly from: EnvironmentId;
    readonly fromLabel: string;
    readonly missing: ReadonlyArray<AwayMissingGrant>;
  }) => Effect.Effect<AwayAccessRequestResult, AwayError>;
  /** On the target: a stored request's state for its sender. */
  readonly statusFor: (input: {
    readonly from: EnvironmentId;
    readonly requestId: string;
  }) => Effect.Effect<AwayAccessRequestResult, AwayError>;
  /** On the target: every stored request, newest first. */
  readonly list: Effect.Effect<ReadonlyArray<AwayAccessRequestRecord>, AwayError>;
  /** On the target, by its owner only (the caller checks): approve or decline. */
  readonly decide: (input: {
    readonly requestId: string;
    readonly decision: "approve" | "decline";
  }) => Effect.Effect<AwayAccessRequestRecord, AwayError>;
}

export class AwayAccess extends Context.Service<AwayAccess, AwayAccessShape>()(
  "specweave-studio/away/AwayAccessRequest/AwayAccess",
) {}

const failed = (message: string) => new AwayError({ code: "failed", message });

export const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const config = yield* ServerConfig.ServerConfig;
  const fleet = yield* FleetTargets.FleetTargets;
  const link = FleetTargets.linkOf(fleet);
  const workerGrants = yield* FleetWorkerGrants.FleetWorkerGrants;
  const grants = yield* WorkGrants.WorkGrants;
  const projects = yield* ProjectService.ProjectService;
  const lock = yield* Semaphore.make(1);
  const file = path.join(config.stateDir, FILE_NAME);

  const read = Effect.gen(function* () {
    if (!(yield* fs.exists(file))) return EMPTY;
    const text = yield* fs.readFileString(file);
    let raw: unknown = null;
    try {
      raw = parseJson(text);
    } catch {
      raw = null;
    }
    return Option.getOrElse(decodeStore(raw), () => EMPTY);
  }).pipe(Effect.mapError(() => failed("Could not read the access requests on this machine.")));

  const write = (next: StoreFile) =>
    Effect.gen(function* () {
      yield* fs.makeDirectory(config.stateDir, { recursive: true, mode: 0o700 });
      const temporary = `${file}.${yield* crypto.randomUUIDv4}.tmp`;
      yield* fs.writeFileString(temporary, stringifyJson(encodeStore(next)), { mode: 0o600 });
      yield* fs.rename(temporary, file);
    }).pipe(Effect.mapError(() => failed("Could not save the access requests on this machine.")));

  const modify = <A>(change: (current: StoreFile) => readonly [A, StoreFile | undefined]) =>
    lock.withPermit(
      Effect.gen(function* () {
        const [result, next] = change(yield* read);
        if (next !== undefined) yield* write(next);
        return result;
      }),
    );

  const nowIso = Clock.currentTimeMillis.pipe(
    Effect.map((now) => DateTime.formatIso(DateTime.makeUnsafe(now))),
  );

  // --- sending side -------------------------------------------------------

  const call = <A>(
    targetEnvironmentId: EnvironmentId,
    body: AwayPeerRequest,
    decode: (raw: unknown) => Option.Option<A>,
  ): Effect.Effect<A, AwayError> =>
    Effect.gen(function* () {
      const machines = yield* fleet.load.pipe(
        Effect.map((loaded) => loaded?.machines ?? []),
        Effect.mapError(() => failed("Could not read this machine's list of machines.")),
      );
      const target = machines.find((machine) => machine.environmentId === targetEnvironmentId);
      if (target === undefined) {
        return yield* new AwayError({
          code: "unknown_machine",
          message: "That machine is not one of your machines.",
        });
      }
      const token =
        target.managementToken ??
        (yield* workerGrants.credential(target.id).pipe(
          Effect.map((credential) => credential.accessToken),
          Effect.mapError(
            () =>
              new AwayError({
                code: "not_allowed",
                message: `This machine holds no key for ${target.label}. On ${target.label}, choose Join a main machine in Settings > Machines and add the line here first.`,
              }),
          ),
        ));
      const answer = yield* Effect.tryPromise({
        try: async () => {
          const { response } = await fleetRequest(link, target, AWAY_PEER_PATH, {
            method: "POST",
            token,
            headers: { "content-type": "application/json" },
            body: stringifyJson(encodePeerRequest(body)),
            timeoutMs: PEER_TIMEOUT_MS,
          });
          const json = await readBoundedJson(response, PEER_MAX_BYTES).catch(() => null);
          return { status: response.status, ok: response.ok, json };
        },
        catch: () =>
          new AwayError({ code: "unreachable", message: `${target.label} did not answer.` }),
      });
      if (answer.status === 404) {
        return yield* new AwayError({
          code: "failed",
          message: `${target.label} runs an older SpecWithCode. Update it, then try again.`,
        });
      }
      if (!answer.ok) {
        const said =
          typeof answer.json === "object" &&
          answer.json !== null &&
          "error" in answer.json &&
          typeof answer.json.error === "string"
            ? answer.json.error
            : `HTTP ${answer.status}`;
        return yield* new AwayError({
          code:
            answer.status === 401 || answer.status === 403
              ? "not_allowed"
              : answer.status === 410
                ? "not_found"
                : "failed",
          message: `${target.label} refused: ${said}`,
        });
      }
      const decoded = decode(answer.json);
      if (Option.isNone(decoded)) {
        return yield* failed(`${target.label} sent an answer this version cannot read.`);
      }
      return decoded.value;
    });

  const send: AwayAccessShape["send"] = (input) =>
    call(
      input.targetEnvironmentId,
      { action: "request", fromLabel: input.fromLabel.slice(0, 120), missing: input.missing },
      decodeResult,
    );

  const status: AwayAccessShape["status"] = (input) =>
    call(input.targetEnvironmentId, { action: "status", requestId: input.requestId }, decodeResult);

  const targetGrant: AwayAccessShape["targetGrant"] = (targetEnvironmentId) =>
    call(targetEnvironmentId, { action: "grant" }, decodeGrantResponse).pipe(
      Effect.map((answer) => answer.grant),
      Effect.orElseSucceed(() => null),
    );

  // --- receiving side -----------------------------------------------------

  const grantFor: AwayAccessShape["grantFor"] = (from) =>
    Effect.gen(function* () {
      // Read only: forCoordinator would write a fresh policy for an unknown machine.
      const policies = yield* grants.policies.pipe(
        Effect.mapError(() => failed("Could not read who may run work on this machine.")),
      );
      const policy = policies.find((entry) => entry.coordinatorEnvironmentId === from);
      if (policy === undefined) return null;
      return {
        routines: policy.legacy || policy.routines === true,
        projects: policy.legacy ? { kind: "all" as const } : policy.projects,
        revoked: policy.revokedAt !== null,
      };
    });

  const receive: AwayAccessShape["receive"] = (input) =>
    Effect.gen(function* () {
      const checked = validateAccessRequest(input);
      if (!checked.ok) return yield* new AwayError({ code: "invalid", message: checked.message });
      const snapshot = yield* projects.snapshot.pipe(
        Effect.mapError(() => failed("Could not read this machine's projects.")),
      );
      const changes = grantChangesFor({
        self: input.self,
        missing: checked.missing,
        localProject: (id) => localProjectFor(snapshot.projects, input.from, id),
      });
      const record: AwayAccessRequestRecord = {
        requestId: yield* crypto.randomUUIDv4.pipe(
          Effect.mapError(() => failed("Could not make a request id.")),
        ),
        fromEnvironmentId: input.from,
        fromLabel: input.fromLabel.slice(0, 120),
        missing: checked.missing,
        changes,
        status: "pending",
        createdAt: yield* nowIso,
        decidedAt: null,
        detail: null,
      };
      const result = yield* modify((current) => {
        const added = addRequest(current.requests, record);
        return [
          added.result,
          added.requests === current.requests
            ? undefined
            : { ...current, requests: added.requests },
        ] as const;
      });
      if (result.status === "sent") {
        yield* Effect.logInfo("Away access request received", {
          from: input.from,
          requestId: result.requestId,
          items: checked.missing.length,
        });
      }
      return result;
    });

  const statusFor: AwayAccessShape["statusFor"] = (input) =>
    read.pipe(
      Effect.flatMap((current) => {
        const record = current.requests.find(
          (entry) => entry.requestId === input.requestId && entry.fromEnvironmentId === input.from,
        );
        return record === undefined
          ? Effect.fail(new AwayError({ code: "not_found", message: "No such request here." }))
          : Effect.succeed(resultOf(record));
      }),
    );

  const list: AwayAccessShape["list"] = read.pipe(
    Effect.map((current) => current.requests.toReversed()),
  );

  const decide: AwayAccessShape["decide"] = (input) =>
    lock.withPermit(
      Effect.gen(function* () {
        const current = yield* read;
        const record = current.requests.find((entry) => entry.requestId === input.requestId);
        if (record === undefined) {
          return yield* new AwayError({ code: "not_found", message: "No such request here." });
        }
        if (record.status !== "pending") return record;
        let detail: string | null = null;
        if (input.decision === "approve") {
          const grant = yield* grantFor(record.fromEnvironmentId);
          const update =
            grant === null ? null : grantUpdateFor(record.fromEnvironmentId, grant, record.changes);
          if (grant === null && (record.changes.routines || record.changes.addProjectIds)) {
            detail = `${record.fromLabel} may not run work here yet, so nothing changed. Allow it first.`;
          } else if (update !== null) {
            yield* grants.update(update).pipe(Effect.mapError((error) => failed(error.message)));
          }
          const manual = record.missing.filter(
            (item) => item.kind !== "routines" && item.kind !== "work-grant",
          ).length;
          if (detail === null && manual > 0) {
            detail = `Approved. ${manual === 1 ? "1 step still needs" : `${manual} steps still need`} doing by hand.`;
          }
        }
        const decided: AwayAccessRequestRecord = {
          ...record,
          status: input.decision === "approve" ? "approved" : "declined",
          decidedAt: yield* nowIso,
          detail,
        };
        yield* write({
          ...current,
          requests: current.requests.map((entry) => (entry === record ? decided : entry)),
        });
        yield* Effect.logInfo("Away access request decided", {
          requestId: record.requestId,
          from: record.fromEnvironmentId,
          decision: input.decision,
        });
        return decided;
      }),
    );

  return AwayAccess.of({
    send,
    status,
    targetGrant,
    grantFor,
    receive,
    statusFor,
    list,
    decide,
  });
});

/** Needs FleetTargets, FleetWorkerGrants, WorkGrants, ProjectService and the server config. */
export const layer = Layer.effect(AwayAccess, make);
