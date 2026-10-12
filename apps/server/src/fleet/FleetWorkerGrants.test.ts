import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId } from "@specweave-studio/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import { TestClock } from "effect/testing";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import type { FleetConfig, FleetTarget } from "../studioFleet.ts";
import { fakeMachine, target } from "./fleetMachine.testkit.ts";
import * as FleetTargets from "./FleetTargets.ts";
import * as FleetWorkerGrants from "./FleetWorkerGrants.ts";

const NOW = Date.parse("2026-10-12T00:00:00.000Z");

const makeLayer = (input: {
  readonly machine: ReturnType<typeof fakeMachine>;
  readonly target?: FleetTarget;
  readonly logs?: string[];
}) => {
  const config: FleetConfig = { version: 1, machines: [input.target ?? target] };
  const layerConfig = ServerConfig.layerTest(process.cwd(), { prefix: "studio-fleet-grants-" });
  return FleetWorkerGrants.layer.pipe(
    Layer.provideMerge(
      Layer.succeed(FleetTargets.FleetTargets, {
        load: Effect.succeed(config),
        fetch: input.machine.fetcher,
      }),
    ),
    Layer.provideMerge(ServerSecretStore.layer),
    Layer.provide(
      Layer.mock(ServerEnvironment.ServerEnvironment)({
        getEnvironmentId: Effect.succeed(EnvironmentId.make("env-m4")),
      }),
    ),
    Layer.provideMerge(layerConfig),
    Layer.provideMerge(NodeServices.layer),
    Layer.provide(
      Logger.layer(
        [
          Logger.make(({ message }) => {
            input.logs?.push(JSON.stringify(message));
          }),
        ],
        { mergeWithExisting: false },
      ),
    ),
  );
};

const setNow = (millis: number) => TestClock.setTime(millis);

/** The other machine's client list throws like a dropped connection while `down`. */
const unreachableClients = (machine: ReturnType<typeof fakeMachine>, state: { down: boolean }) => ({
  ...machine,
  fetcher: (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (state.down && new URL(String(input)).pathname.startsWith("/api/auth/clients"))
      throw new TypeError("fetch failed");
    return machine.fetcher(input, init);
  }) as typeof fetch,
});

describe("FleetWorkerGrants", () => {
  it.effect("allows workers, stores the grant privately and never logs the token", () => {
    const machine = fakeMachine();
    const logs: string[] = [];
    return Effect.gen(function* () {
      yield* setNow(NOW);
      const grants = yield* FleetWorkerGrants.FleetWorkerGrants;
      expect((yield* grants.status("m1")).status).toBe("not_allowed");
      const workers = yield* grants.allow({ machineId: "m1", access: "auto" });
      expect(workers).toEqual({
        status: "allowed",
        access: "auto",
        expiresAt: "2026-11-11T00:00:00.000Z",
        renewable: true,
        problem: null,
      });
      const credential = yield* grants.credential("m1");
      expect(credential.accessToken).toBe("mcp-token-auto-1");
      const config = yield* ServerConfig.ServerConfig;
      const file = NodePath.join(config.secretsDir, "fleet-worker-grant-m1.bin");
      expect(NodeFS.statSync(file).mode & 0o777).toBe(0o600);
      expect(NodeFS.statSync(config.secretsDir).mode & 0o777).toBe(0o700);
      expect(NodeFS.readFileSync(file, "utf8")).toContain('"environmentId":"env-m1"');
      expect(JSON.stringify(workers)).not.toContain("mcp-token");
      expect(logs.join("\n")).not.toContain("mcp-token");
      expect(logs.join("\n")).not.toContain("management-secret");
      expect(logs.join("\n")).not.toContain("PAIRCODE");
    }).pipe(Effect.provide(makeLayer({ machine, logs })));
  });

  it.effect("records why allowing failed instead of failing the request", () => {
    const machine = fakeMachine({ protectedResourceStatus: 404 });
    return Effect.gen(function* () {
      yield* setNow(NOW);
      const grants = yield* FleetWorkerGrants.FleetWorkerGrants;
      const workers = yield* grants.allow({ machineId: "m1", access: "auto" });
      expect(workers.status).toBe("not_allowed");
      expect(workers.problem).toBe("unsupported");
      const error = yield* grants.credential("m1").pipe(Effect.flip);
      expect(error.reason).toBe("not_allowed");
    }).pipe(Effect.provide(makeLayer({ machine })));
  });

  it.effect("rate-limits minting to once a minute per machine", () => {
    const machine = fakeMachine();
    return Effect.gen(function* () {
      yield* setNow(NOW);
      const grants = yield* FleetWorkerGrants.FleetWorkerGrants;
      yield* grants.allow({ machineId: "m1", access: "auto" });
      const error = yield* grants.allow({ machineId: "m1", access: "auto" }).pipe(Effect.flip);
      expect(error.reason).toBe("rate_limited");
      yield* setNow(NOW + 61_000);
      yield* grants.allow({ machineId: "m1", access: "full-access" });
      expect((yield* grants.credential("m1")).access).toBe("full-access");
      // The second grant replaced the first session on the other machine.
      expect(machine.revokedSessions).toContain("old");
    }).pipe(Effect.provide(makeLayer({ machine })));
  });

  it.effect("treats a 401 as a revocation and never mints again on its own", () => {
    const machine = fakeMachine();
    return Effect.gen(function* () {
      yield* setNow(NOW);
      const grants = yield* FleetWorkerGrants.FleetWorkerGrants;
      yield* grants.allow({ machineId: "m1", access: "auto" });
      const { accessToken } = yield* grants.credential("m1");
      yield* grants.reportRejected("m1", accessToken);
      expect((yield* grants.status("m1")).status).toBe("revoked");
      expect((yield* grants.credential("m1").pipe(Effect.flip)).reason).toBe("revoked");
      // Renewal never revives a revoked grant.
      yield* grants.reportAccepted("m1");
      yield* setNow(Date.parse("2026-11-08T00:00:00.000Z"));
      yield* grants.renewDue;
      expect(machine.issued()).toBe(1);
    }).pipe(Effect.provide(makeLayer({ machine })));
  });

  it.effect("ignores a stale 401 for a token it no longer holds", () => {
    const machine = fakeMachine();
    return Effect.gen(function* () {
      yield* setNow(NOW);
      const grants = yield* FleetWorkerGrants.FleetWorkerGrants;
      yield* grants.allow({ machineId: "m1", access: "auto" });
      yield* grants.reportRejected("m1", "some-older-token");
      expect((yield* grants.status("m1")).status).toBe("allowed");
    }).pipe(Effect.provide(makeLayer({ machine })));
  });

  it.effect("renews only within a week of expiry and only after a recent accepted call", () => {
    const machine = fakeMachine();
    return Effect.gen(function* () {
      yield* setNow(NOW);
      const grants = yield* FleetWorkerGrants.FleetWorkerGrants;
      yield* grants.allow({ machineId: "m1", access: "auto" });
      // Ten days left: not due.
      yield* setNow(Date.parse("2026-11-01T00:00:00.000Z"));
      yield* grants.reportAccepted("m1");
      yield* grants.renewDue;
      expect(machine.issued()).toBe(1);
      // Four days left, but the last accepted call was two days ago.
      yield* setNow(Date.parse("2026-11-07T00:00:00.000Z"));
      yield* grants.renewDue;
      expect(machine.issued()).toBe(1);
      // Accepted within the day: renewed, and the old session revoked there.
      yield* grants.reportAccepted("m1");
      yield* TestClock.adjust(Duration.hours(1));
      yield* grants.renewDue;
      expect(machine.issued()).toBe(2);
      expect((yield* grants.credential("m1")).accessToken).toBe("mcp-token-auto-2");
      expect(machine.revokedSessions).toContain("old");
    }).pipe(Effect.provide(makeLayer({ machine })));
  });

  it.effect("shows a grant without a management token as expiring in its last week", () => {
    const machine = fakeMachine();
    const { managementToken: _dropped, ...withoutToken } = target;
    return Effect.gen(function* () {
      yield* setNow(NOW);
      const grants = yield* FleetWorkerGrants.FleetWorkerGrants;
      const workers = yield* grants.allow({
        machineId: "m1",
        access: "approval-required",
        pairingCode: "PAIRCODE",
      });
      expect(workers.renewable).toBe(false);
      expect(workers.status).toBe("allowed");
      yield* setNow(Date.parse("2026-11-06T00:00:00.000Z"));
      expect((yield* grants.status("m1")).status).toBe("expiring");
      yield* setNow(Date.parse("2026-11-12T00:00:00.000Z"));
      expect((yield* grants.status("m1")).status).toBe("expired");
      expect((yield* grants.credential("m1").pipe(Effect.flip)).reason).toBe("expired");
    }).pipe(Effect.provide(makeLayer({ machine, target: withoutToken })));
  });

  it.effect("ignores a stored grant once the machine's identity changes", () => {
    const machine = fakeMachine();
    return Effect.gen(function* () {
      yield* setNow(NOW);
      const grants = yield* FleetWorkerGrants.FleetWorkerGrants;
      yield* grants.allow({ machineId: "m1", access: "auto" });
      const config = yield* ServerConfig.ServerConfig;
      const moved = Layer.fresh(FleetWorkerGrants.layer).pipe(
        Layer.provide(
          Layer.succeed(FleetTargets.FleetTargets, {
            load: Effect.succeed({
              version: 1 as const,
              machines: [{ ...target, environmentId: EnvironmentId.make("env-replaced") }],
            }),
            fetch: machine.fetcher,
          }),
        ),
        Layer.provide(ServerSecretStore.layer),
        Layer.provide(
          Layer.mock(ServerEnvironment.ServerEnvironment)({
            getEnvironmentId: Effect.succeed(EnvironmentId.make("env-m4")),
          }),
        ),
        Layer.provide(ServerConfig.layer(config)),
        Layer.provide(NodeServices.layer),
      );
      const status = yield* FleetWorkerGrants.FleetWorkerGrants.pipe(
        Effect.flatMap((service) => service.status("m1")),
        Effect.provide(moved),
      );
      expect(status.status).toBe("not_allowed");
    }).pipe(Effect.provide(makeLayer({ machine })));
  });

  it.effect("stop deletes the grant here and revokes it there by label", () => {
    const machine = fakeMachine();
    return Effect.gen(function* () {
      yield* setNow(NOW);
      const grants = yield* FleetWorkerGrants.FleetWorkerGrants;
      yield* grants.allow({ machineId: "m1", access: "auto" });
      const result = yield* grants.stop("m1");
      expect(result.workers.status).toBe("not_allowed");
      expect(result.remoteSessionKept).toBe(false);
      expect(machine.revokedSessions.toSorted()).toEqual(["new", "old", "old"].toSorted());
      const config = yield* ServerConfig.ServerConfig;
      expect(
        NodeFS.readdirSync(config.secretsDir).some((name) => name.startsWith("fleet-worker")),
      ).toBe(false);
    }).pipe(Effect.provide(makeLayer({ machine })));
  });

  it.effect("stop without a management token keeps the remote session until it expires", () => {
    const machine = fakeMachine();
    const { managementToken: _dropped, ...withoutToken } = target;
    return Effect.gen(function* () {
      yield* setNow(NOW);
      const grants = yield* FleetWorkerGrants.FleetWorkerGrants;
      yield* grants.allow({ machineId: "m1", access: "auto", pairingCode: "PAIRCODE" });
      const result = yield* grants.stop("m1");
      expect(result.remoteSessionKept).toBe(true);
    }).pipe(Effect.provide(makeLayer({ machine, target: withoutToken })));
  });

  it.effect("revokes its own sessions by id when the management token cannot list them", () => {
    const machine = fakeMachine({ sessionTokens: true, clientsStatus: 403 });
    return Effect.gen(function* () {
      yield* setNow(NOW);
      const grants = yield* FleetWorkerGrants.FleetWorkerGrants;
      yield* grants.allow({ machineId: "m1", access: "auto" });
      expect(machine.revokedSessions).toEqual([]);
      yield* setNow(NOW + 61_000);
      // Allowing again replaces the first grant's session there.
      yield* grants.allow({ machineId: "m1", access: "approval-required" });
      expect(machine.revokedSessions).toEqual(["sid-1"]);
      const result = yield* grants.stop("m1");
      expect(result.remoteSessionKept).toBe(false);
      expect(machine.revokedSessions).toEqual(["sid-1", "sid-2"]);
    }).pipe(Effect.provide(makeLayer({ machine })));
  });

  it.effect("says the session was kept when it neither knows nor can list it", () => {
    const machine = fakeMachine({ clientsStatus: 403 });
    return Effect.gen(function* () {
      yield* setNow(NOW);
      const grants = yield* FleetWorkerGrants.FleetWorkerGrants;
      yield* grants.allow({ machineId: "m1", access: "auto" });
      expect((yield* grants.stop("m1")).remoteSessionKept).toBe(true);
    }).pipe(Effect.provide(makeLayer({ machine })));
  });

  it.effect("stop still succeeds and says the session was kept when the machine drops off", () => {
    const state = { down: false };
    const machine = unreachableClients(fakeMachine(), state);
    return Effect.gen(function* () {
      yield* setNow(NOW);
      const grants = yield* FleetWorkerGrants.FleetWorkerGrants;
      yield* grants.allow({ machineId: "m1", access: "auto" });
      state.down = true;
      const result = yield* grants.stop("m1");
      expect(result.workers.status).toBe("not_allowed");
      expect(result.remoteSessionKept).toBe(true);
    }).pipe(Effect.provide(makeLayer({ machine })));
  });

  it.effect("allow keeps the new grant when revoking the old session fails", () => {
    const machine = unreachableClients(fakeMachine(), { down: true });
    return Effect.gen(function* () {
      yield* setNow(NOW);
      const grants = yield* FleetWorkerGrants.FleetWorkerGrants;
      const workers = yield* grants.allow({ machineId: "m1", access: "auto" });
      expect(workers.status).toBe("allowed");
    }).pipe(Effect.provide(makeLayer({ machine })));
  });

  it.effect("a renewal pass survives a machine that drops off mid-revoke", () => {
    const state = { down: false };
    const machine = unreachableClients(fakeMachine(), state);
    return Effect.gen(function* () {
      yield* setNow(NOW);
      const grants = yield* FleetWorkerGrants.FleetWorkerGrants;
      yield* grants.allow({ machineId: "m1", access: "auto" });
      yield* setNow(NOW + Duration.toMillis(Duration.days(25)));
      yield* grants.reportAccepted("m1");
      state.down = true;
      yield* grants.renewDue;
      expect((yield* grants.status("m1")).status).toBe("allowed");
    }).pipe(Effect.provide(makeLayer({ machine })));
  });

  it.effect("reports the session kept when one revoke call is refused", () => {
    const base = fakeMachine();
    const machine = {
      ...base,
      fetcher: (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const url = new URL(String(input));
        if (url.pathname === "/api/auth/clients/revoke" && init?.body?.toString().includes("old"))
          return new Response("{}", { status: 500 });
        return base.fetcher(input, init);
      }) as typeof fetch,
    };
    return Effect.gen(function* () {
      yield* setNow(NOW);
      const grants = yield* FleetWorkerGrants.FleetWorkerGrants;
      yield* grants.allow({ machineId: "m1", access: "auto" });
      const result = yield* grants.stop("m1");
      expect(result.remoteSessionKept).toBe(true);
    }).pipe(Effect.provide(makeLayer({ machine })));
  });

  it.effect("rejects an unknown machine", () => {
    const machine = fakeMachine();
    return Effect.gen(function* () {
      const grants = yield* FleetWorkerGrants.FleetWorkerGrants;
      const error = yield* grants.allow({ machineId: "nope", access: "auto" }).pipe(Effect.flip);
      expect(error.reason).toBe("unknown_machine");
    }).pipe(Effect.provide(makeLayer({ machine })));
  });
});
