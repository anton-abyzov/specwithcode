import { assert, beforeEach, describe, it } from "@effect/vitest";
import {
  type AccessRequestSubject,
  accessGrantKey,
  ComputerUseToolError,
  type DeviceSummary,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as ComputerUseBroker from "../computerUse/ComputerUseBroker.ts";
import type { McpThreadInvocationScope } from "../mcp/McpInvocationContext.ts";
import * as OrchestratorMcpService from "../mcp/OrchestratorMcpService.ts";
import type { AccessRequestCardInput } from "../mcp/OrchestratorMcpService.ts";
import * as AccessGate from "./accessGate.ts";
import * as AccessRequests from "./AccessRequests.ts";

const app = (label: string): AccessRequestSubject => ({
  kind: "app",
  key: accessGrantKey("app", label),
  label,
  detail: AccessGate.APP_ACCESS_DETAIL,
});
const device = (label: string): AccessRequestSubject => ({
  kind: "device",
  key: accessGrantKey("device", `local/${label}`),
  label,
  detail: AccessGate.DEVICE_ACCESS_DETAIL,
  platform: "ios",
});

const scope: McpThreadInvocationScope = {
  environmentId: EnvironmentId.make("environment-access-gate"),
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
  requestNamespace: "thread:thread-access-gate",
  thread: {
    threadId: ThreadId.make("thread-access-gate"),
    providerSessionId: "session",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
};

describe("accessTitle", () => {
  it("names apps with Use and devices with Control", () => {
    assert.equal(AccessGate.accessTitle([app("Notes")]), "Use Notes");
    assert.equal(AccessGate.accessTitle([app("Notes"), app("Finder")]), "Use Notes and Finder");
    assert.equal(
      AccessGate.accessTitle([app("Notes"), app("Finder"), app("System Settings")]),
      "Use Notes, Finder and System Settings",
    );
    assert.equal(AccessGate.accessTitle([device("iPhone 17 Pro")]), "Control iPhone 17 Pro");
    assert.equal(
      AccessGate.accessTitle([device("iPhone 17 Pro"), app("Notes")]),
      "Use Notes and control iPhone 17 Pro",
    );
  });
});

describe("ensureAccess", () => {
  const run = (input: {
    readonly allowed: ReadonlyArray<string>;
    readonly subjects: ReadonlyArray<AccessRequestSubject>;
    readonly answer?: {
      readonly status: "allowed" | "denied";
      readonly scope?: "thread" | "machine";
    };
  }) => {
    const asked: Array<AccessRequestCardInput> = [];
    const layer = Layer.mergeAll(
      Layer.mock(AccessRequests.AccessRequests)({
        isAllowed: (_threadId, key) => Effect.succeed(input.allowed.includes(key)),
      }),
      Layer.mock(OrchestratorMcpService.OrchestratorMcpService)({
        requestAccess: (_scope, card) =>
          Effect.sync(() => {
            asked.push(card);
            return input.answer ?? { status: "allowed", scope: "thread" };
          }),
      }),
    );
    return AccessGate.ensureAccess({
      scope,
      subjects: input.subjects,
      reason: "To check the shopping list.",
      timeoutMs: 5_000,
    }).pipe(
      Effect.map((result) => ({ result, asked })),
      Effect.provide(layer),
    );
  };

  it.effect("returns allowed without a card when everything is already allowed", () =>
    Effect.gen(function* () {
      const { result, asked } = yield* run({
        allowed: [app("Notes").key, device("iPhone").key],
        subjects: [app("Notes"), device("iPhone")],
      });
      assert.deepEqual(result, { status: "allowed", asked: false });
      assert.equal(asked.length, 0);
    }),
  );

  it.effect("asks once for only what is missing, each subject once", () =>
    Effect.gen(function* () {
      const { result, asked } = yield* run({
        allowed: [app("Notes").key],
        subjects: [app("Notes"), app("Finder"), app("Finder"), device("iPhone")],
        answer: { status: "allowed", scope: "machine" },
      });
      assert.deepEqual(result, { status: "allowed", asked: true, scope: "machine" });
      assert.equal(asked.length, 1);
      assert.deepEqual(
        asked[0]!.subjects.map((subject) => subject.key),
        [app("Finder").key, device("iPhone").key],
      );
      assert.equal(asked[0]!.accessTitle, "Use Finder and control iPhone");
      assert.equal(asked[0]!.reason, "To check the shopping list.");
      assert.equal(asked[0]!.timeoutMs, 5_000);
    }),
  );

  it.effect("passes a refusal through as asked", () =>
    Effect.gen(function* () {
      const { result } = yield* run({
        allowed: [],
        subjects: [app("Notes")],
        answer: { status: "denied" },
      });
      assert.deepEqual(result, { status: "denied", asked: true });
    }),
  );
});

describe("appSubject", () => {
  beforeEach(() => AccessGate.clearAppSubjectCache());
  const withBroker = (invoke: ComputerUseBroker.ComputerUseBroker["Service"]["invoke"]) =>
    Effect.provide(Layer.mock(ComputerUseBroker.ComputerUseBroker)({ invoke }));

  it.effect("uses the name and icon the desktop app reports", () =>
    Effect.gen(function* () {
      const subject = yield* AccessGate.appSubject("activity monitor").pipe(
        withBroker(() =>
          Effect.succeed({
            platform: "darwin",
            permissions: { screenRecording: true, accessibility: true },
            application: {
              name: "Activity Monitor",
              icon: { mimeType: "image/png", data: "iVBORw0KGgo=" },
            },
          }),
        ),
      );
      assert.deepEqual(subject, {
        kind: "app",
        key: "app:activity monitor",
        label: "Activity Monitor",
        detail: AccessGate.APP_ACCESS_DETAIL,
        icon: { mimeType: "image/png", data: "iVBORw0KGgo=" },
      });
    }),
  );

  it.effect("falls back to the name as given when the desktop app cannot say", () =>
    Effect.gen(function* () {
      const subject = yield* AccessGate.appSubject("  Notes ").pipe(
        withBroker(() =>
          Effect.fail(new ComputerUseToolError({ reason: "The desktop app is not open." })),
        ),
      );
      assert.deepEqual(subject, {
        kind: "app",
        key: "app:notes",
        label: "Notes",
        detail: AccessGate.APP_ACCESS_DETAIL,
      });
    }),
  );
});

describe("appSubject cache", () => {
  beforeEach(() => AccessGate.clearAppSubjectCache());

  it.effect("looks an app up once per ten minutes, by name ignoring case", () =>
    Effect.gen(function* () {
      let lookups = 0;
      const broker = Layer.mock(ComputerUseBroker.ComputerUseBroker)({
        invoke: () =>
          Effect.sync(() => {
            lookups += 1;
            return {
              platform: "darwin",
              permissions: { screenRecording: true, accessibility: true },
              application: { name: "Notes" },
            };
          }),
      });
      const look = (name: string) => AccessGate.appSubject(name).pipe(Effect.provide(broker));
      assert.equal((yield* look("Notes")).label, "Notes");
      assert.equal((yield* look(" notes ")).label, "Notes");
      assert.equal(lookups, 1);
      yield* TestClock.adjust("11 minutes");
      yield* look("Notes");
      assert.equal(lookups, 2);
    }),
  );

  it.effect("does not remember a failed lookup", () =>
    Effect.gen(function* () {
      let lookups = 0;
      const broker = Layer.mock(ComputerUseBroker.ComputerUseBroker)({
        invoke: () =>
          Effect.suspend(() => {
            lookups += 1;
            return Effect.fail(new ComputerUseToolError({ reason: "No desktop app." }));
          }),
      });
      yield* AccessGate.appSubject("Notes").pipe(Effect.provide(broker));
      yield* AccessGate.appSubject("Notes").pipe(Effect.provide(broker));
      assert.equal(lookups, 2);
    }),
  );
});

describe("isSpecWithCodeApp", () => {
  it("matches SpecWithCode in each of its builds and nothing else", () => {
    for (const name of [
      "SpecWithCode",
      " specwithcode ",
      "SpecWithCode (Dev)",
      "SpecWithCode (Nightly)",
      "SpecWithCode Dev",
      "SpecWithCode Preview",
      "SpecWeave Studio (Dev)",
      "SpecWeave Studio (Alpha)",
      "SpecWithCode.app",
    ]) {
      assert.isTrue(AccessGate.isSpecWithCodeApp(name), name);
    }
    for (const name of ["Notes", "SpecWithCodeHelper", "Code", "Visual Studio Code", "Spec"]) {
      assert.isFalse(AccessGate.isSpecWithCodeApp(name), name);
    }
  });
});

describe("deviceSubject", () => {
  it("keys a device by host and id, and names a remote host", () => {
    const base = {
      id: "UDID-1",
      platform: "ios" as const,
      name: "iPhone 17 Pro",
      version: "iOS 27.0",
      booted: true,
      physical: false,
    };
    assert.deepEqual(AccessGate.deviceSubject({ ...base, hostId: "local" } as DeviceSummary), {
      kind: "device",
      key: "device:local/udid-1",
      label: "iPhone 17 Pro",
      detail: AccessGate.DEVICE_ACCESS_DETAIL,
      platform: "ios",
    });
    assert.include(AccessGate.deviceSubject({ ...base, hostId: "m1" } as DeviceSummary), {
      key: "device:m1/udid-1",
      hostLabel: "m1",
    });
  });
});

describe("accessRefusal", () => {
  it("tells the agent not to retry after a denial", () => {
    assert.include(
      AccessGate.accessRefusal("denied", "Use Notes"),
      "did not allow this (Use Notes)",
    );
    assert.include(AccessGate.accessRefusal("timed_out", "Use Notes"), "request_access");
    assert.include(AccessGate.accessRefusal("cancelled", "Use Notes"), "ended before");
  });
});
