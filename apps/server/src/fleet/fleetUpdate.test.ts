import {
  AuthEnvironmentMaintainScope,
  AuthFleetUpdateScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  type AuthEnvironmentScope,
  EnvironmentId,
  type ServerPrepareServiceUpdateInput,
  type ServerPrepareServiceUpdateResult,
} from "@specweave-studio/contracts";
import type { StudioFleetUpdateMethod } from "@specweave-studio/contracts/studioFleet";
import * as Effect from "effect/Effect";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- a real key file for the link.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";

import { join } from "../nodePath.ts";
import { loadOrCreateFleetProofKey } from "./fleetProofKey.ts";
import { makeFleetAddressBook, makeFleetLink } from "./fleetTransport.ts";
import {
  agentOffers,
  compareReleaseVersions,
  defaultReleasePublished,
  type FleetUpdateAsk,
  fleetUpdateAllowed,
  type FleetUpdateWorkerDeps,
  flattenFleetUpdateStatus,
  forcedPending,
  makeFleetUpdateWorker,
  runFleetUpdate,
} from "./fleetUpdate.ts";

// ---------------------------------------------------------------------------
// The worker: a fake update agent, drain, release feed and self-update
// ---------------------------------------------------------------------------

const offering = (version: string) => ({
  identity: "m1",
  version: "1.0.109",
  installedVersion: "1.0.109",
  status: "downloaded",
  availableVersion: version,
  downloadedVersion: version,
  installFinalized: true,
  installRequestedAt: null,
  installMode: null,
  installHoldUntil: null,
  installCancelledAt: null,
  installRequest: null,
});

interface Fakes {
  readonly agentCalls: Array<ReadonlyArray<string>>;
  readonly prepareCalls: Array<ServerPrepareServiceUpdateInput>;
  readonly selfUpdates: string[];
  /** Versions the self-update handed to the launcher, after its `installing` report. */
  readonly switched: string[];
}

/** What runs on the machine, as an if-idle hold sees it. */
interface Machine {
  folderCopies: number;
  runs: number;
}

function worker(
  options: {
    readonly method?: StudioFleetUpdateMethod | null;
    readonly serverVersion?: string;
    readonly status?: Record<string, unknown>;
    readonly held?: boolean;
    readonly requestAnswer?: Record<string, unknown>;
    readonly published?: boolean;
    readonly selfUpdate?: Effect.Effect<unknown, { readonly reason: string }>;
    /** How long the agent takes to answer a status read. */
    readonly statusDelayMs?: number;
    /** What an if-idle hold finds; idle when absent. */
    readonly machine?: Machine;
    readonly quietWait?: FleetUpdateWorkerDeps["quietWait"];
    /** Runs after an if-idle hold is granted, before its answer arrives. */
    readonly heldBeforeAnswer?: Effect.Effect<void>;
  } = {},
) {
  const fakes: Fakes = { agentCalls: [], prepareCalls: [], selfUpdates: [], switched: [] };
  const deps: FleetUpdateWorkerDeps = {
    serverVersion: options.serverVersion ?? "1.0.109",
    method: Effect.succeed(options.method === undefined ? "service-agent" : options.method),
    agent: (args) =>
      Effect.gen(function* () {
        if (args[0] === "status" && options.statusDelayMs !== undefined)
          yield* Effect.sleep(`${options.statusDelayMs} millis`);
        fakes.agentCalls.push(args);
        if (args[0] === "status") return options.status ?? offering("1.0.110");
        if (args[0] === "check") return { result: "check-requested" };
        if (args[0] === "cancel") return { result: "cancelled" };
        return (
          options.requestAnswer ?? {
            result: "requested",
            request: {
              installRequestedAt: "2026-10-28T13:10:00.000Z",
              installMode: args.includes("--force") ? "force" : "normal",
              installHoldUntil: args.includes("--force") ? "2026-10-28T13:25:00.000Z" : null,
              installRequest: { at: "2026-10-28T13:10:00.000Z", version: args[2] },
            },
          }
        );
      }),
    prepare: (input) =>
      Effect.gen(function* () {
        fakes.prepareCalls.push(input);
        if (input.ifIdle === true) {
          const machine = options.machine ?? { folderCopies: 0, runs: 0 };
          const idle = machine.folderCopies === 0 && machine.runs === 0;
          const look: ServerPrepareServiceUpdateResult = {
            idle,
            stoppedThreads: 0,
            blockers:
              machine.runs === 0
                ? []
                : [
                    {
                      kind: "run",
                      count: machine.runs,
                      threadId: null,
                      threadTitle: null,
                      projectId: null,
                      projectTitle: null,
                    },
                  ],
            held: idle,
            ...(idle ? { holdToken: "lease-1" } : {}),
            openTerminals: 0,
            folderCopies: machine.folderCopies,
          };
          if (idle && options.heldBeforeAnswer !== undefined) yield* options.heldBeforeAnswer;
          return look;
        }
        const result: ServerPrepareServiceUpdateResult = {
          idle: true,
          stoppedThreads: 2,
          blockers: [],
          held: input.stopWork ? (options.held ?? true) : false,
        };
        return result;
      }),
    releasePublished: () => Effect.succeed(options.published ?? true),
    selfUpdate: (version, report) =>
      Effect.gen(function* () {
        fakes.selfUpdates.push(version);
        yield* report("downloading");
        yield* report("installing");
        fakes.switched.push(version);
        return yield* options.selfUpdate ?? Effect.succeed({ targetVersion: version });
      }),
    ...(options.quietWait === undefined ? {} : { quietWait: options.quietWait }),
  };
  return { fakes, service: Effect.runSync(makeFleetUpdateWorker(deps)) };
}

/** The error an effect fails with; it must fail. */
const refusal = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(Effect.flip(effect));

/** Waits until the worker's background step leaves the in-flight phases. */
async function settled(service: ReturnType<typeof worker>["service"]) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const status = await Effect.runPromise(service.status);
    if (!["draining", "requesting", "downloading", "installing"].includes(status.phase))
      return status;
    await Effect.runPromise(Effect.sleep("5 millis"));
  }
  throw new Error("the worker never settled");
}

describe("a fleet machine taking its primary's update request", () => {
  it("makes the forced, held install Update now makes on a macOS service", async () => {
    const { fakes, service } = worker();
    const answer = await Effect.runPromise(
      service.request({ version: "1.0.110", mode: "force", holdMinutes: 10 }),
    );
    expect(answer).toMatchObject({
      method: "service-agent",
      result: "accepted",
      phase: "draining",
    });
    const status = await settled(service);
    expect(status).toMatchObject({ phase: "requested", targetVersion: "1.0.110" });
    // The very drain and hold Update now asks for, then the forced request bound to the version.
    expect(fakes.prepareCalls).toEqual([{ stopWork: true, hold: true, reason: "install" }]);
    expect(fakes.agentCalls).toContainEqual([
      "request",
      "--version",
      "1.0.110",
      "--force",
      "--hold-minutes",
      "10",
      "--kickstart",
    ]);
    // Status polling carries the agent's own report.
    expect(status.agent).toMatchObject({ availableVersion: "1.0.110" });
  });

  it("writes nothing when the service would not hold, and says why", async () => {
    const { fakes, service } = worker({ held: false });
    await Effect.runPromise(service.request({ version: "1.0.110", mode: "force" }));
    const status = await settled(service);
    expect(status).toMatchObject({ phase: "failed", lastErrorReason: "not-held" });
    expect(fakes.agentCalls.some((args) => args[0] === "request")).toBe(false);
  });

  it("releases the hold when the request could not be written", async () => {
    const { fakes, service } = worker({ requestAnswer: { error: "no update agent folder" } });
    await Effect.runPromise(service.request({ version: "1.0.110", mode: "force" }));
    const status = await settled(service);
    expect(status).toMatchObject({ phase: "failed", lastError: "no update agent folder" });
    expect(fakes.prepareCalls.at(-1)).toEqual({ stopWork: false, releaseHold: true });
  });

  it("asks the agent to look first when it does not offer the version yet", async () => {
    const { fakes, service } = worker({ status: offering("1.0.109") });
    const answer = await Effect.runPromise(service.request({ version: "1.0.110", mode: "force" }));
    expect(answer).toMatchObject({ result: "checking", phase: "checking" });
    expect(fakes.agentCalls).toContainEqual(["check", "--kickstart"]);
    expect(fakes.prepareCalls).toEqual([]);
  });

  it("requests without a hold when asked for a normal install", async () => {
    const { fakes, service } = worker();
    const answer = await Effect.runPromise(service.request({ version: "1.0.110", mode: "normal" }));
    expect(answer).toMatchObject({ result: "requested", request: { installMode: "normal" } });
    expect(fakes.prepareCalls).toEqual([]);
    expect(fakes.agentCalls).toContainEqual(["request", "--version", "1.0.110", "--kickstart"]);
  });

  it("refuses a downgrade, a version older than the one offered and an unknown version", async () => {
    const downgrade = worker();
    expect(
      await refusal(downgrade.service.request({ version: "1.0.108", mode: "force" })),
    ).toMatchObject({ reason: "downgrade" });
    const older = worker({ status: offering("1.0.111") });
    expect(
      await refusal(older.service.request({ version: "1.0.110", mode: "force" })),
    ).toMatchObject({ reason: "not-offered" });
    expect(older.fakes.prepareCalls).toEqual([]);
    const unknown = worker({ method: "boot-service", published: false });
    expect(
      await refusal(unknown.service.request({ version: "1.0.999", mode: "force" })),
    ).toMatchObject({ reason: "unknown-version" });
    expect(unknown.fakes.selfUpdates).toEqual([]);
    const malformed = worker();
    expect(
      await refusal(malformed.service.request({ version: "latest", mode: "force" })),
    ).toMatchObject({ reason: "unknown-version" });
    for (const each of [downgrade, malformed])
      expect(each.fakes.agentCalls.some((args) => args[0] === "request")).toBe(false);
  });

  it("says the version is already installed instead of asking again", async () => {
    const { fakes, service } = worker();
    expect(
      await Effect.runPromise(service.request({ version: "1.0.109", mode: "force" })),
    ).toMatchObject({ result: "already-installed" });
    expect(fakes.agentCalls).toEqual([]);
  });

  it("updates a Linux boot service through its self-update and reports each stage", async () => {
    const { fakes, service } = worker({ method: "boot-service", serverVersion: "1.0.105" });
    const answer = await Effect.runPromise(service.request({ version: "1.0.109", mode: "force" }));
    expect(answer).toMatchObject({ method: "boot-service", result: "accepted" });
    const status = await settled(service);
    expect(status).toMatchObject({ phase: "handed-off", targetVersion: "1.0.109" });
    expect(fakes.selfUpdates).toEqual(["1.0.109"]);
    expect(fakes.agentCalls).toEqual([]);
  });

  it("reports a failed self-update by its reason", async () => {
    const { service } = worker({
      method: "boot-service",
      serverVersion: "1.0.105",
      selfUpdate: Effect.fail({ reason: "preflight blocked" }),
    });
    await Effect.runPromise(service.request({ version: "1.0.109", mode: "force" }));
    expect(await settled(service)).toMatchObject({
      phase: "failed",
      lastError: "preflight blocked",
    });
  });

  it("refuses a second request while one is under way", async () => {
    const { service } = worker({
      method: "boot-service",
      serverVersion: "1.0.105",
      selfUpdate: Effect.never,
    });
    await Effect.runPromise(service.request({ version: "1.0.109", mode: "force" }));
    expect(await refusal(service.request({ version: "1.0.109", mode: "force" }))).toMatchObject({
      reason: "busy",
    });
  });

  it("is unsupported where no background service installs", async () => {
    const { service } = worker({ method: null });
    expect(await refusal(service.status)).toMatchObject({ reason: "unsupported" });
    const ask: FleetUpdateAsk = { version: "1.0.110", mode: "force" };
    expect(await refusal(service.request(ask))).toMatchObject({ reason: "unsupported" });
  });

  it("cancels the request it wrote and lets work start again", async () => {
    const { fakes, service } = worker();
    await Effect.runPromise(service.request({ version: "1.0.110", mode: "force" }));
    await settled(service);
    const answer = await Effect.runPromise(service.request({ cancel: "2026-10-28T13:10:00.000Z" }));
    expect(answer).toMatchObject({ result: "cancelled" });
    expect(fakes.agentCalls).toContainEqual(["cancel", "--request", "2026-10-28T13:10:00.000Z"]);
    expect(fakes.prepareCalls).toEqual([
      { stopWork: true, hold: true, reason: "install" },
      { stopWork: false, releaseHold: true },
    ]);
  });

  it("never cancels a request it did not write, such as the machine's own Update now", async () => {
    const { fakes, service } = worker();
    expect(await refusal(service.request({ cancel: "2026-10-28T13:10:00.000Z" }))).toMatchObject({
      reason: "unsupported",
    });
    expect(fakes.agentCalls).toEqual([]);
    expect(fakes.prepareCalls).toEqual([]);
  });

  it("releases no hold it did not place when cancelling a request it wrote", async () => {
    const { fakes, service } = worker();
    await Effect.runPromise(service.request({ version: "1.0.110", mode: "normal" }));
    await Effect.runPromise(service.request({ cancel: "2026-10-28T13:10:00.000Z" }));
    expect(fakes.agentCalls).toContainEqual(["cancel", "--request", "2026-10-28T13:10:00.000Z"]);
    expect(fakes.prepareCalls).toEqual([]);
  });

  it("refuses a second request that arrives while the first still reads the agent", async () => {
    const { fakes, service } = worker({ statusDelayMs: 50 });
    const first = Effect.runPromise(service.request({ version: "1.0.110", mode: "force" }));
    expect(await refusal(service.request({ version: "1.0.110", mode: "force" }))).toMatchObject({
      reason: "busy",
    });
    expect(await first).toMatchObject({ result: "accepted" });
    await settled(service);
    expect(fakes.prepareCalls).toEqual([{ stopWork: true, hold: true, reason: "install" }]);
    expect(fakes.agentCalls.filter((args) => args[0] === "request")).toHaveLength(1);
  });
});

/** Polls the worker's status until `done` holds. */
async function until(
  service: ReturnType<typeof worker>["service"],
  done: (status: Awaited<ReturnType<typeof settled>>) => boolean,
) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const status = await Effect.runPromise(service.status);
    if (done(status)) return status;
    await Effect.runPromise(Effect.sleep("5 millis"));
  }
  throw new Error("the worker never reached the expected state");
}

// 2026-10-29, 1.0.123 to 1.0.125: the fleet primary asked ministorm (a Linux boot service) for a
// normal update while it copied a folder from the M4; it restarted within seconds and the copy failed.
describe("a normal update on a Linux boot service", () => {
  const boot = (machine: Machine, maxMs = 5_000) =>
    worker({
      method: "boot-service",
      serverVersion: "1.0.123",
      machine,
      quietWait: { pollMs: 10, maxMs },
    });

  it("waits while a folder copy runs, says so, and installs once it ends", async () => {
    const machine = { folderCopies: 1, runs: 0 };
    const { fakes, service } = boot(machine);
    const answer = await Effect.runPromise(service.request({ version: "1.0.125", mode: "normal" }));
    expect(answer).toMatchObject({ method: "boot-service", result: "accepted" });
    const waiting = await until(service, (status) => status.phase === "requested");
    expect(waiting).toMatchObject({ phase: "requested", targetVersion: "1.0.125" });
    expect(waiting.lastError).toContain("1 folder copy");
    // Downloaded, but nothing handed to the launcher, and nothing was stopped.
    expect(fakes.selfUpdates).toEqual(["1.0.125"]);
    expect(fakes.switched).toEqual([]);
    expect(
      fakes.prepareCalls.every((call) => call.stopWork === false && call.ifIdle === true),
    ).toBe(true);
    // Asked again meanwhile (fleet_rollout's request window ended): the same wait answers.
    expect(
      await Effect.runPromise(service.request({ version: "1.0.125", mode: "normal" })),
    ).toMatchObject({ result: "accepted", phase: "requested" });
    expect(fakes.selfUpdates).toEqual(["1.0.125"]);

    machine.folderCopies = 0;
    const done = await until(service, (status) => status.phase === "handed-off");
    expect(done).toMatchObject({ phase: "handed-off", targetVersion: "1.0.125" });
    expect(fakes.switched).toEqual(["1.0.125"]);
    expect(fakes.prepareCalls.at(-1)).toEqual({
      stopWork: false,
      hold: true,
      ifIdle: true,
      reason: "install",
    });
  });

  it("waits for running turns too, and gives up as busy after its wait", async () => {
    const { fakes, service } = boot({ folderCopies: 1, runs: 2 }, 60);
    await Effect.runPromise(service.request({ version: "1.0.125", mode: "normal" }));
    const failed = await until(service, (status) => status.phase === "failed");
    expect(failed).toMatchObject({ phase: "failed", lastErrorReason: "busy" });
    expect(failed.lastError).toContain("1 folder copy, 2 running tasks");
    expect(fakes.switched).toEqual([]);
  });

  it("is withdrawn by a cancel while it waits, and releases any hold it took", async () => {
    const machine = { folderCopies: 1, runs: 0 };
    const { fakes, service } = boot(machine);
    await Effect.runPromise(service.request({ version: "1.0.125", mode: "normal" }));
    await until(service, (status) => status.phase === "requested");
    expect(
      await Effect.runPromise(service.request({ cancel: "2026-10-29T20:00:00.000Z" })),
    ).toMatchObject({ method: "boot-service", result: "cancelled", phase: "cancelled" });
    // The copy ends: nothing waits any more, so nothing switches over.
    machine.folderCopies = 0;
    const asked = fakes.prepareCalls.length;
    await Effect.runPromise(Effect.sleep("60 millis"));
    expect(fakes.prepareCalls).toHaveLength(asked);
    expect(fakes.switched).toEqual([]);
    expect(await Effect.runPromise(service.status)).toMatchObject({ phase: "cancelled" });
    // Nothing waits now, so a cancel is refused; a new request starts afresh.
    await expect(
      Effect.runPromise(service.request({ cancel: "2026-10-29T20:00:00.000Z" })),
    ).rejects.toMatchObject({ reason: "unsupported" });
    await Effect.runPromise(service.request({ version: "1.0.125", mode: "normal" }));
    expect(await until(service, (status) => status.phase === "handed-off")).toMatchObject({
      phase: "handed-off",
    });
  });

  it("installs at once on a quiet machine", async () => {
    const { fakes, service } = boot({ folderCopies: 0, runs: 0 });
    await Effect.runPromise(service.request({ version: "1.0.125", mode: "normal" }));
    expect(await until(service, (status) => status.phase === "handed-off")).toMatchObject({
      phase: "handed-off",
    });
    expect(fakes.prepareCalls).toHaveLength(1);
  });

  it("goes ahead when forced, replacing a normal request that waits", async () => {
    const { fakes, service } = boot({ folderCopies: 1, runs: 0 });
    await Effect.runPromise(service.request({ version: "1.0.125", mode: "normal" }));
    await until(service, (status) => status.phase === "requested");
    await Effect.runPromise(service.request({ version: "1.0.125", mode: "force" }));
    // The wait ended with the request: no look after it.
    const asked = fakes.prepareCalls.length;
    expect(await until(service, (status) => status.phase === "handed-off")).toMatchObject({
      phase: "handed-off",
      targetVersion: "1.0.125",
    });
    // The forced install looks for no quiet moment, and the waiting one never switched over.
    expect(fakes.switched).toEqual(["1.0.125"]);
    expect(fakes.prepareCalls).toHaveLength(asked);
  });

  it("releases the hold it was granted when a forced request replaces it before the switch-over", async () => {
    let granted!: () => void;
    let answer!: () => void;
    const grantedNow = new Promise<void>((resolve) => (granted = resolve));
    const answered = new Promise<void>((resolve) => (answer = resolve));
    const { fakes, service } = worker({
      method: "boot-service",
      serverVersion: "1.0.123",
      machine: { folderCopies: 0, runs: 0 },
      quietWait: { pollMs: 10, maxMs: 5_000 },
      heldBeforeAnswer: Effect.promise(() => {
        granted();
        return answered;
      }),
    });
    await Effect.runPromise(service.request({ version: "1.0.125", mode: "normal" }));
    await grantedNow;
    // The service granted the if-idle hold; its answer is still on the way when the force arrives.
    const forced = Effect.runPromise(service.request({ version: "1.0.125", mode: "force" }));
    answer();
    await forced;
    await until(service, (status) => status.phase === "handed-off");
    expect(fakes.prepareCalls).toContainEqual({
      stopWork: false,
      releaseHold: true,
      holdToken: "lease-1",
    });
    expect(fakes.switched).toEqual(["1.0.125"]);
  });
});

describe("fleet update rules", () => {
  it("compares exact release versions only", () => {
    expect(compareReleaseVersions("1.0.110", "1.0.109")).toBeGreaterThan(0);
    expect(compareReleaseVersions("1.0.9", "1.0.10")).toBeLessThan(0);
    expect(compareReleaseVersions("1.0.10", "1.0.10")).toBe(0);
    expect(compareReleaseVersions("1.0.10-nightly.1", "1.0.10")).toBeNull();
  });

  it("lets only the fleet primary's management token use the path", () => {
    const coordinator = (environmentId: string, scopes: AuthEnvironmentScope[]) => ({
      principal: { kind: "coordinator", environmentId },
      scopes: new Set(scopes),
    });
    expect(fleetUpdateAllowed(coordinator("env-m4", [AuthFleetUpdateScope]), "env-m4")).toBe(true);
    // Tokens issued before fleet:update hold environment:maintain.
    expect(
      fleetUpdateAllowed(coordinator("env-m4", [AuthEnvironmentMaintainScope]), "env-m4"),
    ).toBe(true);
    expect(
      fleetUpdateAllowed(
        coordinator("env-m4", [AuthOrchestrationReadScope, AuthOrchestrationOperateScope]),
        "env-m4",
      ),
    ).toBe(false);
    expect(fleetUpdateAllowed(coordinator("env-other", [AuthFleetUpdateScope]), "env-m4")).toBe(
      false,
    );
    // The owner's own sign-in is not the fleet primary's credential.
    expect(
      fleetUpdateAllowed(
        { scopes: new Set([AuthFleetUpdateScope, AuthEnvironmentMaintainScope]) },
        "env-m4",
      ),
    ).toBe(false);
  });

  it("matches fleet_rollout's offer and forced-request rules", () => {
    expect(agentOffers(offering("1.0.110"), "1.0.110")).toBe(true);
    expect(agentOffers(offering("1.0.110"), "1.0.111")).toBe(false);
    const now = Date.parse("2026-10-28T13:15:00.000Z");
    const forced = {
      installMode: "force",
      installRequestedAt: "2026-10-28T13:10:00.000Z",
      installHoldUntil: "2026-10-28T13:25:00.000Z",
    };
    expect(forcedPending(forced, now)).toBe(true);
    expect(forcedPending({ ...forced, installCancelledAt: "2026-10-28T13:11:00.000Z" }, now)).toBe(
      false,
    );
  });

  it("passes on the request the agent handled, by which fleet_rollout sees a press has ended", () => {
    const handled = "2026-10-28T13:10:00.000Z";
    const line = flattenFleetUpdateStatus(
      {
        method: "service-agent",
        serverVersion: "1.0.109",
        phase: "idle",
        agent: { ...offering("1.0.110"), handledInstallRequestAt: handled },
      },
      "connect",
    );
    expect(line).toMatchObject({ handledInstallRequestAt: handled, availableVersion: "1.0.110" });
  });

  it("reports a boot service as finalized once it runs the version it was asked for", () => {
    const line = flattenFleetUpdateStatus(
      { method: "boot-service", serverVersion: "1.0.109", phase: "idle" },
      "connect",
    );
    expect(line).toMatchObject({
      version: "1.0.109",
      installFinalized: true,
      transport: "connect",
    });
    expect(
      flattenFleetUpdateStatus(
        {
          method: "boot-service",
          serverVersion: "1.0.105",
          phase: "downloading",
          targetVersion: "1.0.109",
        },
        "connect",
      ).installFinalized,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The primary: one command over Connect or Tailscale
// ---------------------------------------------------------------------------

const TAILNET = "https://m1.fixture.ts.net";
const CONNECT = "https://prod-0123456789abcdef.spec-weave.com";
const PRIMARY = "env-m4";

const token = (jkt?: string) =>
  `${Buffer.from(JSON.stringify({ sid: "s1", ...(jkt ? { jkt } : {}) })).toString("base64url")}.sig`;

const describeMachine = (capabilities: Record<string, unknown>, serverVersion = "1.0.109") => ({
  environmentId: "env-m1",
  label: "Mac M1",
  platform: { os: "darwin", arch: "arm64" },
  serverVersion,
  orchestrationProtocolVersion: 2,
  capabilities: { repositoryIdentity: true, ...capabilities },
});

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => NodeFSP.rm(dir, { recursive: true, force: true })));
});

/** A primary with its fleet key, and a machine answering only on `up`. */
async function primary(input: {
  readonly up: ReadonlyArray<string>;
  readonly capabilities: Record<string, unknown>;
  readonly serverVersion?: string;
  readonly answer: (request: { method: string; path: string; body: unknown }) => Response;
  readonly bound?: boolean;
}) {
  const baseDir = await NodeFSP.mkdtemp(join(NodeOS.tmpdir(), "studio-fleet-update-"));
  dirs.push(baseDir);
  const key = await loadOrCreateFleetProofKey(baseDir);
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    const target = new URL(String(url));
    if (!input.up.includes(target.origin)) throw new TypeError("offline");
    if (target.pathname === "/.well-known/studio/environment")
      return Response.json(describeMachine(input.capabilities, input.serverVersion));
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    return input.answer({
      method: init?.method ?? "GET",
      path: `${target.pathname}${target.search}`,
      body,
    });
  });
  const link = makeFleetLink({ fetch: fetcher, baseDir, book: makeFleetAddressBook() });
  const target = {
    id: "m1",
    label: "Mac M1",
    environmentId: EnvironmentId.make("env-m1"),
    url: TAILNET,
    connectUrl: CONNECT,
    managementToken: input.bound === false ? token() : token(key.thumbprint),
    scopes: [AuthOrchestrationReadScope],
  };
  return { fetcher, link, target };
}

describe("the primary asking a fleet machine to update", () => {
  it("asks over Connect with the token it holds, a proof and no bearer", async () => {
    const { fetcher, link, target } = await primary({
      up: [CONNECT],
      capabilities: { fleetUpdateRequest: true },
      answer: ({ method }) =>
        method === "POST"
          ? Response.json({
              method: "service-agent",
              result: "requested",
              phase: "requested",
              serverVersion: "1.0.109",
              request: {
                installRequestedAt: "2026-10-28T13:10:00.000Z",
                installMode: "normal",
                installHoldUntil: null,
                installRequest: { at: "2026-10-28T13:10:00.000Z", version: "1.0.110" },
              },
            })
          : Response.json({}, { status: 404 }),
    });
    const outcome = await runFleetUpdate({
      link,
      target,
      coordinatorEnvironmentId: PRIMARY,
      action: { kind: "request", version: "1.0.110", hold: false },
    });
    expect(outcome).toMatchObject({
      result: "requested",
      transport: "connect",
      request: { installRequest: { version: "1.0.110" } },
    });
    const post = fetcher.mock.calls.find(([, init]) => init?.method === "POST")!;
    expect(String(post[0])).toBe(`${CONNECT}/api/studio/fleet/update`);
    const headers = post[1]!.headers as Record<string, string>;
    expect(headers.authorization).toMatch(/^DPoP /);
    expect(headers.dpop).toMatch(/^ey/);
    expect(JSON.parse(String(post[1]!.body))).toEqual({
      coordinatorEnvironmentId: PRIMARY,
      version: "1.0.110",
      mode: "normal",
    });
  });

  it("waits for a held install's drain and returns the request it wrote", async () => {
    let polls = 0;
    const { link, target } = await primary({
      up: [TAILNET],
      capabilities: { fleetUpdateRequest: true },
      answer: ({ method, path }) => {
        if (method === "POST")
          return Response.json({
            method: "service-agent",
            result: "accepted",
            phase: "draining",
            serverVersion: "1.0.109",
          });
        expect(path).toBe(`/api/studio/fleet/update?coordinatorEnvironmentId=${PRIMARY}`);
        polls += 1;
        return Response.json({
          method: "service-agent",
          serverVersion: "1.0.109",
          phase: polls < 2 ? "draining" : "requested",
          targetVersion: "1.0.110",
          agent: {
            ...offering("1.0.110"),
            installRequestedAt: "2026-10-28T13:10:00.000Z",
            installMode: "force",
            installHoldUntil: "2026-10-28T13:25:00.000Z",
            installRequest: { at: "2026-10-28T13:10:00.000Z", version: "1.0.110" },
          },
        });
      },
    });
    const outcome = await runFleetUpdate({
      link,
      target,
      coordinatorEnvironmentId: PRIMARY,
      action: { kind: "request", version: "1.0.110", hold: true },
      pollMs: 1,
      sleep: async () => undefined,
    });
    expect(outcome).toMatchObject({
      result: "requested",
      transport: "tailnet",
      request: { installMode: "force", installRequestedAt: "2026-10-28T13:10:00.000Z" },
    });
    expect(polls).toBe(2);
  });

  it("reads status in update_request.py's shape, plus route and method", async () => {
    const { link, target } = await primary({
      up: [CONNECT],
      capabilities: { fleetUpdateRequest: true },
      answer: () =>
        Response.json({
          method: "service-agent",
          serverVersion: "1.0.109",
          phase: "idle",
          agent: offering("1.0.110"),
        }),
    });
    const outcome = await runFleetUpdate({
      link,
      target,
      coordinatorEnvironmentId: PRIMARY,
      action: { kind: "status" },
    });
    expect(outcome).toMatchObject({
      identity: "m1",
      version: "1.0.109",
      installFinalized: true,
      availableVersion: "1.0.110",
      transport: "connect",
      method: "service-agent",
    });
  });

  it("passes the machine's named refusal through", async () => {
    const { link, target } = await primary({
      up: [CONNECT],
      capabilities: { fleetUpdateRequest: true },
      answer: () =>
        Response.json(
          { _tag: "StudioFleetUpdateError", reason: "downgrade", message: "newer already" },
          { status: 409 },
        ),
    });
    await expect(
      runFleetUpdate({
        link,
        target,
        coordinatorEnvironmentId: PRIMARY,
        action: { kind: "request", version: "1.0.100", hold: true },
      }),
    ).rejects.toMatchObject({ reason: "downgrade", message: "newer already" });
  });

  it("says unauthorized when the machine refuses the token", async () => {
    const { link, target } = await primary({
      up: [CONNECT],
      capabilities: { fleetUpdateRequest: true },
      answer: () => Response.json({ message: "forbidden" }, { status: 403 }),
    });
    await expect(
      runFleetUpdate({
        link,
        target,
        coordinatorEnvironmentId: PRIMARY,
        action: { kind: "status" },
      }),
    ).rejects.toMatchObject({ reason: "unauthorized" });
  });

  it("never sends a plain bearer over Connect", async () => {
    const { fetcher, link, target } = await primary({
      up: [CONNECT],
      capabilities: { fleetUpdateRequest: true },
      answer: () => Response.json({}),
      bound: false,
    });
    await expect(
      runFleetUpdate({
        link,
        target,
        coordinatorEnvironmentId: PRIMARY,
        action: { kind: "request", version: "1.0.110", hold: true },
      }),
    ).rejects.toMatchObject({ reason: "connect-unbound" });
    expect(fetcher.mock.calls.every(([, init]) => init?.method !== "POST")).toBe(true);
  });

  it("reports a machine reachable by neither route instead of waiting", async () => {
    const { link, target } = await primary({
      up: [],
      capabilities: {},
      answer: () => Response.json({}),
    });
    await expect(
      runFleetUpdate({
        link,
        target,
        coordinatorEnvironmentId: PRIMARY,
        action: { kind: "status" },
      }),
    ).rejects.toMatchObject({ reason: "unreachable" });
  });

  it("updates an older boot service through its own self-update, after the primary's checks", async () => {
    const calls: Array<{ webSocketUrl: string; version: string }> = [];
    const { link, target } = await primary({
      up: [CONNECT],
      capabilities: { serverSelfUpdate: "boot-service" },
      serverVersion: "1.0.105",
      answer: ({ path }) =>
        path === "/api/auth/websocket-ticket"
          ? Response.json({ ticket: "ticket-1", expiresAt: "2026-10-28T13:15:00.000Z" })
          : Response.json({}, { status: 404 }),
    });
    const legacySelfUpdate = async (input: { webSocketUrl: string; version: string }) => {
      calls.push(input);
    };
    const published = vi.fn(async (version: string) => version === "1.0.109");
    const outcome = await runFleetUpdate({
      link,
      target,
      coordinatorEnvironmentId: PRIMARY,
      action: { kind: "request", version: "1.0.109", hold: true },
      legacySelfUpdate,
      releasePublished: published,
    });
    expect(outcome).toMatchObject({ result: "requested", method: "boot-service" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.webSocketUrl).toMatch(
      /^wss:\/\/prod-0123456789abcdef\.spec-weave\.com\/ws\?wsTicket=ticket-1/,
    );
    // Downgrades and unpublished versions never reach the machine.
    for (const [version, reason] of [
      ["1.0.104", "downgrade"],
      ["1.0.200", "unknown-version"],
    ] as const)
      await expect(
        runFleetUpdate({
          link,
          target,
          coordinatorEnvironmentId: PRIMARY,
          action: { kind: "request", version, hold: true },
          legacySelfUpdate,
          releasePublished: published,
        }),
      ).rejects.toMatchObject({ reason });
    expect(calls).toHaveLength(1);
  });

  // The 2026-10-29 setup: the primary copies a folder with a machine that predates the quiet
  // wait, which installs a normal request at once.
  it("holds a normal request to an older machine back while it copies a folder itself", async () => {
    const posts: unknown[] = [];
    const answer = ({ method, body }: { method: string; body: unknown }) => {
      if (method === "POST") posts.push(body);
      return Response.json({
        method: "boot-service",
        result: "accepted",
        phase: "downloading",
        serverVersion: "1.0.123",
      });
    };
    const older = await primary({
      up: [CONNECT],
      capabilities: { fleetUpdateRequest: true },
      serverVersion: "1.0.123",
      answer,
    });
    const ask = (machine: typeof older, hold: boolean, localFolderCopies: number) =>
      runFleetUpdate({
        link: machine.link,
        target: machine.target,
        coordinatorEnvironmentId: PRIMARY,
        action: { kind: "request", version: "1.0.126", hold },
        localFolderCopies,
      });
    const refused = await ask(older, false, 2).catch((error: unknown) => error);
    expect(refused).toMatchObject({ reason: "busy" });
    expect((refused as Error).message).toContain("this machine has 2 folder copies in progress");
    expect(posts).toEqual([]);
    // Forced, or with nothing copying here, it is asked as before.
    await expect(ask(older, true, 2)).resolves.toMatchObject({ result: "requested" });
    await expect(ask(older, false, 0)).resolves.toMatchObject({ result: "requested" });
    // A machine that waits for its own copies is asked at once.
    const waits = await primary({
      up: [CONNECT],
      capabilities: { fleetUpdateRequest: true, fleetUpdateWaitsForFolderCopies: true },
      answer,
    });
    await expect(ask(waits, false, 2)).resolves.toMatchObject({ result: "requested" });
    expect(posts).toHaveLength(3);
  });

  it("says an older macOS machine updates itself", async () => {
    const { link, target } = await primary({
      up: [CONNECT],
      capabilities: {},
      answer: () => Response.json({}),
    });
    await expect(
      runFleetUpdate({
        link,
        target,
        coordinatorEnvironmentId: PRIMARY,
        action: { kind: "request", version: "1.0.110", hold: true },
      }),
    ).rejects.toMatchObject({ reason: "unsupported" });
  });
});

// ---------------------------------------------------------------------------
// The release check for an older boot-service machine: both checksum files
// ---------------------------------------------------------------------------

describe("defaultReleasePublished", () => {
  const sum = "a".repeat(64);
  const fetcherFor = (files: Readonly<Record<string, string>>, seen: string[] = []) =>
    (async (input: string | URL | Request) => {
      const url = String(input);
      seen.push(url.slice(url.lastIndexOf("/") + 1));
      const body = files[url.slice(url.lastIndexOf("/") + 1)];
      return body === undefined
        ? new Response("Not Found", { status: 404 })
        : new Response(body, { status: 200 });
    }) as typeof fetch;

  it("finds a Windows zip in SHA256SUMS-windows-linux", async () => {
    const seen: string[] = [];
    const fetcher = fetcherFor(
      {
        SHA256SUMS: `${sum}  studio-1.0.132-linux-x64-ca452067cd93.tar.gz\n`,
        "SHA256SUMS-windows-linux": `${sum}  studio-1.0.132-win32-x64.zip\n`,
      },
      seen,
    );
    expect(await defaultReleasePublished(fetcher, "1.0.132", "win32-x64")).toBe(true);
    expect(seen).toEqual(["SHA256SUMS", "SHA256SUMS-windows-linux"]);
  });

  it("reads only SHA256SUMS when it settles the answer", async () => {
    const seen: string[] = [];
    const fetcher = fetcherFor(
      { SHA256SUMS: `${sum}  studio-1.0.132-linux-x64-ca452067cd93.tar.gz\n` },
      seen,
    );
    expect(await defaultReleasePublished(fetcher, "1.0.132", "linux-x64")).toBe(true);
    expect(seen).toEqual(["SHA256SUMS"]);
  });

  it("treats a missing SHA256SUMS-windows-linux as empty and an unlisted zip as unpublished", async () => {
    const fetcher = fetcherFor({ SHA256SUMS: `${sum}  studio-1.0.90-win32-x64.zip\n` });
    expect(await defaultReleasePublished(fetcher, "1.0.90", "win32-x64")).toBe(true);
    expect(await defaultReleasePublished(fetcher, "1.0.90", "win32-arm64")).toBe(true);
    expect(
      await defaultReleasePublished(fetcherFor({ SHA256SUMS: "" }), "1.0.90", "win32-x64"),
    ).toBe(false);
  });
});
