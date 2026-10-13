/**
 * A service held by a live install gate, as a process the update helper restarted sees it.
 *
 * The gate file is written into a scoped temporary `updates` folder, dated by the current
 * clock (a test clock works), and names a helper that is reported alive. `clear` removes it
 * as the helper does once the release is verified.
 */
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";

import * as Hold from "./ServiceUpdateHold.ts";
import * as Gate from "./UpdateInstallGate.ts";

export const GATE_POLL_MS = 10;

export const makeGatedHold = (
  options: {
    readonly helperAlive?: () => boolean;
    readonly pollMs?: number;
    readonly bootMs?: number | null;
  } = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const updates = yield* fs.makeTempDirectoryScoped({ prefix: "update-install-gate-" });
    const gatePath = path.join(updates, Gate.INSTALL_GATE_FILE);
    const at = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis));
    yield* fs.writeFileString(gatePath, JSON.stringify({ helperPid: 4242, at }));
    const helperAlive = options.helperAlive ?? (() => true);
    const hold = yield* Hold.makeWithOptions({
      agentStatePath: path.join(updates, "state.json"),
      pollMs: options.pollMs ?? GATE_POLL_MS,
      isAlive: () => helperAlive(),
      // The test clock may stand before the machine started; tests date the boot themselves.
      bootMs: options.bootMs ?? null,
    });
    return { hold, gatePath, clear: fs.remove(gatePath) };
  });

/**
 * Moves a test clock on one poll at a time, giving each poll's file read real time to finish,
 * until the gate is open. False when it stays closed.
 */
export const awaitGateOpen = (hold: Hold.ServiceUpdateHoldShape, pollMs = GATE_POLL_MS) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (!(yield* hold.installGated)) return true;
      yield* TestClock.adjust(Duration.millis(pollMs));
      yield* TestClock.withLive(Effect.sleep(Duration.millis(5)));
    }
    return false;
  });
