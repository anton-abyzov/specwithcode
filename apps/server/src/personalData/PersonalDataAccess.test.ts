import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { EnvironmentId, OrchestratorMcpFailure } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import * as PersonalDataAccess from "./PersonalDataAccess.ts";
import { actsAsOwner, personalDataSourceOfTool, requirePersonalData } from "./personalDataGate.ts";

const m4 = { environmentId: EnvironmentId.make("env-m4"), label: "m4" };
const m1 = { environmentId: EnvironmentId.make("env-m1"), label: "m1" };
const gmailSearch = { source: "gmail" as const, tool: "studio_google_gmail_search" };

/** Builds the service again over the same state folder, as a restart does. */
const withService = <A, E>(
  body: (service: PersonalDataAccess.PersonalDataAccessShape) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    return yield* body(yield* PersonalDataAccess.PersonalDataAccess);
  }).pipe(Effect.provide(PersonalDataAccess.layer));

const withStateDir = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "studio-personal-data-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  );

const teamGrant = (machine: typeof m4) => ({
  grant: { coordinatorEnvironmentId: machine.environmentId, kind: "team" as const },
  coordinatorLabel: machine.label,
});

it.effect("allows nothing by default and keeps one request per machine and source", () =>
  withStateDir(
    withService((service) =>
      Effect.gen(function* () {
        assert.isFalse(yield* service.check({ ...m4, ...gmailSearch }));
        assert.isFalse(yield* service.check({ ...m4, ...gmailSearch }));
        const status = yield* service.status([m4, m1]);
        assert.deepEqual(
          status.machines.map((machine) => [machine.label, machine.sources, machine.requested]),
          [
            ["m4", [], ["gmail"]],
            ["m1", [], []],
          ],
        );
        // The repeat within ten minutes is one log line.
        assert.deepEqual(
          status.log.map((entry) => [entry.label, entry.source, entry.action, entry.tool]),
          [["m4", "gmail", "refused", "studio_google_gmail_search"]],
        );
      }),
    ),
  ),
);

it.effect(
  "allowing one source opens only that source for that machine and clears its request",
  () =>
    withStateDir(
      withService((service) =>
        Effect.gen(function* () {
          yield* service.check({ ...m4, ...gmailSearch });
          yield* service.set(
            { environmentId: m4.environmentId, source: "gmail", change: "allow" },
            "m4",
          );
          assert.isTrue(yield* service.check({ ...m4, ...gmailSearch }));
          assert.isFalse(
            yield* service.check({ ...m4, source: "drive", tool: "studio_google_drive_search" }),
          );
          assert.isFalse(yield* service.check({ ...m1, ...gmailSearch }));
          const m4Status = (yield* service.status([m4])).machines.find(
            (machine) => machine.environmentId === m4.environmentId,
          );
          assert.deepEqual(m4Status?.sources, ["gmail"]);
          assert.deepEqual(m4Status?.requested, ["drive"]);
        }),
      ),
    ),
);

it.effect("revoking refuses again, and dismissing clears a request without allowing", () =>
  withStateDir(
    withService((service) =>
      Effect.gen(function* () {
        const gmail = { environmentId: m4.environmentId, source: "gmail" as const };
        yield* service.set({ ...gmail, change: "allow" }, "m4");
        yield* service.set({ ...gmail, change: "revoke" }, "m4");
        assert.isFalse(yield* service.check({ ...m4, ...gmailSearch }));
        yield* service.set({ ...gmail, change: "dismiss" }, "m4");
        const status = yield* service.status([m4]);
        assert.deepEqual(status.machines[0]?.sources, []);
        assert.deepEqual(status.machines[0]?.requested, []);
        assert.deepEqual(
          status.log.map((entry) => entry.action),
          ["dismissed", "refused", "revoked", "granted"],
        );
      }),
    ),
  ),
);

it.effect("grants, requests and the log survive a restart", () =>
  withStateDir(
    Effect.gen(function* () {
      yield* withService((service) =>
        Effect.gen(function* () {
          yield* service.set(
            { environmentId: m4.environmentId, source: "calendar", change: "allow" },
            "m4",
          );
          yield* service.check({ ...m1, ...gmailSearch });
        }),
      );
      yield* withService((service) =>
        Effect.gen(function* () {
          assert.isTrue(
            yield* service.check({
              ...m4,
              source: "calendar",
              tool: "studio_google_calendar_events",
            }),
          );
          // A machine that no longer runs work here still shows what it holds or asked.
          const status = yield* service.status([]);
          assert.deepEqual(
            status.machines.map((machine) => [machine.label, machine.sources, machine.requested]),
            [
              ["m4", ["calendar"], []],
              ["m1", [], ["gmail"]],
            ],
          );
          assert.deepEqual(
            status.log.map((entry) => entry.action),
            ["used", "refused", "granted"],
          );
        }),
      );
    }),
  ),
);

it.effect("logs a repeated read again after ten minutes and caps the log", () =>
  withStateDir(
    withService((service) =>
      Effect.gen(function* () {
        yield* service.set(
          { environmentId: m4.environmentId, source: "gmail", change: "allow" },
          "m4",
        );
        for (let index = 0; index < PersonalDataAccess.PERSONAL_DATA_LOG_LIMIT + 20; index += 1) {
          yield* service.check({ ...m4, ...gmailSearch });
          yield* TestClock.adjust(PersonalDataAccess.PERSONAL_DATA_LOG_REPEAT_MS + 1);
        }
        const { log } = yield* service.status([m4]);
        assert.equal(log.length, PersonalDataAccess.PERSONAL_DATA_LOG_LIMIT);
        assert.isTrue(log.every((entry) => entry.action === "used"));
      }),
    ),
  ),
);

it.effect("without the layer nothing is allowed", () =>
  Effect.gen(function* () {
    const service = yield* PersonalDataAccess.PersonalDataAccess;
    assert.isFalse(yield* service.check({ ...m4, ...gmailSearch }));
  }),
);

it("maps each Google tool to its source", () => {
  assert.equal(personalDataSourceOfTool("studio_google_gmail_send_draft"), "gmail");
  assert.equal(personalDataSourceOfTool("studio_google_calendar_events"), "calendar");
  assert.equal(personalDataSourceOfTool("studio_google_drive_read"), "drive");
  assert.isUndefined(personalDataSourceOfTool("studio_google_status"));
  assert.isTrue(actsAsOwner({ kind: "own" }));
  assert.isTrue(actsAsOwner({ kind: "team", legacy: true }));
  assert.isFalse(actsAsOwner({ kind: "team" }));
  assert.isFalse(actsAsOwner({}));
});

it.effect("the owner's own thread reads without a grant and leaves no trace", () =>
  withStateDir(
    Effect.gen(function* () {
      yield* requirePersonalData(undefined, "studio_google_gmail_search");
      const service = yield* PersonalDataAccess.PersonalDataAccess;
      assert.deepEqual((yield* service.status([])).log, []);
    }).pipe(Effect.provide(PersonalDataAccess.layer)),
  ),
);

it.effect("another machine's work is refused by name until its source is allowed", () =>
  withStateDir(
    Effect.gen(function* () {
      const refused = yield* requirePersonalData(teamGrant(m4), "studio_google_gmail_read").pipe(
        Effect.flip,
      );
      assert.instanceOf(refused, OrchestratorMcpFailure);
      assert.equal(refused.code, "capability_denied");
      assert.include(refused.message, "Gmail");
      assert.include(refused.message, "m4");
      assert.include(refused.message, "Settings > Google > Other machines");

      const service = yield* PersonalDataAccess.PersonalDataAccess;
      yield* service.set(
        { environmentId: m4.environmentId, source: "gmail", change: "allow" },
        "m4",
      );
      yield* requirePersonalData(teamGrant(m4), "studio_google_gmail_read");
      // Calendar and Drive stay closed, and so does every other machine.
      assert.isTrue(
        yield* requirePersonalData(teamGrant(m4), "studio_google_calendar_events").pipe(
          Effect.isFailure,
        ),
      );
      assert.isTrue(
        yield* requirePersonalData(teamGrant(m4), "studio_google_drive_search").pipe(
          Effect.isFailure,
        ),
      );
      assert.isTrue(
        yield* requirePersonalData(teamGrant(m1), "studio_google_gmail_read").pipe(
          Effect.isFailure,
        ),
      );

      yield* service.set(
        { environmentId: m4.environmentId, source: "gmail", change: "revoke" },
        "m4",
      );
      assert.isTrue(
        yield* requirePersonalData(teamGrant(m4), "studio_google_gmail_read").pipe(
          Effect.isFailure,
        ),
      );
    }).pipe(Effect.provide(PersonalDataAccess.layer)),
  ),
);

it.effect("the owner's own machine reads as the owner, and the read is logged", () =>
  withStateDir(
    Effect.gen(function* () {
      yield* requirePersonalData(
        {
          grant: { coordinatorEnvironmentId: m1.environmentId, kind: "own" },
          coordinatorLabel: "m1",
        },
        "studio_google_drive_read",
      );
      const service = yield* PersonalDataAccess.PersonalDataAccess;
      const status = yield* service.status([{ ...m1, ownMachine: true }]);
      assert.isTrue(status.machines[0]?.ownMachine);
      assert.deepEqual(
        status.log.map((entry) => [entry.label, entry.source, entry.action]),
        [["m1", "drive", "used"]],
      );
    }).pipe(Effect.provide(PersonalDataAccess.layer)),
  ),
);
