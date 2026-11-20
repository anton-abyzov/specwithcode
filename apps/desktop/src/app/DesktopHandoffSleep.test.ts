import { assert, describe, it } from "@effect/vitest";
import { AWAY_WAKE_PATH, COORDINATOR_SUSPEND_PATH } from "@specweave-studio/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import {
  AWAY_WAKE_ACTION,
  notifyServerOfAwayWake,
  notifyServerOfSuspend,
  registerAwayWakeNotice,
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

describe("the suspend notice to the server", () => {
  it.effect("on suspend tells the server and asks no window to move threads (1390 AC-36)", () =>
    Effect.gen(function* () {
      const monitor = fakePowerMonitor();
      const sent: string[] = [];
      yield* registerHandoffSleepNotice(
        monitor,
        Effect.sync(() => void sent.push("server")),
      );
      monitor.emit("lock-screen");
      yield* Effect.yieldNow;
      assert.deepEqual(sent, []);
      monitor.emit("suspend");
      yield* Effect.yieldNow;
      // Only the notice: nothing here can ask a window, or Away, to start a move.
      assert.deepEqual(sent, ["server"]);
    }).pipe(Effect.scoped),
  );

  it.effect("never throws when the server does not answer", () =>
    Effect.gen(function* () {
      const monitor = fakePowerMonitor();
      yield* registerHandoffSleepNotice(monitor, Effect.fail(new NoWindow()));
      monitor.emit("suspend");
      yield* Effect.yieldNow;
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

describe("the wake notice", () => {
  const settle = Effect.gen(function* () {
    for (let index = 0; index < 5; index++) yield* Effect.yieldNow;
  });

  it.effect("wake and unlock ask the server; the card shows only when work moved", () =>
    Effect.gen(function* () {
      const monitor = fakePowerMonitor();
      const sent: string[] = [];
      let moved = false;
      let asked = 0;
      yield* registerAwayWakeNotice(
        monitor,
        (action) => Effect.sync(() => void sent.push(action)),
        Effect.sync(() => (asked++, moved)),
      );
      monitor.emit("resume");
      yield* settle;
      assert.deepEqual(sent, []);
      moved = true;
      monitor.emit("unlock-screen");
      yield* settle;
      assert.deepEqual(sent, [AWAY_WAKE_ACTION]);
      monitor.emit("lock-screen");
      monitor.emit("suspend");
      yield* settle;
      assert.strictEqual(asked, 2);
    }).pipe(Effect.scoped),
  );

  const answering = (body: unknown, seen: Array<{ url: string; body: unknown }>) =>
    HttpClient.make((request) =>
      Effect.sync(() => {
        const raw =
          request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";
        seen.push({ url: request.url, body: raw === "" ? null : JSON.parse(raw) });
        return HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify(body), { status: 200 }),
        );
      }),
    );
  const local = Effect.succeed({
    httpBaseUrl: new URL("http://127.0.0.1:3773/"),
    bearerToken: "desktop-service-bearer",
  });

  it.effect("the wake notice shows the card on prompt or auto, not on none", () =>
    Effect.gen(function* () {
      const seen: Array<{ url: string; body: unknown }> = [];
      const ask = (outcome: string) =>
        notifyServerOfAwayWake(local, false).pipe(
          Effect.provideService(HttpClient.HttpClient, answering({ outcome }, seen)),
        );
      assert.isTrue(yield* ask("prompt"));
      assert.isTrue(yield* ask("auto"));
      assert.isFalse(yield* ask("none"));
      assert.strictEqual(seen[0]?.url, `http://127.0.0.1:3773${AWAY_WAKE_PATH}`);
    }),
  );
});
