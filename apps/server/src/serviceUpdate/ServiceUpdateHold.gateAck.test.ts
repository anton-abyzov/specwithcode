import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { describe } from "vite-plus/test";

import * as Hold from "./ServiceUpdateHold.ts";
import * as UpdateInstallGate from "./UpdateInstallGate.ts";

const gateText = JSON.stringify({ helperPid: process.pid, at: "2026-10-30T12:00:00.123456+00:00" });

describe("installGateAck", () => {
  it("names the gate it answers by its helper and time, and the service that read it", () => {
    const ack = UpdateInstallGate.installGateAck(gateText, 4242, "2026-10-30T12:00:00.200Z");
    assert.deepStrictEqual(JSON.parse(ack ?? "null"), {
      schemaVersion: 1,
      servicePid: 4242,
      helperPid: process.pid,
      gateAt: "2026-10-30T12:00:00.123456+00:00",
      at: "2026-10-30T12:00:00.200Z",
    });
  });

  it("answers no gate without its helper's time and pid: the helper waits out the settle", () => {
    for (const text of ["", "{", "[]", JSON.stringify({ at: "2026-10-30T12:00:00Z" })]) {
      assert.isNull(UpdateInstallGate.installGateAck(text, 4242, "2026-10-30T12:00:00Z"));
    }
    assert.isNull(
      UpdateInstallGate.installGateAck(JSON.stringify({ helperPid: process.pid }), 4242, "now"),
    );
  });
});

/** Polls for the acknowledgement file for up to about five seconds. */
const awaitAck = (fs: FileSystem.FileSystem, ackPath: string) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 500; attempt += 1) {
      const text = yield* fs.readFileString(ackPath).pipe(Effect.option);
      if (text._tag === "Some") return JSON.parse(text.value) as Record<string, unknown>;
      yield* Effect.sleep(Duration.millis(10));
    }
    return null;
  });

it.live("a held service acknowledges a new gate once the commands it admitted have ended", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "service-update-gate-ack-" });
    const ackPath = path.join(dir, UpdateInstallGate.INSTALL_GATE_ACK_FILE);
    const hold = yield* Hold.makeWithOptions({
      agentStatePath: path.join(dir, "state.json"),
      gateAckPollMs: 10,
    });
    // A command admitted before the hold is still committing when the gate is written.
    const finish = yield* Deferred.make<void>();
    const command = yield* Effect.forkChild(
      hold.withAdmission("thread.turn.start", Deferred.await(finish)),
    );
    yield* Effect.sleep(Duration.millis(20));
    yield* hold.acquire();
    yield* fs.writeFileString(path.join(dir, UpdateInstallGate.INSTALL_GATE_FILE), gateText);
    yield* Effect.sleep(Duration.millis(100));
    assert.isFalse(yield* fs.exists(ackPath));
    yield* Deferred.succeed(finish, undefined);
    yield* Fiber.join(command);
    const ack = yield* awaitAck(fs, ackPath);
    assert.isNotNull(ack);
    assert.equal(ack?.servicePid, process.pid);
    assert.equal(ack?.gateAt, "2026-10-30T12:00:00.123456+00:00");
    assert.equal(ack?.helperPid, process.pid);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("a service that is not held acknowledges nothing", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "service-update-gate-ack-unheld-" });
    yield* Hold.makeWithOptions({
      agentStatePath: path.join(dir, "state.json"),
      gateAckPollMs: 10,
    });
    yield* fs.writeFileString(path.join(dir, UpdateInstallGate.INSTALL_GATE_FILE), gateText);
    yield* Effect.sleep(Duration.millis(200));
    assert.isFalse(yield* fs.exists(path.join(dir, UpdateInstallGate.INSTALL_GATE_ACK_FILE)));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
