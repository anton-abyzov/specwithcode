import {
  type DesktopBridge,
  EnvironmentId,
  RelayClientInstallFailedError,
  type RelayClientInstallProgressEvent,
  type RelayClientStatus,
  WS_METHODS,
} from "@specweave-studio/contracts";
import { RelayWebClientId } from "@specweave-studio/contracts/relay";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient } from "effect/http";
import { afterEach, beforeEach, vi } from "vite-plus/test";
import {
  AVAILABLE_CONNECTION_STATE,
  type PreparedConnection,
  PrimaryConnectionTarget,
  EnvironmentSupervisor,
} from "@specweave-studio/client-runtime/connection";
import { type RpcSession } from "@specweave-studio/client-runtime/rpc";
import { EnvironmentRegistry } from "@specweave-studio/client-runtime/connection";
import { ManagedRelay } from "@specweave-studio/client-runtime/relay";
import { layerRemoteHttpClient } from "@specweave-studio/client-runtime/rpc";
import { __resetDesktopPrimaryAuthForTests } from "../environments/primary/desktopAuth";

import {
  linkPrimaryEnvironmentToCloud,
  readPrimaryCloudLinkState,
  type CloudLinkTarget,
  unlinkPrimaryEnvironmentFromCloud,
  updatePrimaryCloudPreferences,
} from "./linkEnvironment";

const TARGET: CloudLinkTarget = {
  environmentId: "environment-1",
  label: "Desktop",
  httpBaseUrl: "http://127.0.0.1:3000",
  wsBaseUrl: "ws://127.0.0.1:3000",
};

const relayClientInstallDialog = vi.hoisted(() => ({
  requestConfirmation: vi.fn(),
  startInline: vi.fn(),
  reportProgress: vi.fn(),
  finish: vi.fn(),
}));

vi.mock("./relayClientInstallDialog", () => ({
  requestRelayClientInstallConfirmation: relayClientInstallDialog.requestConfirmation,
  startRelayClientInstallInline: relayClientInstallDialog.startInline,
  reportRelayClientInstallProgress: relayClientInstallDialog.reportProgress,
  finishRelayClientInstall: relayClientInstallDialog.finish,
}));

const createProof = vi.fn(() => Effect.succeed("dpop-proof"));
const layerDpopSigner = Layer.succeed(
  ManagedRelay.ManagedRelayDpopSigner,
  ManagedRelay.ManagedRelayDpopSigner.of({
    thumbprint: Effect.succeed("thumbprint"),
    createProof,
  }),
);

function layerRelay() {
  const layerHttp = layerRemoteHttpClient(globalThis.fetch);
  return Layer.mergeAll(
    layerHttp,
    ManagedRelay.layer({
      relayUrl: "https://relay.example.test",
      clientId: RelayWebClientId,
    }).pipe(Layer.provideMerge(layerDpopSigner), Layer.provide(layerHttp)),
  );
}

function layerRegistry(options?: {
  readonly status?: RelayClientStatus | { readonly status: "available"; readonly version: string };
  readonly installEvents?: ReadonlyArray<RelayClientInstallProgressEvent>;
  /** The whole install as the machine streams it, in place of `installEvents`. */
  readonly installStream?: Stream.Stream<RelayClientInstallProgressEvent, unknown>;
}) {
  return Layer.effect(
    EnvironmentRegistry.EnvironmentRegistry,
    Effect.gen(function* () {
      const client = {
        [WS_METHODS.cloudGetRelayClientStatus]: () =>
          Effect.succeed(options?.status ?? { status: "available", version: "2026.6.0" }),
        [WS_METHODS.cloudInstallRelayClient]: () =>
          options?.installStream ?? Stream.fromIterable(options?.installEvents ?? []),
      } as unknown as RpcSession["client"];
      const session: RpcSession = {
        client,
        initialConfig: Effect.never,
        subscribeServerConfig: (input) => client.subscribeServerConfig(input),
        ready: Effect.void,
        probe: Effect.void,
        closed: Effect.never,
      };
      const target = new PrimaryConnectionTarget({
        environmentId: EnvironmentId.make(TARGET.environmentId),
        label: TARGET.label,
        httpBaseUrl: TARGET.httpBaseUrl,
        wsBaseUrl: TARGET.wsBaseUrl,
      });
      const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
        target,
        state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
        session: yield* SubscriptionRef.make(Option.some(session)),
        prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
      const registry = {
        run: <A, E, R>(_environmentId: EnvironmentId, effect: Effect.Effect<A, E, R>) =>
          Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        runStream: <A, E, R>(_environmentId: EnvironmentId, stream: Stream.Stream<A, E, R>) =>
          Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
      } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"];
      return EnvironmentRegistry.EnvironmentRegistry.of(registry);
    }),
  );
}

function layerServices(options?: Parameters<typeof layerRegistry>[0]) {
  return Layer.mergeAll(layerRelay(), layerRegistry(options));
}

function withServices<A, E>(
  effect: Effect.Effect<
    A,
    E,
    | HttpClient.HttpClient
    | ManagedRelay.ManagedRelayClient
    | EnvironmentRegistry.EnvironmentRegistry
  >,
  options?: Parameters<typeof layerRegistry>[0],
) {
  return effect.pipe(Effect.provide(layerServices(options)));
}

function bodyText(body: BodyInit | null | undefined): string {
  return body instanceof Uint8Array ? new TextDecoder().decode(body) : String(body ?? "");
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("VITE_STUDIO_RELAY_URL", "https://relay.example.test");
  relayClientInstallDialog.requestConfirmation.mockResolvedValue(true);
});

afterEach(() => {
  __resetDesktopPrimaryAuthForTests();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("web cloud link environment client", () => {
  it.effect("reads primary cloud link state from the explicit target", () =>
    Effect.gen(function* () {
      const fetchMock = vi.fn().mockResolvedValue(
        Response.json({
          linked: true,
          cloudUserId: "user-1",
          relayUrl: "https://relay.example.test",
          relayIssuer: "https://relay.example.test",
          managedTunnelActive: true,
          publishAgentActivity: false,
        }),
      );
      vi.stubGlobal("fetch", fetchMock);

      const state = yield* withServices(readPrimaryCloudLinkState({ target: TARGET }));

      expect(Option.fromNullishOr(state)).toEqual(
        Option.some({
          linked: true,
          cloudUserId: "user-1",
          relayUrl: "https://relay.example.test",
          relayIssuer: "https://relay.example.test",
          managedTunnelActive: true,
          publishAgentActivity: false,
        }),
      );
      expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
        "http://127.0.0.1:3000/api/connect/link-state",
      );
    }),
  );

  it.effect("uses desktop bearer auth for primary cloud link state", () =>
    Effect.gen(function* () {
      const fetchMock = vi.fn().mockResolvedValue(
        Response.json({
          linked: true,
          cloudUserId: "user-1",
          relayUrl: "https://relay.example.test",
          relayIssuer: "https://relay.example.test",
          managedTunnelActive: true,
          publishAgentActivity: false,
        }),
      );
      vi.stubGlobal("fetch", fetchMock);
      vi.stubGlobal("window", {
        location: { origin: "studio://app" },
        desktopBridge: {
          getLocalEnvironmentBearerToken: vi.fn().mockResolvedValue("desktop-bearer-token"),
        } as unknown as DesktopBridge,
      });

      yield* withServices(readPrimaryCloudLinkState({ target: TARGET }));

      const request = new Request(fetchMock.mock.calls[0]?.[0], fetchMock.mock.calls[0]?.[1]);
      expect(request.credentials).not.toBe("include");
      expect(request.headers.get("authorization")).toBe("Bearer desktop-bearer-token");
    }),
  );

  it.effect("updates agent activity publishing for the explicit primary target", () =>
    Effect.gen(function* () {
      const fetchMock = vi.fn().mockResolvedValue(
        Response.json({
          linked: true,
          cloudUserId: "user-1",
          relayUrl: "https://relay.example.test",
          relayIssuer: "https://relay.example.test",
          managedTunnelActive: true,
          publishAgentActivity: true,
        }),
      );
      vi.stubGlobal("fetch", fetchMock);

      const state = yield* withServices(
        updatePrimaryCloudPreferences({
          target: TARGET,
          publishAgentActivity: true,
        }),
      );

      expect(state.publishAgentActivity).toBe(true);
      expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
        "http://127.0.0.1:3000/api/connect/preferences",
      );
      expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("POST");
      expect(JSON.parse(bodyText(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
        publishAgentActivity: true,
      });
    }),
  );

  it.effect("links an available primary environment without invoking installation", () =>
    Effect.gen(function* () {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          Response.json({
            challenge: "challenge",
            expiresAt: "2026-06-06T00:05:00.000Z",
          }),
        )
        .mockResolvedValueOnce(Response.json("signed-proof"))
        .mockResolvedValueOnce(
          Response.json({
            ok: true,
            environmentId: TARGET.environmentId,
            endpoint: {
              httpBaseUrl: "https://desktop.example.test",
              wsBaseUrl: "wss://desktop.example.test",
              providerKind: "cloudflare_tunnel",
            },
            endpointRuntime: null,
            relayIssuer: "https://relay.example.test",
            cloudUserId: "user-1",
            environmentCredential: "environment-credential",
            cloudMintPublicKey: "public-key",
          }),
        )
        .mockResolvedValueOnce(
          Response.json({ ok: true, endpointRuntimeStatus: { status: "configured" } }),
        );
      vi.stubGlobal("fetch", fetchMock);

      yield* withServices(
        linkPrimaryEnvironmentToCloud({
          target: TARGET,
          clerkToken: "clerk-token",
        }),
      );

      expect(relayClientInstallDialog.requestConfirmation).not.toHaveBeenCalled();
      expect(String(fetchMock.mock.calls[1]?.[0])).toBe(
        "http://127.0.0.1:3000/api/connect/link-proof",
      );
      expect(JSON.parse(bodyText(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({
        challenge: "challenge",
        endpoint: {
          httpBaseUrl: TARGET.httpBaseUrl,
          wsBaseUrl: TARGET.wsBaseUrl,
        },
      });
    }),
  );

  it.effect("links publish-only without a managed tunnel", () =>
    Effect.gen(function* () {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          Response.json({
            challenge: "challenge",
            expiresAt: "2026-06-06T00:05:00.000Z",
          }),
        )
        .mockResolvedValueOnce(Response.json("signed-proof"))
        .mockResolvedValueOnce(
          Response.json({
            ok: true,
            environmentId: TARGET.environmentId,
            endpoint: {
              httpBaseUrl: TARGET.httpBaseUrl,
              wsBaseUrl: TARGET.wsBaseUrl,
              providerKind: "manual",
            },
            endpointRuntime: null,
            relayIssuer: "https://relay.example.test",
            cloudUserId: "user-1",
            environmentCredential: "environment-credential",
            cloudMintPublicKey: "public-key",
          }),
        )
        .mockResolvedValueOnce(
          Response.json({ ok: true, endpointRuntimeStatus: { status: "disabled" } }),
        );
      vi.stubGlobal("fetch", fetchMock);

      yield* withServices(
        linkPrimaryEnvironmentToCloud({
          target: TARGET,
          clerkToken: "clerk-token",
          mode: "publish_only",
        }),
      );

      expect(JSON.parse(bodyText(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
        managedTunnelsEnabled: false,
      });
      expect(JSON.parse(bodyText(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({
        endpoint: { providerKind: "manual" },
      });
    }),
  );

  it.effect("installs a missing relay client before linking", () =>
    Effect.gen(function* () {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ malformed: true })));

      yield* withServices(
        linkPrimaryEnvironmentToCloud({
          target: TARGET,
          clerkToken: "clerk-token",
        }),
        {
          status: { status: "available", version: "2026.6.0" },
          installEvents: [],
        },
      ).pipe(Effect.flip);

      expect(relayClientInstallDialog.requestConfirmation).not.toHaveBeenCalled();
    }),
  );

  const INSTALLED: RelayClientStatus = {
    status: "available",
    executablePath: "/tools/cloudflared",
    source: "managed",
    version: "2026.6.0",
  };
  const INSTALL_EVENTS: ReadonlyArray<RelayClientInstallProgressEvent> = [
    { type: "progress", stage: "downloading" },
    { type: "complete", status: INSTALLED },
  ];

  it.effect("asks before installing a relay client the machine lacks", () =>
    Effect.gen(function* () {
      const fetchMock = vi.fn().mockResolvedValue(Response.json({ malformed: true }));
      vi.stubGlobal("fetch", fetchMock);

      yield* withServices(linkPrimaryEnvironmentToCloud({ target: TARGET, clerkToken: "t" }), {
        status: { status: "missing", version: "2026.6.0" },
        installEvents: INSTALL_EVENTS,
      }).pipe(Effect.flip);

      expect(relayClientInstallDialog.requestConfirmation).toHaveBeenCalledExactlyOnceWith(
        "2026.6.0",
      );
      expect(relayClientInstallDialog.startInline).not.toHaveBeenCalled();
      expect(relayClientInstallDialog.reportProgress).toHaveBeenCalledWith({
        type: "progress",
        stage: "downloading",
      });
      expect(relayClientInstallDialog.finish).toHaveBeenCalledOnce();
      // The install finished, so the link went on to the relay.
      expect(fetchMock).toHaveBeenCalled();
    }),
  );

  it.effect("stops, and reaches no relay, when the question is declined", () =>
    Effect.gen(function* () {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      relayClientInstallDialog.requestConfirmation.mockResolvedValue(false);

      const error = yield* withServices(
        linkPrimaryEnvironmentToCloud({ target: TARGET, clerkToken: "t" }),
        { status: { status: "missing", version: "2026.6.0" }, installEvents: INSTALL_EVENTS },
      ).pipe(Effect.flip);

      expect(error.message).toBe("Relay client installation was cancelled.");
      expect(fetchMock).not.toHaveBeenCalled();
    }),
  );

  // First-run setup has no dialog on screen that could ask: a question there would never be
  // answered and the link would wait for good. The caller that agreed installs straight away.
  it.effect("installs with no question for a caller the person already agreed with", () =>
    Effect.gen(function* () {
      const fetchMock = vi.fn().mockResolvedValue(Response.json({ malformed: true }));
      vi.stubGlobal("fetch", fetchMock);
      // A question nobody could answer: it must not be asked.
      relayClientInstallDialog.requestConfirmation.mockReturnValue(new Promise(() => {}));

      yield* withServices(
        linkPrimaryEnvironmentToCloud({
          target: TARGET,
          clerkToken: "t",
          relayClientInstall: "agreed",
        }),
        { status: { status: "missing", version: "2026.6.0" }, installEvents: INSTALL_EVENTS },
      ).pipe(Effect.flip);

      expect(relayClientInstallDialog.requestConfirmation).not.toHaveBeenCalled();
      expect(relayClientInstallDialog.startInline).toHaveBeenCalledExactlyOnceWith("2026.6.0");
      expect(relayClientInstallDialog.reportProgress).toHaveBeenCalledWith({
        type: "progress",
        stage: "downloading",
      });
      expect(relayClientInstallDialog.finish).toHaveBeenCalledOnce();
      expect(fetchMock).toHaveBeenCalled();
    }),
  );

  it.effect("says what the machine reported when the install fails", () =>
    Effect.gen(function* () {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      const error = yield* withServices(
        linkPrimaryEnvironmentToCloud({
          target: TARGET,
          clerkToken: "t",
          relayClientInstall: "agreed",
        }),
        {
          status: { status: "missing", version: "2026.6.0" },
          installStream: Stream.fail(
            new RelayClientInstallFailedError({
              reason: "download_failed",
              message: "Could not download the relay client.",
            }),
          ),
        },
      ).pipe(Effect.flip);

      expect(error.message).toBe(
        "Could not install the relay client: Could not download the relay client.",
      );
      expect(relayClientInstallDialog.finish).toHaveBeenCalledOnce();
      expect(fetchMock).not.toHaveBeenCalled();
    }),
  );

  it.effect("gives up on an install that never ends, with a reason", () =>
    Effect.gen(function* () {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      const fiber = yield* withServices(
        linkPrimaryEnvironmentToCloud({
          target: TARGET,
          clerkToken: "t",
          relayClientInstall: "agreed",
        }),
        {
          status: { status: "missing", version: "2026.6.0" },
          // A download on a network that accepts the connection and never answers.
          installStream: Stream.concat(
            Stream.make({ type: "progress", stage: "downloading" } as const),
            Stream.never,
          ),
        },
      ).pipe(Effect.flip, Effect.forkChild);

      yield* TestClock.adjust("4 minutes");
      expect(relayClientInstallDialog.finish).not.toHaveBeenCalled();
      yield* TestClock.adjust("2 minutes");
      const error = yield* Fiber.join(fiber);

      expect(error.message).toBe(
        "Installing the relay client took longer than 5 minutes. Check this machine's internet connection, then try again.",
      );
      expect(relayClientInstallDialog.finish).toHaveBeenCalledOnce();
      expect(fetchMock).not.toHaveBeenCalled();
    }),
  );

  it.effect("fails with a reason when an agreed install cannot start", () =>
    Effect.gen(function* () {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      relayClientInstallDialog.startInline.mockImplementationOnce(() => {
        throw new Error("another install is on screen");
      });

      const error = yield* withServices(
        linkPrimaryEnvironmentToCloud({
          target: TARGET,
          clerkToken: "t",
          relayClientInstall: "agreed",
        }),
        { status: { status: "missing", version: "2026.6.0" }, installEvents: INSTALL_EVENTS },
      ).pipe(Effect.flip);

      expect(error.message).toBe("Could not start relay client installation.");
      expect(fetchMock).not.toHaveBeenCalled();
    }),
  );

  it.effect("unlinks locally before revoking the relay record", () =>
    Effect.gen(function* () {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          Response.json({ ok: true, endpointRuntimeStatus: { status: "disabled" } }),
        )
        .mockResolvedValueOnce(Response.json({ ok: true }));
      vi.stubGlobal("fetch", fetchMock);

      yield* withServices(
        unlinkPrimaryEnvironmentFromCloud({
          target: TARGET,
          clerkToken: "clerk-token",
        }),
      );

      expect(String(fetchMock.mock.calls[0]?.[0])).toBe("http://127.0.0.1:3000/api/connect/unlink");
      expect(String(fetchMock.mock.calls[1]?.[0])).toContain(
        `/v1/client/environment-links/${TARGET.environmentId}`,
      );
    }),
  );
});
