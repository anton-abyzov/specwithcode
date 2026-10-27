// @effect-diagnostics-next-line nodeBuiltinImport:off -- Native stat verifies actual secret permissions independently of the Effect writer.
import * as NodeFS from "node:fs";
import { nodePath as NodePath } from "../nodePath.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId } from "@specweave-studio/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import { TestClock } from "effect/testing";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import type { FleetConfig, FleetTarget } from "../studioFleet.ts";
import {
  CONNECT_ORIGIN,
  fakeMachine,
  ORIGIN,
  studioToken,
  target,
} from "./fleetMachine.testkit.ts";
import { loadOrCreateFleetProofKey, tokenProofThumbprint } from "./fleetProofKey.ts";
import { type FleetLink, makeFleetLink } from "./fleetTransport.ts";
import * as FleetTargets from "./FleetTargets.ts";
import * as FleetWorkerGrants from "./FleetWorkerGrants.ts";

const NOW = Date.parse("2026-10-12T00:00:00.000Z");

const makeLayer = (input: {
  readonly machine: ReturnType<typeof fakeMachine>;
  readonly target?: FleetTarget;
  readonly logs?: string[];
  readonly link?: FleetLink;
}) => {
  const config: FleetConfig = { version: 1, machines: [input.target ?? target] };
  const layerConfig = ServerConfig.layerTest(process.cwd(), { prefix: "studio-fleet-grants-" });
  return FleetWorkerGrants.layer.pipe(
    Layer.provideMerge(
      Layer.succeed(FleetTargets.FleetTargets, {
        load: Effect.succeed(config),
        fetch: input.machine.fetcher,
        ...(input.link ? { link: input.link } : {}),
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

const changeStoredGrant = (patch: Record<string, unknown>) =>
  Effect.gen(function* () {
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    const bytes = Option.getOrThrow(yield* secrets.get("fleet-worker-grant-m1"));
    const original = JSON.parse(new TextDecoder().decode(bytes));
    yield* secrets.set(
      "fleet-worker-grant-m1",
      new TextEncoder().encode(JSON.stringify({ ...original, ...patch })),
    );
  });

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
  it.effect.each([
    { name: "legacy grant", patch: { v: 1 }, expected: "expired" },
    { name: "missing ongoing consent", patch: { ongoingConsent: false }, expected: "expired" },
    { name: "local revocation", patch: { status: "revoked" }, expected: "revoked" },
    {
      name: "different coordinator",
      patch: { coordinatorEnvironmentId: "another" },
      expected: "not_allowed",
    },
    { name: "different destination", patch: { environmentId: "another" }, expected: "not_allowed" },
    {
      name: "different origin",
      patch: { origin: "https://another.example" },
      expected: "not_allowed",
    },
    {
      name: "different resource",
      patch: { resource: "https://another.example/mcp" },
      expected: "not_allowed",
    },
  ])("does not recover $name", ({ patch, expected }) => {
    const machine = fakeMachine({ sessionTokens: true });
    return Effect.gen(function* () {
      yield* setNow(NOW);
      const grants = yield* FleetWorkerGrants.FleetWorkerGrants;
      yield* grants.allow({ machineId: "m1", access: "auto" });
      yield* changeStoredGrant(patch);
      yield* setNow(NOW + Duration.toMillis(Duration.days(31)));
      yield* grants.renewDue;
      expect((yield* grants.credential("m1").pipe(Effect.flip)).reason).toBe(expected);
      expect(machine.renewed()).toBe(0);
      expect(machine.issued()).toBe(1);
      expect(machine.calls.some((call) => call.url.endsWith("worker-grants/renew"))).toBe(false);
    }).pipe(Effect.provide(makeLayer({ machine })));
  });

  it.effect("mints allowed workers again at a machine's new address with the same access", () => {
    const machine = fakeMachine({ sessionTokens: true });
    return Effect.gen(function* () {
      yield* setNow(NOW);
      const grants = yield* FleetWorkerGrants.FleetWorkerGrants;
      yield* grants.allow({ machineId: "m1", access: "auto-accept-edits" });
      // Allowed while it was relayed through another machine; the fleet file now has its own name.
      yield* changeStoredGrant({
        origin: "https://m4.example.ts.net:8443",
        resource: "https://m4.example.ts.net:8443/mcp",
      });
      yield* setNow(NOW + Duration.toMillis(Duration.minutes(2)));
      const credential = yield* grants.credential("m1");
      expect(credential.target.url).toBe(target.url);
      expect(credential.access).toBe("auto-accept-edits");
      expect(machine.issued()).toBe(2);
      expect((yield* grants.status("m1")).status).toBe("allowed");
    }).pipe(Effect.provide(makeLayer({ machine })));
  });

  it.effect("does not carry a revoked or expired grant to a new address", () => {
    const machine = fakeMachine({ sessionTokens: true });
    return Effect.gen(function* () {
      yield* setNow(NOW);
      const grants = yield* FleetWorkerGrants.FleetWorkerGrants;
      yield* grants.allow({ machineId: "m1", access: "auto" });
      yield* changeStoredGrant({ origin: "https://m4.example.ts.net:8443", status: "revoked" });
      yield* setNow(NOW + Duration.toMillis(Duration.minutes(2)));
      expect((yield* grants.credential("m1").pipe(Effect.flip)).reason).toBe("not_allowed");
      yield* changeStoredGrant({ status: "active", expiresAt: "2026-10-12T00:00:00.000Z" });
      expect((yield* grants.credential("m1").pipe(Effect.flip)).reason).toBe("not_allowed");
      expect(machine.issued()).toBe(1);
    }).pipe(Effect.provide(makeLayer({ machine })));
  });

  it.effect.each([
    { renewalStatus: 409, renewalCode: "grant_revoked" },
    { renewalStatus: 409, renewalCode: "grant_missing" },
    { renewalStatus: 400, renewalCode: "grant_invalid" },
  ])("keeps destination refusal $renewalCode sticky without reminting", (override) => {
    const machine = fakeMachine({ sessionTokens: true, ...override });
    return Effect.gen(function* () {
      yield* setNow(NOW);
      const grants = yield* FleetWorkerGrants.FleetWorkerGrants;
      yield* grants.allow({ machineId: "m1", access: "approval-required" });
      yield* setNow(NOW + Duration.toMillis(Duration.days(31)));
      yield* grants.renewDue;
      expect((yield* grants.status("m1")).status).toBe("revoked");
      yield* setNow(NOW + Duration.toMillis(Duration.days(32)));
      yield* grants.renewDue;
      expect((yield* grants.credential("m1").pipe(Effect.flip)).reason).toBe("revoked");
      expect(machine.calls.filter((call) => call.url.endsWith("worker-grants/renew"))).toHaveLength(
        1,
      );
      expect(machine.issued()).toBe(1);
    }).pipe(Effect.provide(makeLayer({ machine })));
  });

  it.effect.each([401, 403, 404, 503])(
    "backs off after recovery HTTP %s without destroying consent",
    (status) => {
      const base = fakeMachine({ sessionTokens: true });
      let unavailable = true;
      let attempts = 0;
      const machine = {
        ...base,
        fetcher: (async (input, init) => {
          if (String(input).endsWith("worker-grants/renew")) {
            attempts++;
            if (unavailable) return new Response("{}", { status });
          }
          return base.fetcher(input, init);
        }) as typeof fetch,
      };
      return Effect.gen(function* () {
        yield* setNow(NOW);
        const grants = yield* FleetWorkerGrants.FleetWorkerGrants;
        yield* grants.allow({ machineId: "m1", access: "auto" });
        yield* setNow(NOW + Duration.toMillis(Duration.days(31)));
        yield* grants.renewDue;
        expect((yield* grants.credential("m1").pipe(Effect.flip)).reason).toBe("expired");
        yield* grants.renewDue;
        expect(attempts).toBe(1);
        unavailable = false;
        yield* TestClock.adjust(Duration.seconds(61));
        const credential = yield* grants.credential("m1");
        expect(credential.access).toBe("auto");
        expect(attempts).toBe(2);
        expect(base.issued()).toBe(1);
        expect((yield* grants.status("m1")).problem).toBeNull();
      }).pipe(Effect.provide(makeLayer({ machine })));
    },
  );

  it.effect(
    "local stop concurrent with renewal removes consent and revokes the same session",
    () => {
      const base = fakeMachine({ sessionTokens: true });
      let arrived!: () => void;
      let release!: () => void;
      const started = new Promise<void>((resolve) => {
        arrived = resolve;
      });
      const continueRenewal = new Promise<void>((resolve) => {
        release = resolve;
      });
      const machine = {
        ...base,
        fetcher: (async (input, init) => {
          if (String(input).endsWith("worker-grants/renew")) {
            arrived();
            await continueRenewal;
          }
          return base.fetcher(input, init);
        }) as typeof fetch,
      };
      return Effect.gen(function* () {
        yield* setNow(NOW);
        const grants = yield* FleetWorkerGrants.FleetWorkerGrants;
        yield* grants.allow({ machineId: "m1", access: "auto" });
        yield* setNow(NOW + Duration.toMillis(Duration.days(31)));
        yield* Effect.all(
          [
            grants.renewDue,
            Effect.promise(() => started).pipe(
              Effect.tap(() => Effect.sync(release)),
              Effect.andThen(grants.stop("m1")),
            ),
          ],
          { concurrency: "unbounded" },
        );
        expect((yield* grants.status("m1")).status).toBe("not_allowed");
        expect(base.revokedSessions).toContain("sid-1");
        yield* TestClock.adjust(Duration.minutes(2));
        yield* grants.renewDue;
        expect(base.issued()).toBe(1);
        expect(base.renewed()).toBe(1);
      }).pipe(Effect.provide(makeLayer({ machine })));
    },
  );

  it.effect(
    "recovers an explicitly allowed offline machine after expiry and coordinator restart",
    () => {
      const base = fakeMachine({ sessionTokens: true });
      let offline = false;
      const machine = {
        ...base,
        fetcher: (async (input, init) => {
          if (offline) throw new TypeError("offline");
          return base.fetcher(input, init);
        }) as typeof fetch,
      };
      return Effect.gen(function* () {
        yield* setNow(NOW);
        const grants = yield* FleetWorkerGrants.FleetWorkerGrants;
        yield* grants.allow({ machineId: "m1", access: "auto" });
        offline = true;
        yield* setNow(NOW + Duration.toMillis(Duration.days(31)));
        yield* grants.renewDue;
        expect((yield* grants.status("m1")).status).toBe("expired");
        const config = yield* ServerConfig.ServerConfig;
        const restarted = Layer.fresh(FleetWorkerGrants.layer).pipe(
          Layer.provide(
            Layer.succeed(FleetTargets.FleetTargets, {
              load: Effect.succeed({ version: 1 as const, machines: [target] }),
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
        offline = false;
        yield* Effect.gen(function* () {
          const recovered = yield* FleetWorkerGrants.FleetWorkerGrants;
          yield* recovered.renewDue;
          expect((yield* recovered.status("m1")).status).toBe("allowed");
          expect((yield* recovered.credential("m1")).access).toBe("auto");
          expect(base.issued()).toBe(1);
        }).pipe(Effect.provide(restarted));
      }).pipe(Effect.provide(makeLayer({ machine })));
    },
  );

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
      // Windows has no POSIX mode bits; the profile folder's ACL keeps the file private.
      if (process.platform !== "win32") {
        expect(NodeFS.statSync(file).mode & 0o777).toBe(0o600);
        expect(NodeFS.statSync(config.secretsDir).mode & 0o777).toBe(0o700);
      }
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

  it.effect(
    "renews due consent without recent activity and retains the same remote session",
    () => {
      const machine = fakeMachine({ sessionTokens: true });
      return Effect.gen(function* () {
        yield* setNow(NOW);
        const grants = yield* FleetWorkerGrants.FleetWorkerGrants;
        yield* grants.allow({ machineId: "m1", access: "auto" });
        yield* setNow(Date.parse("2026-11-01T00:00:00.000Z"));
        yield* grants.renewDue;
        expect(machine.renewed()).toBe(0);
        yield* setNow(Date.parse("2026-11-07T00:00:00.000Z"));
        const revokedBefore = [...machine.revokedSessions];
        yield* grants.renewDue;
        expect(machine.renewed()).toBe(1);
        expect(machine.issued()).toBe(1);
        expect(machine.revokedSessions).toEqual(revokedBefore);
        expect((yield* grants.credential("m1")).accessToken).toContain(".sig");
      }).pipe(Effect.provide(makeLayer({ machine })));
    },
  );

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

  it.effect("renewal does not rely on listing or revoking old remote sessions", () => {
    const state = { down: false };
    const machine = unreachableClients(fakeMachine({ sessionTokens: true }), state);
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

describe("FleetWorkerGrants over SpecWithCode Connect", () => {
  /** A machine on both addresses with DPoP, and this server's key and bound management token. */
  const connectSetup = async () => {
    const offline = new Set<string>();
    const machine = fakeMachine({
      origins: [ORIGIN, CONNECT_ORIGIN],
      offline,
      dpop: true,
      sessionTokens: true,
    });
    const baseDir = NodeFS.mkdtempSync(NodePath.join(process.cwd(), ".studio-grants-key-"));
    const key = await loadOrCreateFleetProofKey(baseDir);
    const managementToken = studioToken({ sid: "management", jkt: key.thumbprint });
    machine.acceptManagementToken(managementToken);
    const link = makeFleetLink({ fetch: machine.fetcher, baseDir });
    const bound: FleetTarget = { ...target, connectUrl: CONNECT_ORIGIN, managementToken };
    return {
      machine,
      offline,
      key,
      link,
      layer: makeLayer({ machine, target: bound, link }),
      cleanup: () => NodeFS.rmSync(baseDir, { recursive: true, force: true }),
    };
  };

  it.effect("keeps a grant minted on the tailnet when only the Connect address answers", () =>
    Effect.gen(function* () {
      const setup = yield* Effect.promise(connectSetup);
      yield* Effect.gen(function* () {
        yield* setNow(NOW);
        const grants = yield* FleetWorkerGrants.FleetWorkerGrants;
        yield* grants.allow({ machineId: "m1", access: "auto" });
        const minted = yield* grants.credential("m1");
        expect(tokenProofThumbprint(minted.accessToken)).toBe(setup.key.thumbprint);
        setup.offline.add(ORIGIN);
        const later = yield* grants.credential("m1");
        expect(later.accessToken).toBe(minted.accessToken);
        expect(setup.machine.issued()).toBe(1);
      }).pipe(Effect.provide(setup.layer), Effect.ensuring(Effect.sync(setup.cleanup)));
    }),
  );

  it.effect("binds an unbound grant once when the tailnet is down, and revokes the old one", () =>
    Effect.gen(function* () {
      const setup = yield* Effect.promise(connectSetup);
      yield* Effect.gen(function* () {
        yield* setNow(NOW);
        const grants = yield* FleetWorkerGrants.FleetWorkerGrants;
        yield* grants.allow({ machineId: "m1", access: "auto-accept-edits" });
        // A grant from before this server had a key: a plain bearer.
        yield* changeStoredGrant({ accessToken: studioToken({ sid: "old-bearer" }) });
        setup.offline.add(ORIGIN);
        // A call that found the tailnet down forgets it, as the MCP client and handoff calls do.
        setup.link.book.forget(String(target.environmentId), ORIGIN);
        yield* setNow(NOW + Duration.toMillis(Duration.minutes(2)));
        const upgraded = yield* grants.credential("m1");
        expect(tokenProofThumbprint(upgraded.accessToken)).toBe(setup.key.thumbprint);
        expect(upgraded.access).toBe("auto-accept-edits");
        expect(setup.machine.issued()).toBe(2);
        expect(setup.machine.revokedSessions).toContain("old-bearer");
        // The new grant was minted on the Connect address with no bearer sent there.
        const overConnect = setup.machine.calls.filter((call) =>
          call.url.startsWith(CONNECT_ORIGIN),
        );
        expect(overConnect.length).toBeGreaterThan(0);
        expect(overConnect.some((call) => call.authorization?.startsWith("Bearer ") === true)).toBe(
          false,
        );
        // At most once a minute: an unbound grant again right away is left alone.
        yield* changeStoredGrant({ accessToken: studioToken({ sid: "another-bearer" }) });
        yield* grants.credential("m1");
        expect(setup.machine.issued()).toBe(2);
      }).pipe(Effect.provide(setup.layer), Effect.ensuring(Effect.sync(setup.cleanup)));
    }),
  );

  it.effect("leaves an unbound grant alone while the tailnet answers", () =>
    Effect.gen(function* () {
      const setup = yield* Effect.promise(connectSetup);
      yield* Effect.gen(function* () {
        yield* setNow(NOW);
        const grants = yield* FleetWorkerGrants.FleetWorkerGrants;
        yield* grants.allow({ machineId: "m1", access: "auto" });
        const bearer = studioToken({ sid: "old-bearer" });
        yield* changeStoredGrant({ accessToken: bearer });
        yield* setNow(NOW + Duration.toMillis(Duration.minutes(2)));
        expect((yield* grants.credential("m1")).accessToken).toBe(bearer);
        expect(setup.machine.issued()).toBe(1);
      }).pipe(Effect.provide(setup.layer), Effect.ensuring(Effect.sync(setup.cleanup)));
    }),
  );
});
