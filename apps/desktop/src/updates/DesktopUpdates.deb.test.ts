import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as DesktopUpdates from "./DesktopUpdates.ts";
import { flushCallbacks, makeHarness } from "./updatesTestHarness.ts";

// A .deb app used to refuse every idle install, so it updated only when it quit
// (the Minisforum app on 1.0.245 while its service ran 1.0.253, November 12, 2026).
describe("DesktopUpdates idle install of a .deb", () => {
  const settle = Effect.gen(function* () {
    for (let i = 0; i < 40; i++) yield* flushCallbacks;
  });

  const idleInstall = (silentDebInstall: boolean) => {
    const harness = makeHarness({
      platform: "linux",
      packageType: "deb\n",
      silentDebInstall,
      downloadUpdate: Effect.sync(() => harness.emit("update-downloaded", { version: "1.2.4" })),
    });
    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        harness.emit("update-available", { version: "1.2.4" });
        yield* settle;
        yield* updates.download;
        yield* settle;
        const answer = yield* updates.installPrepared("1.2.4", {
          beforeQuit: Effect.succeed(true),
        });
        return { answer, quits: harness.quits(), installs: harness.quitAndInstalls() };
      }),
    ).pipe(Effect.provide(harness.layer));
  };

  it.effect("installs through the signed helper when it and its polkit action are ready", () =>
    Effect.gen(function* () {
      const { answer, quits, installs } = yield* idleInstall(true);
      assert.isTrue(answer.accepted);
      assert.equal(installs, 1);
      assert.equal(quits, 1);
    }),
  );

  it.effect("still refuses when the helper or its polkit action is missing", () =>
    Effect.gen(function* () {
      const { answer, quits, installs } = yield* idleInstall(false);
      assert.isFalse(answer.accepted);
      assert.equal(answer.reason, "disabled");
      assert.equal(installs, 0);
      assert.equal(quits, 0);
    }),
  );
});
