/**
 * Which address an invitation carries, and that nothing is minted before an
 * address is settled: Tailscale (v1 line with a management token), SpecWithCode
 * Connect (v2 line with a one-time credential), or both.
 */
import { AuthSessionId, EnvironmentId } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { ChildProcessSpawner } from "effect/process";

import * as Auth from "./auth/EnvironmentAuth.ts";
import {
  FLEET_INVITE_SCOPES,
  fleetInviteProblem,
  issueFleetInvitation,
  parseFleetRedeemSubject,
  type FleetInviteVia,
} from "./studioFleetInvite.ts";
import { decodeFleetJoinCode } from "./studioFleetJoin.ts";

const SELF = "env-worker";
const PRIMARY = EnvironmentId.make("env-primary");
const TAILNET = "https://worker.tailnet.ts.net";
const CONNECT = "https://prod-0123456789abcdef.spec-weave.com";

const descriptor = (environmentId: string) => ({
  environmentId,
  label: "Worker",
  platform: { os: "darwin", arch: "arm64" },
  serverVersion: "0.1.0-test",
  orchestrationProtocolVersion: 2,
  capabilities: { repositoryIdentity: true },
});

const encoder = new TextEncoder();
/** `tailscale`: missing when `status` is null; Serve maps the tailnet name once called. */
function tailscaleFake(status: string | null) {
  const spawns: Array<ReadonlyArray<string>> = [];
  const layer = ChildProcessSpawner.ChildProcessSpawner.of(
    ChildProcessSpawner.make((command) => {
      const { args } = command as unknown as { readonly args: ReadonlyArray<string> };
      spawns.push(args);
      if (status === null)
        return Effect.fail(
          PlatformError.systemError({
            _tag: "NotFound",
            module: "ChildProcess",
            method: "spawn",
            cause: new Error("not installed"),
          }),
        );
      return Effect.succeed(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.make(encoder.encode(args[0] === "status" ? status : "")),
          stderr: Stream.make(encoder.encode("")),
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        }),
      );
    }),
  );
  return { spawner: layer, spawns };
}
const running = JSON.stringify({
  BackendState: "Running",
  Self: { DNSName: "worker.tailnet.ts.net.", TailscaleIPs: [] },
});

/** What the invitation asked this machine's auth for. */
function authFake() {
  const sessions: Array<Record<string, unknown>> = [];
  const pairings: Array<Record<string, unknown>> = [];
  const service = Auth.EnvironmentAuth.of({
    issueSession: (input?: object) =>
      Effect.sync(() => {
        sessions.push({ ...input });
        return {
          sessionId: AuthSessionId.make("synthetic-invite-session"),
          token: "synthetic-invite-token",
          method: "bearer-access-token" as const,
          client: {} as never,
          expiresAt: DateTime.makeUnsafe(Date.parse("2027-10-26T00:00:00.000Z")),
        } as never;
      }),
    createPairingLink: (input?: {
      readonly scopes?: ReadonlyArray<string>;
      readonly subject?: string;
    }) =>
      Effect.sync(() => {
        pairings.push({ ...input });
        return {
          id: "synthetic-pairing",
          credential: "synthetic-redeem-credential",
          scopes: input?.scopes ?? [],
          subject: input?.subject ?? "one-time-token",
          createdAt: DateTime.makeUnsafe(Date.parse("2026-10-26T00:00:00.000Z")),
          expiresAt: DateTime.makeUnsafe(Date.parse("2026-10-27T00:00:00.000Z")),
        };
      }),
  } as unknown as Auth.EnvironmentAuth["Service"]);
  return { service, sessions, pairings };
}

/**
 * Runs an invitation. `tailnetUp` makes the tailnet name answer as this
 * machine once Serve maps it; `connectAnswers` is who the Connect address
 * answers as (null: it does not answer).
 */
async function invite(input: {
  readonly via?: FleetInviteVia | undefined;
  readonly tailscale: string | null;
  readonly connectOrigin: string | null;
  readonly connectAnswers?: string | null | undefined;
  readonly days?: number;
}) {
  const auth = authFake();
  const tailscale = tailscaleFake(input.tailscale);
  const fetched: string[] = [];
  const fetcher = (async (url: string | URL | Request) => {
    const target = new URL(String(url));
    fetched.push(target.origin);
    if (target.origin === TAILNET && tailscale.spawns.some((args) => args[0] === "serve"))
      return Response.json(descriptor(SELF));
    if (target.origin === CONNECT && input.connectAnswers !== null)
      return Response.json(descriptor(input.connectAnswers ?? SELF));
    throw new TypeError("unreachable");
  }) as typeof fetch;
  const result = await Effect.runPromise(
    issueFleetInvitation({
      environmentId: SELF,
      coordinatorEnvironmentId: PRIMARY,
      ownLabel: "Worker",
      state: { host: "127.0.0.1", port: 8319 },
      servePort: 443,
      ...(input.via === undefined ? {} : { via: input.via }),
      ...(input.days === undefined ? {} : { ttl: Duration.days(input.days) }),
      readConnectOrigin: Effect.succeed(input.connectOrigin),
      fetch: fetcher,
    }).pipe(
      Effect.result,
      Effect.provideService(Auth.EnvironmentAuth, auth.service),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, tailscale.spawner),
      Effect.provide(
        FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetcher))),
      ),
    ),
  );
  return { result, auth, tailscale, fetched };
}

describe("fleet invitation over SpecWithCode Connect", () => {
  it("without Tailscale, carries the Connect address and a one-time credential, no bearer", async () => {
    const { result, auth } = await invite({
      via: "auto",
      tailscale: null,
      connectOrigin: CONNECT,
      days: 30,
    });
    expect(result._tag).toBe("Success");
    if (result._tag !== "Success") return;
    const { invitation } = result.success;
    expect(invitation).toMatchObject({
      url: CONNECT,
      pairingId: "synthetic-pairing",
      redeemBy: "2026-10-27T00:00:00.000Z",
    });
    expect(invitation.connectUrl).toBeUndefined();
    expect(invitation.sessionId).toBeUndefined();
    expect(decodeFleetJoinCode(invitation.code)).toEqual({
      v: 2,
      url: CONNECT,
      environmentId: SELF,
      label: "Worker",
      redeem: "synthetic-redeem-credential",
    });
    expect(invitation.code).not.toContain("synthetic-invite-token");
    expect(auth.sessions).toEqual([]);
    expect(auth.pairings).toHaveLength(1);
    expect(auth.pairings[0]).toMatchObject({
      principal: { kind: "coordinator", environmentId: PRIMARY },
      scopes: [...FLEET_INVITE_SCOPES],
    });
    expect(parseFleetRedeemSubject(String(auth.pairings[0]!.subject))).toBe(30);
    expect(Duration.toHours(auth.pairings[0]!.ttl as Duration.Duration)).toBe(1);
  });

  it("carries both addresses, tailnet first, when both work", async () => {
    const { result } = await invite({ via: "auto", tailscale: running, connectOrigin: CONNECT });
    expect(result._tag).toBe("Success");
    if (result._tag !== "Success") return;
    expect(decodeFleetJoinCode(result.success.invitation.code)).toMatchObject({
      v: 2,
      url: TAILNET,
      connectUrl: CONNECT,
    });
    expect(result.success.invitation).toMatchObject({ url: TAILNET, connectUrl: CONNECT });
  });

  it("makes the original line when only Tailscale works, or when asked for Tailscale", async () => {
    for (const run of [
      await invite({ via: "auto", tailscale: running, connectOrigin: null }),
      await invite({ via: "tailscale", tailscale: running, connectOrigin: CONNECT }),
      await invite({ tailscale: running, connectOrigin: CONNECT }),
    ]) {
      expect(run.result._tag).toBe("Success");
      if (run.result._tag !== "Success") continue;
      expect(decodeFleetJoinCode(run.result.success.invitation.code)).toEqual({
        url: TAILNET,
        environmentId: SELF,
        label: "Worker",
        managementToken: "synthetic-invite-token",
      });
      expect(run.result.success.invitation.sessionId).toBe("synthetic-invite-session");
      expect(run.auth.pairings).toEqual([]);
    }
  });

  it("legacy and Tailscale-only requests never look at Connect", async () => {
    const legacy = await invite({ tailscale: running, connectOrigin: CONNECT });
    expect(legacy.fetched).not.toContain(CONNECT);
  });

  it("mints nothing when no address can be used", async () => {
    const cases = [
      {
        via: "connect" as const,
        tailscale: running,
        connectOrigin: null,
        reason: "connect_not_linked",
      },
      { via: "auto" as const, tailscale: null, connectOrigin: null, reason: "connect_not_linked" },
      {
        via: "auto" as const,
        tailscale: null,
        connectOrigin: CONNECT,
        connectAnswers: null,
        reason: "connect_unreachable",
      },
      // An address that answers as another machine is not this machine's.
      {
        via: "connect" as const,
        tailscale: null,
        connectOrigin: CONNECT,
        connectAnswers: "env-other",
        reason: "connect_unreachable",
      },
      {
        via: "tailscale" as const,
        tailscale: null,
        connectOrigin: CONNECT,
        reason: "tailscale_missing",
      },
      { via: undefined, tailscale: null, connectOrigin: CONNECT, reason: "tailscale_missing" },
    ];
    for (const { reason, ...input } of cases) {
      const run = await invite(input);
      expect(run.result._tag, JSON.stringify(input)).toBe("Failure");
      if (run.result._tag !== "Failure") continue;
      const problem = fleetInviteProblem(run.result.failure as never);
      expect(problem.reason, JSON.stringify(input)).toBe(reason);
      expect(run.auth.sessions).toEqual([]);
      expect(run.auth.pairings).toEqual([]);
    }
  });

  it("names the Tailscale problem too when neither address works", async () => {
    const run = await invite({ via: "auto", tailscale: null, connectOrigin: null });
    expect(run.result._tag).toBe("Failure");
    if (run.result._tag !== "Failure") return;
    const problem = fleetInviteProblem(run.result.failure as never);
    expect(problem.message).toContain("SpecWithCode Connect");
    expect(problem.message).toContain("Tailscale is not installed");
  });
});
