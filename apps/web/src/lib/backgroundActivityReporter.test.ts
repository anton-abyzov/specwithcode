import { EnvironmentId, WS_METHODS } from "@specweave-studio/contracts";
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ClientActivityClientId } from "@specweave-studio/contracts";
import { vi } from "vite-plus/test";

import {
  appClientId,
  backgroundActivityClientId,
  createActivityReport,
  hostEnvironmentIdOf,
  interactedRecentlyHere,
  noteRealInteraction,
  observeBackgroundActivitySubscription,
  retainedBackgroundScopes,
  wasRecentlyInteracted,
} from "./backgroundActivityReporter.ts";

describe("wasRecentlyInteracted", () => {
  it("expires interaction independently of window focus", () => {
    expect(wasRecentlyInteracted(10_000, 55_000)).toBe(true);
    expect(wasRecentlyInteracted(10_000, 55_001)).toBe(false);
  });

  it("rejects future timestamps", () => {
    expect(wasRecentlyInteracted(10_001, 10_000)).toBe(false);
  });

  it("reads a window as in use only after real input a moment ago", () => {
    noteRealInteraction(null);
    expect(interactedRecentlyHere(10_000)).toBe(false);
    noteRealInteraction(10_000);
    expect(interactedRecentlyHere(55_000)).toBe(true);
    expect(interactedRecentlyHere(55_001)).toBe(false);
    noteRealInteraction(null);
  });

  it.effect("retains an observed subscription until its returned finalizer runs", () =>
    Effect.gen(function* () {
      const environmentId = EnvironmentId.make("environment-observation-test");
      const scope = { type: "vcs-status" as const, cwd: "/repo" };
      const releasePassive = yield* observeBackgroundActivitySubscription({
        environmentId,
        method: WS_METHODS.subscribeVcsStatus,
        input: { cwd: scope.cwd, includeRemote: false },
      });
      expect(retainedBackgroundScopes(environmentId)).toEqual([]);
      const release = yield* observeBackgroundActivitySubscription({
        environmentId,
        method: WS_METHODS.subscribeVcsStatus,
        input: { cwd: scope.cwd },
      });

      expect(retainedBackgroundScopes(environmentId)).toEqual([scope]);

      yield* releasePassive;
      expect(retainedBackgroundScopes(environmentId)).toEqual([scope]);

      yield* release;
      expect(retainedBackgroundScopes(environmentId)).toEqual([]);
    }),
  );

  it.effect("tells the machine which agent's sign-in state is on screen", () =>
    Effect.gen(function* () {
      const environmentId = EnvironmentId.make("environment-sign-in-test");
      const release = yield* observeBackgroundActivitySubscription({
        environmentId,
        method: WS_METHODS.providerAuthSubscribe,
        input: { instanceId: "claudeAgent_work" },
      });
      const again = yield* observeBackgroundActivitySubscription({
        environmentId,
        method: WS_METHODS.providerAuthSubscribe,
        input: { instanceId: "claudeAgent_work" },
      });
      expect(retainedBackgroundScopes(environmentId)).toEqual([
        { type: "provider-status", instanceId: "claudeAgent_work" },
      ]);
      // Two rows for one agent: the signal lasts until the last one is gone.
      yield* release;
      expect(retainedBackgroundScopes(environmentId)).toHaveLength(1);
      yield* again;
      expect(retainedBackgroundScopes(environmentId)).toEqual([]);
    }),
  );

  it.effect("keeps delimiter-containing environment and scope values distinct", () =>
    Effect.gen(function* () {
      const firstEnvironmentId = EnvironmentId.make("a");
      const secondEnvironmentId = EnvironmentId.make("a:vcs-status:b");
      const releaseFirst = yield* observeBackgroundActivitySubscription({
        environmentId: firstEnvironmentId,
        method: WS_METHODS.subscribeVcsStatus,
        input: { cwd: "b:vcs-status:c" },
      });
      const releaseSecond = yield* observeBackgroundActivitySubscription({
        environmentId: secondEnvironmentId,
        method: WS_METHODS.subscribeVcsStatus,
        input: { cwd: "c" },
      });

      expect(retainedBackgroundScopes(firstEnvironmentId)).toEqual([
        { type: "vcs-status", cwd: "b:vcs-status:c" },
      ]);
      expect(retainedBackgroundScopes(secondEnvironmentId)).toEqual([
        { type: "vcs-status", cwd: "c" },
      ]);

      yield* Effect.all([releaseFirst, releaseSecond]);
    }),
  );
});

describe("backgroundActivityClientId", () => {
  const CLIENT_ID_KEY = "specweave-studio.backgroundActivity.clientId";
  const WINDOW_ID_KEY = "specweave-studio.backgroundActivity.windowId";
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  function memoryStorage(initial: Record<string, string> = {}) {
    const values = new Map(Object.entries(initial));
    return {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
    };
  }

  function stubWindow(input: {
    readonly desktop: boolean;
    readonly role: "main" | "project";
    readonly localStorage?: ReturnType<typeof memoryStorage>;
    readonly sessionStorage?: ReturnType<typeof memoryStorage> | null;
  }) {
    const stub = {
      ...(input.desktop ? { desktopBridge: { getWindowRole: () => input.role } } : {}),
      localStorage: input.localStorage ?? memoryStorage({ [CLIENT_ID_KEY]: "stored-client" }),
    };
    if (input.sessionStorage === null) {
      Object.defineProperty(stub, "sessionStorage", {
        get: () => {
          throw new Error("storage blocked");
        },
      });
    } else {
      Object.assign(stub, { sessionStorage: input.sessionStorage ?? memoryStorage() });
    }
    vi.stubGlobal("window", stub);
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps the stored id for the main window and the browser", () => {
    stubWindow({ desktop: true, role: "main" });
    expect(backgroundActivityClientId()).toBe("stored-client");
    stubWindow({ desktop: false, role: "project" });
    expect(backgroundActivityClientId()).toBe("stored-client");
  });

  it("gives a project window its own id that survives a reload", () => {
    const sessionStorage = memoryStorage();
    stubWindow({ desktop: true, role: "project", sessionStorage });
    const clientId = backgroundActivityClientId();
    const [stored, windowId, ...rest] = clientId.split(":");
    expect(stored).toBe("stored-client");
    expect(windowId).toMatch(UUID);
    expect(rest).toEqual([]);
    expect(sessionStorage.getItem(WINDOW_ID_KEY)).toBe(windowId);

    // A reload keeps session storage, so the same window keeps its id.
    stubWindow({ desktop: true, role: "project", sessionStorage });
    expect(backgroundActivityClientId()).toBe(clientId);
  });

  it("separates two project windows that share the stored id", () => {
    stubWindow({ desktop: true, role: "project" });
    const first = backgroundActivityClientId();
    stubWindow({ desktop: true, role: "project" });
    const second = backgroundActivityClientId();
    expect(first).not.toBe(second);
    expect(first.startsWith("stored-client:")).toBe(true);
    expect(second.startsWith("stored-client:")).toBe(true);
  });

  it("keeps one id per window when session storage is unavailable", () => {
    stubWindow({ desktop: true, role: "project", sessionStorage: null });
    const clientId = backgroundActivityClientId();
    expect(clientId.slice("stored-client:".length)).toMatch(UUID);
    expect(backgroundActivityClientId()).toBe(clientId);
  });

  it("stays inside the server's client id limit", () => {
    const decode = Schema.decodeUnknownSync(ClientActivityClientId);
    stubWindow({ desktop: true, role: "project" });
    expect(decode(backgroundActivityClientId())).toHaveLength("stored-client:".length + 36);

    const sessionStorage = memoryStorage();
    stubWindow({
      desktop: true,
      role: "project",
      localStorage: memoryStorage({ [CLIENT_ID_KEY]: "s".repeat(128) }),
      sessionStorage,
    });
    const clientId = backgroundActivityClientId();
    expect(decode(clientId)).toHaveLength(128);
    expect(clientId).toBe(`${"s".repeat(91)}:${sessionStorage.getItem(WINDOW_ID_KEY)}`);
    // Shortening is stable: the same window reports the same id every time.
    expect(backgroundActivityClientId()).toBe(clientId);
  });
});

describe("activity report presence", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubPage() {
    vi.stubGlobal("window", {
      localStorage: {
        getItem: () => "stored-client",
        setItem: () => undefined,
      },
    });
    vi.stubGlobal("document", { visibilityState: "hidden", hasFocus: () => false });
  }

  it("sends the last real interaction and this app's own machine", () => {
    stubPage();
    const environmentId = EnvironmentId.make("env-remote");
    const host = EnvironmentId.make("env-host");
    const report = createActivityReport(environmentId, 1_000, 5_000, {
      lastUserInteractionAtMs: 4_000,
      hostEnvironmentId: host,
    });
    expect(report.hostEnvironmentId).toBe(host);
    expect(report.lastInteractionAt && DateTime.toEpochMillis(report.lastInteractionAt)).toBe(
      4_000,
    );
  });

  it("claims no interaction before the first one, and no host without a primary", () => {
    stubPage();
    const report = createActivityReport(EnvironmentId.make("env-remote"), 1_000, 5_000, {
      lastUserInteractionAtMs: null,
      hostEnvironmentId: null,
    });
    expect("lastInteractionAt" in report).toBe(false);
    expect("hostEnvironmentId" in report).toBe(false);
  });

  it("names the primary entry as this app's machine", () => {
    const primary = EnvironmentId.make("env-primary");
    expect(
      hostEnvironmentIdOf(
        new Map([
          [EnvironmentId.make("env-saved"), { target: { _tag: "SavedConnectionTarget" } }],
          [primary, { target: { _tag: "PrimaryConnectionTarget" } }],
        ]),
      ),
    ).toBe(primary);
    expect(
      hostEnvironmentIdOf(
        new Map([[EnvironmentId.make("env-saved"), { target: { _tag: "SavedConnectionTarget" } }]]),
      ),
    ).toBeNull();
  });

  it("reads every window of one app as that app", () => {
    expect(appClientId("stored-client")).toBe("stored-client");
    expect(appClientId("stored-client:3f0c")).toBe("stored-client");
  });
});
