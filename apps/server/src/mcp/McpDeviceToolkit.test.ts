import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DeviceBootError,
  DeviceHostUnavailableError,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/ai";

import * as AccessRequests from "../access/AccessRequests.ts";
import * as ServerConfig from "../config.ts";
import * as DeviceService from "../device/DeviceService.ts";
import { IosSimulatorSupport } from "../device/iosSimulatorSupport.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpToolAccessTestkit from "./McpToolAccess.testkit.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";

const environmentId = EnvironmentId.make("environment-device-test");
const threadId = ThreadId.make("thread-device-test");
const invocation = (capabilities: ReadonlyArray<McpInvocationContext.McpCapability>) => ({
  environmentId,
  requestNamespace: "provider-session-device-test",
  thread: {
    threadId,
    providerSessionId: "provider-session-device-test",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(capabilities),
  issuedAt: 1,
});
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo: { name: "mcp-test", version: "1.0.0" },
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

const device = {
  hostId: "local",
  id: "UDID-1",
  platform: "ios" as const,
  name: "iPhone 17 Pro",
  version: "iOS 27.0",
  booted: true,
  physical: false,
};
const state = {
  hosts: [
    {
      id: "local",
      kind: "local" as const,
      label: "This machine",
      platforms: [
        { platform: "ios" as const, available: true },
        { platform: "android" as const, available: false, reason: "No SDK" },
      ],
      hubInstalled: true,
      agentDeviceInstalled: true,
    },
  ],
  hostStatus: "ready" as const,
  hostStatuses: { local: { status: "ready" as const } },
  devices: [device],
  sessions: [],
  onboardingCompleted: true,
  agentAccessEnabled: true,
  hubBasePath: "/api/device-hub",
  revision: 1,
};
const png = new Uint8Array(24);
new DataView(png.buffer).setUint32(0, 0x89504e47);
new DataView(png.buffer).setUint32(4, 0x0d0a1a0a);
new DataView(png.buffer).setUint32(12, 0x49484452);
new DataView(png.buffer).setUint32(16, 1206);
new DataView(png.buffer).setUint32(20, 2622);

const layerDeviceServiceMock = Layer.mock(DeviceService.DeviceService)({
  state: Effect.succeed(state),
  list: Effect.succeed(state),
  open: (input) =>
    Effect.succeed({
      threadId: input.threadId,
      hostId: "local",
      deviceId: input.deviceId,
      platform: input.platform,
      openedAt: "2026-09-08T00:00:00.000Z",
    }),
  sessionsForThread: () => Effect.succeed([]),
  screenshot: () => Effect.succeed({ device, png }),
  close: () => Effect.void,
  agentCli: Effect.succeed("/cli"),
  testHost: () => Effect.die("not used"),
  agentTarget: () => Effect.succeed(["--config", "/host.json", "--session", "thread-device"]),
});

/** No device was allowed on an access card; tests grant through the device capability. */
const layerNoAccessGrants = Layer.mock(AccessRequests.AccessRequests)({
  isAllowed: () => Effect.succeed(false),
  hasAnyGrant: () => Effect.succeed(false),
});

const layerTest = McpHttpServer.layerDeviceToolkit.pipe(
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provideMerge(McpToolAccessTestkit.liveThreadsLayer),
  Layer.provideMerge(McpToolAccessTestkit.noProjectsLayer),
  Layer.provideMerge(layerDeviceServiceMock),
  Layer.provideMerge(layerNoAccessGrants),
  Layer.provide(
    ServerConfig.layerTest(process.cwd(), { prefix: "studio-mcp-device-toolkit-test-" }),
  ),
  Layer.provide(NodeServices.layer),
);

it.effect("returns the complete bounded launch diagnostics to the agent", () => {
  const diagnostics =
    "Emulator exited with code 1.\nTry manually: emulator -avd TestPhone\n" + "x".repeat(1_930);
  const failure = new DeviceBootError({
    hostId: "local",
    deviceId: "UDID-1",
    reason: "launch_failed",
    diagnostics: diagnostics.slice(0, 2_000),
    cause: { ok: false, error: diagnostics },
  });
  const failedDevices = Layer.mock(DeviceService.DeviceService)({
    list: Effect.succeed(state),
    agentTarget: () => Effect.succeed([]),
    open: () => Effect.fail(failure),
  });
  return Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const result = yield* server
      .callTool({ name: "device_open", arguments: { platform: "ios" } })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocation(["device"])),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: "text", text: failure.message }]);
  }).pipe(
    Effect.scoped,
    Effect.provide(
      McpHttpServer.layerDeviceToolkit.pipe(
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provideMerge(McpToolAccessTestkit.liveThreadsLayer),
        Layer.provideMerge(McpToolAccessTestkit.noProjectsLayer),
        Layer.provide(failedDevices),
        Layer.provideMerge(layerNoAccessGrants),
        Layer.provide(
          ServerConfig.layerTest(process.cwd(), { prefix: "studio-mcp-boot-error-test-" }),
        ),
        Layer.provide(NodeServices.layer),
      ),
    ),
  );
});

it.effect("registers the device tools and returns the screenshot as image content", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const names = server.tools.map(({ tool }) => tool.name).toSorted();
      expect(names).toEqual(["device_close", "device_list", "device_open", "device_screenshot"]);

      const callWith = (capabilities: ReadonlyArray<McpInvocationContext.McpCapability>) =>
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocation(capabilities));

      const opened = yield* server
        .callTool({ name: "device_open", arguments: { platform: "ios" } })
        .pipe(callWith(["device"]), Effect.provideService(McpSchema.McpServerClient, client));
      expect(opened.isError).toBe(false);
      const openedContent = opened.structuredContent as { quickStart: string };
      expect(openedContent.quickStart).toContain("--udid UDID-1");

      const shot = yield* server
        .callTool({ name: "device_screenshot", arguments: { deviceId: "UDID-1" } })
        .pipe(callWith(["device"]), Effect.provideService(McpSchema.McpServerClient, client));
      expect(shot.isError).toBe(false);
      expect(shot.content.map((entry) => entry.type)).toEqual(["text", "image"]);
      expect(shot.structuredContent).toMatchObject({
        screenshot: { mimeType: "image/png", width: 1206, height: 2622 },
      });

      const denied = yield* server
        .callTool({ name: "device_list", arguments: {} })
        .pipe(callWith(["preview"]), Effect.provideService(McpSchema.McpServerClient, client));
      expect(denied.isError).toBe(true);
    }),
  ).pipe(Effect.provide(layerTest)),
);

it.effect("rejects unavailable agent access before booting or opening a device", () => {
  const layerUnavailable = Layer.mock(DeviceService.DeviceService)({
    list: Effect.succeed(state),
    agentTarget: () =>
      Effect.fail(
        new DeviceHostUnavailableError({ hostId: "local", reason: "Agent access is disabled." }),
      ),
    open: () => Effect.die("Must not boot or register a device when agent access fails"),
  });
  return Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const result = yield* server
      .callTool({ name: "device_open", arguments: { platform: "ios" } })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocation(["device"])),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
    expect(result.isError).toBe(true);
    expect(result.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "text",
          text: expect.stringContaining("Agent access is disabled."),
        }),
      ]),
    );
  }).pipe(
    Effect.scoped,
    Effect.provide(
      McpHttpServer.layerDeviceToolkit.pipe(
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provideMerge(McpToolAccessTestkit.liveThreadsLayer),
        Layer.provideMerge(McpToolAccessTestkit.noProjectsLayer),
        Layer.provide(layerUnavailable),
        Layer.provideMerge(layerNoAccessGrants),
        Layer.provide(NodeServices.layer),
      ),
    ),
  );
});

/**
 * The device toolkit where the thread holds no device grant, recording what
 * agentTarget receives and any access card, which the user answers `answer`.
 */
const consentHarness = (answer: "allowed" | "denied") => {
  const targets: Array<Parameters<DeviceService.DeviceService["Service"]["agentTarget"]>[0]> = [];
  const asked: Array<OrchestratorMcpService.AccessRequestCardInput> = [];
  const opened: Array<string> = [];
  const devices = Layer.mock(DeviceService.DeviceService)({
    state: Effect.succeed(state),
    list: Effect.succeed(state),
    agentCli: Effect.succeed("/cli"),
    agentTarget: (input) =>
      Effect.sync(() => {
        targets.push(input);
        return ["--config", "/host.json", "--session", "thread-device"];
      }),
    open: (input) =>
      Effect.sync(() => {
        opened.push(input.deviceId);
        return {
          threadId: input.threadId,
          hostId: "local",
          deviceId: input.deviceId,
          platform: input.platform,
          openedAt: "2026-09-08T00:00:00.000Z",
        };
      }),
  });
  const layer = McpHttpServer.layerDeviceToolkit.pipe(
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provideMerge(McpToolAccessTestkit.liveThreadsLayer),
    Layer.provideMerge(McpToolAccessTestkit.noProjectsLayer),
    Layer.provide(devices),
    Layer.provideMerge(layerNoAccessGrants),
    Layer.provideMerge(
      Layer.mock(OrchestratorMcpService.OrchestratorMcpService)({
        requestAccess: (_scope, card) =>
          Effect.sync(() => {
            asked.push(card);
            return answer === "allowed"
              ? { status: "allowed" as const, scope: "thread" as const }
              : { status: "denied" as const };
          }),
      }),
    ),
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "studio-mcp-device-consent-" })),
    Layer.provide(NodeServices.layer),
  );
  return { layer, targets, asked, opened };
};

const openDevice = (capabilities: ReadonlyArray<McpInvocationContext.McpCapability>) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    return yield* server
      .callTool({ name: "device_open", arguments: { deviceId: "UDID-1" } })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocation(capabilities)),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
  });

it.effect("opens a device without a card when Agent device access is on", () => {
  const { layer, targets, asked } = consentHarness("denied");
  return Effect.gen(function* () {
    const result = yield* openDevice(["device"]);
    expect(result.isError).toBe(false);
    expect(asked).toHaveLength(0);
    expect(targets).toHaveLength(1);
    expect(targets[0]).not.toHaveProperty("consented");
  }).pipe(Effect.scoped, Effect.provide(layer));
});

it.effect("asks on a card before opening a device without Agent device access", () => {
  const { layer, targets, asked, opened } = consentHarness("allowed");
  return Effect.gen(function* () {
    const result = yield* openDevice(["preview"]);
    expect(result.isError).toBe(false);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({
      accessTitle: "Control iPhone 17 Pro",
      subjects: [{ kind: "device", key: "device:local/udid-1", label: "iPhone 17 Pro" }],
    });
    expect(targets).toEqual([
      expect.objectContaining({ deviceId: "UDID-1", hostId: "local", consented: true }),
    ]);
    expect(opened).toEqual(["UDID-1"]);
  }).pipe(Effect.scoped, Effect.provide(layer));
});

it.effect("opens nothing when the user denies the device", () => {
  const { layer, targets, asked, opened } = consentHarness("denied");
  return Effect.gen(function* () {
    const result = yield* openDevice(["preview"]);
    expect(result.isError).toBe(true);
    expect(result.content.map((part) => ("text" in part ? part.text : "")).join("\n")).toContain(
      "The user did not allow this (Control iPhone 17 Pro)",
    );
    expect(asked).toHaveLength(1);
    expect(targets).toHaveLength(0);
    expect(opened).toHaveLength(0);
  }).pipe(Effect.scoped, Effect.provide(layer));
});

it.effect("a card grant for one device does not reach another device", () => {
  const shots: Array<string> = [];
  const closed: Array<string | undefined> = [];
  const granted = Layer.mock(AccessRequests.AccessRequests)({
    isAllowed: (_threadId, key) => Effect.succeed(key === "device:local/udid-1"),
    hasAnyGrant: (_threadId, kind) => Effect.succeed(kind === "device"),
  });
  const devices = Layer.mock(DeviceService.DeviceService)({
    state: Effect.succeed(state),
    list: Effect.succeed(state),
    sessionsForThread: () =>
      Effect.succeed([
        {
          threadId,
          hostId: "local",
          deviceId: "UDID-2",
          platform: "ios" as const,
          openedAt: "2026-09-08T00:00:00.000Z",
        },
      ] as never),
    screenshot: (input) =>
      Effect.sync(() => {
        shots.push(input.deviceId);
        return { device, png };
      }),
    close: (input) =>
      Effect.sync(() => {
        closed.push(input.deviceId);
      }),
  });
  return Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const call = (name: string, args: Record<string, unknown>) =>
      server
        .callTool({ name, arguments: args })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation([])),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
    const allowed = yield* call("device_screenshot", { deviceId: "UDID-1" });
    expect(allowed.isError).toBe(false);
    const other = yield* call("device_screenshot", { deviceId: "UDID-2" });
    expect(other.isError).toBe(true);
    expect(JSON.stringify(other.content)).toContain("may not use device UDID-2");
    // Without a deviceId the thread's open session is UDID-2, which is not allowed either.
    const latest = yield* call("device_screenshot", {});
    expect(latest.isError).toBe(true);
    const close = yield* call("device_close", {});
    expect(close.isError).toBe(true);
    const listed = yield* call("device_list", {});
    expect(listed.isError).toBe(false);
    expect(shots).toEqual(["UDID-1"]);
    expect(closed).toEqual([]);
  }).pipe(
    Effect.scoped,
    Effect.provide(
      McpHttpServer.layerDeviceToolkit.pipe(
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provideMerge(McpToolAccessTestkit.liveThreadsLayer),
        Layer.provideMerge(McpToolAccessTestkit.noProjectsLayer),
        Layer.provideMerge(devices),
        Layer.provideMerge(granted),
        Layer.provide(
          ServerConfig.layerTest(process.cwd(), { prefix: "studio-mcp-device-grant-test-" }),
        ),
        Layer.provide(NodeServices.layer),
      ),
    ),
  );
});

/**
 * A machine whose own simulator check says `iosSimulators`, with no device
 * host set up and only an Android emulator listed. The local host still
 * reports iOS as available (xcrun is there), which the hint must not trust.
 */
const simulatorHintCall = (machine: {
  os: "linux" | "darwin";
  iosSimulators: boolean;
  /** What the local device host reports for iOS; true unless set. */
  iosHost?: boolean;
}) => {
  const emulator = { ...device, id: "emulator-5554", platform: "android" as const, name: "Pixel" };
  const hosts = state.hosts.map((host) => ({
    ...host,
    platforms: host.platforms.map((platform) =>
      platform.platform === "ios" ? { ...platform, available: machine.iosHost ?? true } : platform,
    ),
  }));
  const listed = { ...state, hosts, devices: [emulator] };
  const devices = Layer.mock(DeviceService.DeviceService)({
    state: Effect.succeed(listed),
    list: Effect.succeed(listed),
    sessionsForThread: () => Effect.succeed([]),
  });
  const call = (name: string, args: Record<string, unknown>) =>
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const result = yield* server
        .callTool({ name, arguments: args })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation(["device"])),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      return {
        isError: result.isError,
        text: result.content.map((part) => ("text" in part ? part.text : "")).join("\n"),
        structured: result.structuredContent as { readonly hint?: string } | undefined,
      };
    });
  const layer = McpHttpServer.layerDeviceToolkit.pipe(
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provideMerge(McpToolAccessTestkit.liveThreadsLayer),
    Layer.provideMerge(McpToolAccessTestkit.noProjectsLayer),
    Layer.provideMerge(devices),
    Layer.provideMerge(layerNoAccessGrants),
    Layer.provideMerge(
      Layer.mock(ServerEnvironment.ServerEnvironment)({
        getDescriptor: Effect.succeed({
          environmentId,
          label: "Test machine",
          platform: { os: machine.os, arch: "x64" },
        } as never),
      }),
    ),
    Layer.provideMerge(
      Layer.succeed(IosSimulatorSupport, { current: () => machine.iosSimulators }),
    ),
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "studio-mcp-device-hint-" })),
    Layer.provide(NodeServices.layer),
  );
  return { call, layer };
};

it.effect("tells a thread at list time and on open that simulators run on a Mac", () => {
  const { call, layer } = simulatorHintCall({ os: "linux", iosSimulators: false });
  return Effect.gen(function* () {
    const listed = yield* call("device_list", {});
    expect(listed.isError).toBe(false);
    expect(listed.structured?.hint).toContain("This machine cannot run iOS Simulators");
    const opened = yield* call("device_open", { platform: "ios" });
    expect(opened.isError).toBe(true);
    expect(opened.text).toContain("No ios devices were found");
    expect(opened.text).toContain("This machine cannot run iOS Simulators");
  }).pipe(Effect.scoped, Effect.provide(layer));
});

it.effect("keeps a mistyped device id error free of the Mac hint", () => {
  const { call, layer } = simulatorHintCall({ os: "linux", iosSimulators: false, iosHost: false });
  return Effect.gen(function* () {
    const opened = yield* call("device_open", { deviceId: "TYPO" });
    expect(opened.isError).toBe(true);
    expect(opened.text).toContain("No device TYPO");
    expect(opened.text).not.toContain("cannot run iOS Simulators");
  }).pipe(Effect.scoped, Effect.provide(layer));
});

it.effect("judges this machine by the same simulator check that places work", () => {
  const working = simulatorHintCall({ os: "darwin", iosSimulators: true });
  const broken = simulatorHintCall({ os: "darwin", iosSimulators: false });
  return Effect.gen(function* () {
    const fine = yield* working
      .call("device_open", { platform: "ios" })
      .pipe(Effect.scoped, Effect.provide(working.layer));
    expect(fine.text).not.toContain("cannot run iOS Simulators");
    // xcrun is there, so the host lists iOS as available, but simctl does not answer.
    const listed = yield* broken
      .call("device_list", {})
      .pipe(Effect.scoped, Effect.provide(broken.layer));
    expect(listed.structured?.hint).toContain("This machine cannot run iOS Simulators");
  });
});
