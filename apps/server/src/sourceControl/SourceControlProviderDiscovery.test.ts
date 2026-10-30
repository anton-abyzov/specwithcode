import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import { probeSourceControlProvider } from "./SourceControlProviderDiscovery.ts";
import type * as VcsProcess from "../vcs/VcsProcess.ts";

const unusedProcess = {} as VcsProcess.VcsProcess["Service"];

it.effect("answers discovery without waiting on a hosting API that stalls", () =>
  Effect.gen(function* () {
    const probing = yield* probeSourceControlProvider({
      spec: {
        type: "api",
        kind: "bitbucket",
        label: "Bitbucket",
        installHint: "unused",
        probeAuth: Effect.never,
      },
      process: unusedProcess,
      cwd: "/repo",
    }).pipe(Effect.forkChild);
    yield* TestClock.adjust("3 seconds");
    const item = yield* Fiber.join(probing);
    assert.strictEqual(item.status, "available");
    assert.strictEqual(item.auth.status, "unknown");
    assert.isTrue(Option.isSome(item.auth.detail));
  }),
);

it.effect("keeps an API answer that arrives in time", () =>
  Effect.gen(function* () {
    const item = yield* probeSourceControlProvider({
      spec: {
        type: "api",
        kind: "bitbucket",
        label: "Bitbucket",
        installHint: "unused",
        probeAuth: Effect.succeed({
          status: "authenticated",
          account: Option.some("octo"),
          host: Option.some("bitbucket.org"),
          detail: Option.none(),
        }),
      },
      process: unusedProcess,
      cwd: "/repo",
    });
    assert.strictEqual(item.auth.status, "authenticated");
    assert.deepStrictEqual(item.auth.account, Option.some("octo"));
  }),
);
