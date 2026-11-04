import { assert, describe, it } from "@effect/vitest";
import {
  ComputerUseToolError,
  type DeviceSummary,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as AccessRequests from "../../../access/AccessRequests.ts";
import * as ComputerUseBroker from "../../../computerUse/ComputerUseBroker.ts";
import * as DeviceService from "../../../device/DeviceService.ts";
import type { McpInvocationScope } from "../../McpInvocationContext.ts";
import * as OrchestratorMcpService from "../../OrchestratorMcpService.ts";
import type { AccessRequestCardInput } from "../../OrchestratorMcpService.ts";
import { findDevice, requestAccess } from "./requestAccess.ts";

const device = (overrides: Partial<DeviceSummary>): DeviceSummary =>
  ({
    hostId: "local",
    id: "UDID-1",
    platform: "ios",
    name: "iPhone 17 Pro",
    version: "iOS 27.0",
    booted: true,
    physical: false,
    ...overrides,
  }) as DeviceSummary;

const devices = [
  device({}),
  device({ id: "UDID-2", name: "iPad Air" }),
  device({ hostId: "m1", id: "UDID-3", name: "iPhone 17 Pro" }),
];

describe("findDevice", () => {
  it("finds a device by id on this machine", () => {
    assert.equal(findDevice(devices, { deviceId: "UDID-2" })?.name, "iPad Air");
  });

  it("finds a device by name, ignoring case and spaces", () => {
    assert.equal(findDevice(devices, { deviceId: "  iphone 17 PRO " })?.id, "UDID-1");
    assert.equal(findDevice(devices, { deviceId: "iPhone 17 Pro", hostId: "m1" })?.id, "UDID-3");
  });

  it("finds nothing on another host", () => {
    assert.isUndefined(findDevice(devices, { deviceId: "UDID-2", hostId: "m1" }));
    assert.isUndefined(findDevice(devices, { deviceId: "UDID-3" }));
    assert.isUndefined(findDevice(devices, { deviceId: "Pixel 9" }));
  });
});

describe("requestAccess", () => {
  const scope: McpInvocationScope = {
    environmentId: EnvironmentId.make("environment-request-access"),
    capabilities: new Set(["orchestration"]),
    issuedAt: 1,
    requestNamespace: "thread:thread-request-access",
    thread: {
      threadId: ThreadId.make("thread-request-access"),
      providerSessionId: "session",
      providerInstanceId: ProviderInstanceId.make("codex"),
    },
    client: undefined,
  };

  const layer = (allowed: ReadonlyArray<string>, asked: Array<AccessRequestCardInput>) =>
    Layer.mergeAll(
      Layer.mock(AccessRequests.AccessRequests)({
        isAllowed: (_threadId, key) => Effect.succeed(allowed.includes(key)),
      }),
      Layer.mock(OrchestratorMcpService.OrchestratorMcpService)({
        requestAccess: (_scope, card) =>
          Effect.sync(() => {
            asked.push(card);
            return { status: "allowed" as const, scope: "machine" as const };
          }),
      }),
      Layer.mock(ComputerUseBroker.ComputerUseBroker)({
        invoke: () => Effect.fail(new ComputerUseToolError({ reason: "No desktop app." })),
      }),
      Layer.mock(DeviceService.DeviceService)({
        state: Effect.succeed({ devices } as never),
      }),
    );

  it.effect("refuses a request that names nothing", () =>
    Effect.gen(function* () {
      const asked: Array<AccessRequestCardInput> = [];
      const error = yield* requestAccess(scope, { reason: "To help.", apps: [], devices: [] }).pipe(
        Effect.flip,
        Effect.provide(layer([], asked)),
      );
      assert.equal(error.code, "invalid_request");
      const none = yield* requestAccess(scope, { reason: "To help." }).pipe(
        Effect.flip,
        Effect.provide(layer([], asked)),
      );
      assert.equal(none.code, "invalid_request");
      assert.equal(asked.length, 0);
    }),
  );

  it.effect("refuses a caller outside a thread", () =>
    Effect.gen(function* () {
      const error = yield* requestAccess(
        { ...scope, thread: undefined },
        { reason: "To help.", apps: ["Notes"] },
      ).pipe(Effect.flip, Effect.provide(layer([], [])));
      assert.equal(error.code, "thread_credential_required");
    }),
  );

  it.effect("refuses a device that is not there and shows no card", () =>
    Effect.gen(function* () {
      const asked: Array<AccessRequestCardInput> = [];
      const error = yield* requestAccess(scope, {
        reason: "To test the app.",
        apps: ["Notes"],
        devices: [{ deviceId: "UDID-1", hostId: "m1" }],
      }).pipe(Effect.flip, Effect.provide(layer([], asked)));
      assert.equal(error.code, "invalid_request");
      assert.include(error.message, "No device UDID-1 on host m1");
      assert.equal(asked.length, 0);
    }),
  );

  it.effect("asks once for apps and devices and reports what was allowed", () =>
    Effect.gen(function* () {
      const asked: Array<AccessRequestCardInput> = [];
      const result = yield* requestAccess(scope, {
        reason: "To test sharing a note.",
        apps: ["Notes"],
        devices: [{ deviceId: "ipad air" }],
        clientRequestId: "share-note",
      }).pipe(Effect.provide(layer([], asked)));
      assert.deepEqual(result, {
        status: "allowed",
        scope: "machine",
        allowed: ["Notes", "iPad Air"],
      });
      assert.equal(asked.length, 1);
      assert.equal(asked[0]!.accessTitle, "Use Notes and control iPad Air");
      assert.equal(asked[0]!.clientRequestId, "share-note");
      assert.deepEqual(
        asked[0]!.subjects.map((subject) => subject.key),
        ["app:notes", "device:local/udid-2"],
      );
    }),
  );

  it.effect("says so, without a card, when everything was already allowed", () =>
    Effect.gen(function* () {
      const asked: Array<AccessRequestCardInput> = [];
      const result = yield* requestAccess(scope, {
        reason: "To read a note.",
        apps: ["Notes"],
      }).pipe(Effect.provide(layer(["app:notes"], asked)));
      assert.deepEqual(result, {
        status: "allowed",
        allowed: ["Notes"],
        note: "Everything you asked for was already allowed.",
      });
      assert.equal(asked.length, 0);
    }),
  );

  it.effect("refuses to grant SpecWithCode itself, in any of its builds", () =>
    Effect.gen(function* () {
      const asked: Array<AccessRequestCardInput> = [];
      for (const name of ["SpecWithCode", "specwithcode (Dev)", "Notes"]) {
        const apps = name === "Notes" ? ["Notes", "SpecWithCode Preview"] : [name];
        const error = yield* requestAccess(scope, { reason: "To answer my card.", apps }).pipe(
          Effect.flip,
          Effect.provide(layer([], asked)),
        );
        assert.equal(error.code, "invalid_request");
        assert.include(error.message, "cannot answer their own access requests");
      }
      assert.equal(asked.length, 0);
    }),
  );
});
