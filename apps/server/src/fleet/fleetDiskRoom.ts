/**
 * Disk room over SpecWithCode Connect (increment 1240).
 *
 * Before a release, the fleet primary asks each machine how much disk its
 * update to a version needs, with the management token it already holds
 * there. The machine runs its own release's `disk_room.py` (shipped beside
 * `bin.mjs` in `studio-updater/`) with the version and the target release's
 * FULL_READ migration numbers, and answers with the report it prints.
 *
 * The call is read-only and narrow: nothing in the request names a path,
 * command or URL, and the script is the one this release shipped, found
 * through the same ownership and mode checks as the managed update helper.
 */
import { StudioFleetUpdateError } from "@specweave-studio/contracts";
import type { StudioFleetDiskRoomReport } from "@specweave-studio/contracts/studioFleet";
import { HostProcessPlatform } from "@specweave-studio/shared/hostProcess";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as NodeOS from "node:os";

import { DISK_ROOM_FILES } from "../../../../scripts/lib/studio-disk-room.ts";
import { MAC_SERVICE_UPDATER_FILES } from "../../../../scripts/lib/studio-service-updater.ts";
import * as ServerConfig from "../config.ts";
import { trustedHelperFiles } from "../managedUpdates/ManagedUpdatesService.ts";
import * as ProcessRunner from "../processRunner.ts";
import { checkIdentity, type FleetTarget, readBoundedJson } from "../studioFleet.ts";
import { type FleetLink, fleetRequest, reachFleetMachine } from "./fleetTransport.ts";
import * as FleetUpdate from "./fleetUpdate.ts";
import {
  agentIdentityOf,
  fleetFailureOf,
  FleetUpdateFailure,
  refusalOf,
  transportOf,
} from "./fleetUpdate.ts";

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// ---------------------------------------------------------------------------
// This machine: the worker side
// ---------------------------------------------------------------------------

/** What the primary asks: a release version and its FULL_READ numbers (`none` or `69,73`). */
export interface FleetDiskRoomAsk {
  readonly version: string;
  readonly fullRead: string;
}

export class FleetDiskRoom extends Context.Service<
  FleetDiskRoom,
  {
    readonly report: (
      ask: FleetDiskRoomAsk,
    ) => Effect.Effect<StudioFleetDiskRoomReport, StudioFleetUpdateError>;
  }
>()("specweave-studio/fleet/fleetDiskRoom") {}

export interface FleetDiskRoomDeps {
  /** The identity disk_room.py checks, as the update agent names this machine. */
  readonly identity: string | null;
  /** This release's disk_room.py, or null when it has none. */
  readonly script: Effect.Effect<string | null>;
  readonly run: ProcessRunner.ProcessRunner["Service"]["run"];
}

/** Under the primary's 90 s wait and Connect's cut-off at about 100 s; a cold database walk takes about 20 s. */
export const DISK_ROOM_TIMEOUT = Duration.seconds(70);
const decodeLastLine = Schema.decodeOption(Schema.fromJsonString(Schema.Unknown));

/** The identities disk_room.py takes (its IDENTITY); another one could never get a report. */
const DISK_ROOM_IDENTITY = /^[a-z][a-z0-9_-]{0,31}$/;

/** Why the check could not run, for the primary: never mistaken for a timeout. */
const runFailure = (error: ProcessRunner.ProcessRunError): string => {
  switch (error._tag) {
    case "ProcessTimeoutError":
      return "The disk room check did not answer in time.";
    case "ProcessOutputLimitError":
      return "The disk room check printed more output than it may.";
    case "ProcessSpawnError":
      return "The disk room check could not start /usr/bin/python3 here.";
    default:
      return "The disk room check could not be run here.";
  }
};

export const makeFleetDiskRoom = (deps: FleetDiskRoomDeps): FleetDiskRoom["Service"] => {
  const refuse = (reason: "unsupported" | "failed", message: string) =>
    new StudioFleetUpdateError({ reason, message });
  const report = (ask: FleetDiskRoomAsk) =>
    Effect.gen(function* () {
      const script = yield* deps.script;
      if (script === null || deps.identity === null || !DISK_ROOM_IDENTITY.test(deps.identity))
        return yield* refuse(
          "unsupported",
          "This machine's release has no disk room check it can run for its fleet primary.",
        );
      const output = yield* deps
        .run({
          command: "/usr/bin/python3",
          args: [
            "-B",
            "-E",
            "-s",
            script,
            "--identity",
            deps.identity,
            "--version",
            ask.version,
            "--full-read",
            ask.fullRead,
            "--json",
          ],
          timeout: DISK_ROOM_TIMEOUT,
          maxOutputBytes: 64 * 1024,
          outputMode: "error",
        })
        .pipe(Effect.result);
      if (Result.isFailure(output)) return yield* refuse("failed", runFailure(output.failure));
      if (output.success.timedOut)
        return yield* refuse("failed", "The disk room check did not answer in time.");
      // disk_room.py prints its report whatever it exits with: 0 room, 1 short, 2 cannot tell.
      const last = output.success.stdout.trim().split("\n").at(-1) ?? "";
      const parsed = decodeLastLine(last);
      if (Option.isNone(parsed) || !record(parsed.value))
        return yield* refuse("failed", "The disk room check gave no report.");
      const found = parsed.value;
      if (typeof found.error === "string" && found.error.length > 0)
        return yield* refuse("failed", found.error);
      if (typeof found.ok !== "boolean")
        return yield* refuse("failed", "The disk room check gave no answer.");
      return { workerIdentity: deps.identity, ...found };
    });
  return FleetDiskRoom.of({ report });
};

/**
 * This release's own disk_room.py, beside the entry point in `studio-updater/`,
 * when it and every helper it ships with pass the managed helper checks. Only
 * a non-root macOS or Linux service; never the installed agent's copy.
 */
export const resolveDiskRoomHelper = (input: { uid: number; entry: string; platform: string }) =>
  Effect.gen(function* () {
    if ((input.platform !== "darwin" && input.platform !== "linux") || input.uid <= 0) return null;
    const path = yield* Path.Path;
    if (!path.isAbsolute(input.entry)) return null;
    const candidate = path.join(path.dirname(input.entry), "studio-updater", "disk_room.py");
    const valid = yield* trustedHelperFiles({
      candidate,
      names: [...DISK_ROOM_FILES, ...MAC_SERVICE_UPDATER_FILES],
      uid: input.uid,
    });
    return valid ? candidate : null;
  });

const installedDiskRoomHelper = (platform: string) =>
  Effect.gen(function* () {
    const owner = yield* Effect.try({
      try: () => NodeOS.userInfo(),
      catch: () => null,
    }).pipe(Effect.option);
    if (Option.isNone(owner)) return null;
    return yield* resolveDiskRoomHelper({
      uid: owner.value.uid,
      entry: process.argv[1] ?? "",
      platform,
    });
  });

/** The live worker: this release's disk_room.py, run as this machine's identity. */
export const layer = Layer.effect(
  FleetDiskRoom,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const runner = yield* ProcessRunner.ProcessRunner;
    const path = yield* Path.Path;
    const platform = yield* HostProcessPlatform;
    const helperContext = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
    return makeFleetDiskRoom({
      identity: agentIdentityOf(path, config.stateDir),
      // Resolved on each call: an update can replace the release's files while this runs.
      script: installedDiskRoomHelper(platform).pipe(
        Effect.provide(helperContext),
        Effect.orElseSucceed(() => null),
      ),
      run: runner.run,
    });
  }),
);

// ---------------------------------------------------------------------------
// The fleet primary: the client side
// ---------------------------------------------------------------------------

export interface FleetDiskRoomClientInput {
  readonly link: FleetLink;
  readonly target: FleetTarget;
  readonly coordinatorEnvironmentId: string;
  readonly version: string;
  /** The target release's FULL_READ numbers, `none` or `69,73`. */
  readonly fullRead: string;
}

/** A failure whose message names the machine it was about. */
const naming = (target: FleetTarget, failure: FleetUpdateFailure) =>
  failure.message.includes(target.label)
    ? failure
    : new FleetUpdateFailure(failure.reason, `${target.label}: ${failure.message}`);

/**
 * Asks `target` for its disk room report for `version`, over its first
 * address that answers as that machine and accepts the token. A short disk is
 * a report (`ok: false`), not a failure.
 */
export async function runFleetDiskRoom(
  input: FleetDiskRoomClientInput,
): Promise<Record<string, unknown>> {
  const { link, target, coordinatorEnvironmentId } = input;
  const token = target.managementToken;
  if (token === undefined)
    throw new FleetUpdateFailure(
      "unauthorized",
      `No management token is saved for ${target.label}. On that machine choose Join a main machine and add the line here.`,
    );
  let descriptor;
  try {
    const reached = await reachFleetMachine(link, target, { token });
    descriptor = await checkIdentity(
      link.fetch,
      { url: reached.origin, environmentId: target.environmentId },
      link.connectOnly,
    );
  } catch (error) {
    throw naming(target, fleetFailureOf(error, link));
  }
  const capabilities = descriptor.capabilities as Record<string, unknown>;
  if (capabilities.fleetDiskRoom !== true)
    throw new FleetUpdateFailure(
      "unsupported",
      `${target.label} runs ${descriptor.serverVersion}, whose release predates the Connect disk check.`,
    );
  const query = new URLSearchParams({
    coordinatorEnvironmentId,
    version: input.version,
    fullRead: input.fullRead,
  });
  let response: Response;
  let address;
  try {
    ({ response, address } = await fleetRequest(
      link,
      target,
      `/api/studio/fleet/disk-room?${query.toString()}`,
      // Not idempotent here: a slow walk must not be asked again over the next address.
      { method: "GET", token, idempotent: false, timeoutMs: 90_000 },
    ));
  } catch (error) {
    throw naming(target, fleetFailureOf(error, link));
  }
  if (!response.ok) throw naming(target, await refusalOf(response));
  const body = await readBoundedJson(response).catch(() => null);
  if (!record(body) || typeof body.ok !== "boolean")
    throw new FleetUpdateFailure("failed", `${target.label} gave no disk room report.`);
  return {
    ...body,
    identity: target.id,
    transport: transportOf(address),
    serverVersion: descriptor.serverVersion,
  };
}

/**
 * The fleet worker calls this machine serves its primary: update requests
 * (fleetUpdate.ts) and the disk room report, both on one process runner.
 */
export const workerLayer = Layer.merge(FleetUpdate.layer, layer);
