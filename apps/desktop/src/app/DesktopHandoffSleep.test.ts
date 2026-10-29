import { assert, describe, it } from "@effect/vitest";
import { COORDINATOR_SUSPEND_PATH } from "@specweave-studio/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import {
  HANDOFF_SLEEP_ACTION,
  notifyServerOfSuspend,
  registerHandoffSleepNotice,
} from "./DesktopHandoffSleep.ts";

class NoWindow extends Data.TaggedError("NoWindow")<{}> {}

type PowerEvent = "lock-screen" | "unlock-screen" | "on-ac" | "on-battery" | "suspend" | "resume";

const fakePowerMonitor = () => {
  const listeners = new Map<PowerEvent, Array<() => void>>();
  return {
    emit: (event: PowerEvent) => {
      for (const listener of listeners.get(event) ?? []) listener();
    },
    onSimpleEvent: (event: PowerEvent, listener: () => void) =>
      Effect.sync(() => {
        listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      }),
  };
};

describe("registerHandoffSleepNotice", () => {
  it.effect("asks the window to hand off on suspend, not on screen lock", () =>
    Effect.gen(function* () {
      const monitor = fakePowerMonitor();
      const sent: string[] = [];
      yield* registerHandoffSleepNotice(monitor, (action) =>
        Effect.sync(() => {
          sent.push(action);
        }),
      );
      monitor.emit("lock-screen");
      assert.deepEqual(sent, []);
      monitor.emit("suspend");
      yield* Effect.yieldNow;
      assert.deepEqual(sent, [HANDOFF_SLEEP_ACTION]);
    }).pipe(Effect.scoped),
  );

  it.effect("never throws when the window is gone", () =>
    Effect.gen(function* () {
      const monitor = fakePowerMonitor();
      yield* registerHandoffSleepNotice(monitor, () => Effect.fail(new NoWindow()));
      monitor.emit("suspend");
      yield* Effect.yieldNow;
    }).pipe(Effect.scoped),
  );
});

describe("the suspend notice to the server", () => {
  it.effect("tells the server on suspend as well as the window, never on screen lock", () =>
    Effect.gen(function* () {
      const monitor = fakePowerMonitor();
      const sent: string[] = [];
      yield* registerHandoffSleepNotice(
        monitor,
        (action) => Effect.sync(() => void sent.push(action)),
        Effect.sync(() => void sent.push("server")),
      );
      monitor.emit("lock-screen");
      yield* Effect.yieldNow;
      assert.deepEqual(sent, []);
      monitor.emit("suspend");
      yield* Effect.yieldNow;
      assert.sameMembers(sent, [HANDOFF_SLEEP_ACTION, "server"]);
    }).pipe(Effect.scoped),
  );

  it.effect("still reaches the server when no window answers, and the other way round", () =>
    Effect.gen(function* () {
      const monitor = fakePowerMonitor();
      const sent: string[] = [];
      yield* registerHandoffSleepNotice(
        monitor,
        () => Effect.fail(new NoWindow()),
        Effect.sync(() => void sent.push("server")),
      );
      const other = fakePowerMonitor();
      yield* registerHandoffSleepNotice(
        other,
        (action) => Effect.sync(() => void sent.push(action)),
        Effect.fail(new NoWindow()),
      );
      monitor.emit("suspend");
      other.emit("suspend");
      yield* Effect.yieldNow;
      assert.sameMembers(sent, ["server", HANDOFF_SLEEP_ACTION]);
    }).pipe(Effect.scoped),
  );

  const serverAnswering = (
    status: number,
    seen: Array<{ url: string; method: string; authorization: string | undefined }>,
  ) =>
    HttpClient.make((request) =>
      Effect.sync(() => {
        seen.push({
          url: request.url,
          method: request.method,
          authorization: request.headers["authorization"],
        });
        return HttpClientResponse.fromWeb(request, new Response("{}", { status }));
      }),
    );

  const target = Effect.succeed({
    httpBaseUrl: new URL("http://127.0.0.1:3773/"),
    bearerToken: "desktop-service-bearer",
  });

  it.effect("posts to this Mac's server with the desktop service credential", () =>
    Effect.gen(function* () {
      const seen: Array<{ url: string; method: string; authorization: string | undefined }> = [];
      yield* notifyServerOfSuspend(target).pipe(
        Effect.provideService(HttpClient.HttpClient, serverAnswering(200, seen)),
      );
      assert.deepEqual(seen, [
        {
          url: `http://127.0.0.1:3773${COORDINATOR_SUSPEND_PATH}`,
          method: "POST",
          authorization: "Bearer desktop-service-bearer",
        },
      ]);
    }),
  );

  it.effect("fails when the server refuses or no local server runs", () =>
    Effect.gen(function* () {
      const refused = yield* notifyServerOfSuspend(target).pipe(
        Effect.provideService(HttpClient.HttpClient, serverAnswering(403, [])),
        Effect.exit,
      );
      assert.isTrue(Exit.isFailure(refused));
      const seen: Array<{ url: string; method: string; authorization: string | undefined }> = [];
      const missing = yield* notifyServerOfSuspend(Effect.fail(new NoWindow())).pipe(
        Effect.provideService(HttpClient.HttpClient, serverAnswering(200, seen)),
        Effect.exit,
      );
      assert.isTrue(Exit.isFailure(missing));
      assert.deepEqual(seen, []);
    }),
  );
});
