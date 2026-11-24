// @effect-diagnostics anyUnknownInErrorContext:off -- the seat kit stubs services with loosely typed fakes.
/**
 * The `personal-share` exchange between two machines (1448 T-14, D-13, D-14):
 * who may link, what a refused peer learns (only a reason), and that content
 * goes only to a peer this machine accepts and that accepted it.
 */
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  PERSONAL_LINK_PROTOCOL_VERSION,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import type { PersonalShareRequest } from "../handoff/personalShareWire.ts";
import { personalLinkIdForAccount } from "./personalLinkId.ts";
import {
  contentAnswered,
  contentSent,
  grantOf,
  makeShareSeat,
  type Network,
  OTHER_USER,
  pairUp,
  type ShareSeat,
  USER,
} from "./personalShare.testkit.ts";

const LINK = personalLinkIdForAccount(USER);
const REFUSAL_KEYS = ["accepted", "environmentId", "protocolVersion", "reason"];

/** Laptop and Desktop: both switches on, each confirmed the other, own grants both ways. */
const pair = Effect.gen(function* () {
  const network: Network = new Map();
  const laptop = yield* makeShareSeat(network, "laptop", "Laptop");
  const desktop = yield* makeShareSeat(network, "desktop", "Desktop");
  laptop.switchOn([desktop.environmentId], { start: true });
  desktop.switchOn([laptop.environmentId]);
  pairUp(laptop, desktop);
  return { network, laptop, desktop };
});

/** Nothing about the assistant reached `callee`'s caller: only refusals and no content. */
const assertOnlyReasons = (callee: ShareSeat) => {
  assert.isAbove(callee.received.length, 0);
  for (const call of callee.received) {
    assert.isUndefined(call.response?.content);
    if (call.response !== null) {
      assert.isFalse(call.response.state.accepted);
      assert.deepStrictEqual(Object.keys(call.response.state).toSorted(), REFUSAL_KEYS);
    }
  }
};

/** The caller sent no content and its project is as it was. */
const assertNothingMoved = (caller: ShareSeat, callee: ShareSeat) => {
  assert.lengthOf(contentSent(caller), 0);
  assert.lengthOf(contentAnswered(callee), 0);
  assert.isUndefined(caller.identity());
  assert.isUndefined(callee.identity());
  assert.lengthOf(caller.points, 0);
  assert.lengthOf(callee.points, 0);
};

const stateOf = (seat: ShareSeat, peer: ShareSeat) =>
  seat.states.states.pipe(Effect.map((states) => states.get(peer.environmentId)));

/** A well-formed phase-1 request from `from`, as a peer that agrees to everything sends it. */
const yesRequest = (
  from: EnvironmentId,
  overrides: Partial<PersonalShareRequest> = {},
): PersonalShareRequest => ({
  protocolVersion: PERSONAL_LINK_PROTOCOL_VERSION,
  phase: 1,
  linkId: LINK,
  state: {
    accepted: true,
    protocolVersion: PERSONAL_LINK_PROTOCOL_VERSION,
    environmentId: from,
    switchOn: true,
    linkId: LINK,
    start: true,
    linked: false,
    members: [],
    memoryFileCount: 1,
  },
  ...overrides,
});

describe("PersonalShareEngine: two machines that accept each other", () => {
  it.effect("link in one exchange each way, the starter's name kept", () =>
    Effect.gen(function* () {
      const { laptop, desktop } = yield* pair;
      yield* laptop.write("MEMORY.md", "# Memory\n\n- Laptop note\n");
      yield* laptop.engine.exchange(desktop.environmentId);
      // Desktop joined the starter's link; Laptop wrote it after Desktop's answer.
      assert.strictEqual(desktop.identity()?.id, LINK);
      assert.strictEqual(laptop.identity()?.id, LINK);
      assert.deepStrictEqual(laptop.members(), ["env-desktop", "env-laptop"]);
      assert.deepStrictEqual(desktop.members(), ["env-desktop", "env-laptop"]);
      assert.strictEqual((yield* stateOf(laptop, desktop))?.state, "joined");
      assert.strictEqual((yield* stateOf(desktop, laptop))?.state, "waiting");
      // One before-link point on each seat, and one database copy.
      assert.lengthOf(desktop.points, 1);
      assert.lengthOf(laptop.points, 1);
      assert.lengthOf(desktop.snapshots, 1);
      yield* laptop.engine.exchange(desktop.environmentId);
      assert.strictEqual((yield* stateOf(desktop, laptop))?.state, "joined");
      assert.isDefined((yield* stateOf(desktop, laptop))?.lastSyncedAt);
      // In step: no new copies, nothing renamed.
      assert.lengthOf(desktop.points, 1);
      assert.lengthOf(laptop.points, 1);
      assert.strictEqual(laptop.current().title, "Percy");
    }),
  );

  it.effect("shares neither local-only nor secret-flagged files", () =>
    Effect.gen(function* () {
      const { laptop, desktop } = yield* pair;
      yield* laptop.write("MEMORY.md", "# Memory\n");
      yield* laptop.write("plain.md", "Plain note.");
      yield* laptop.write("keys.md", "GITHUB_TOKEN=ghp_1234567890abcdefghijklmnopqrstuvwx");
      yield* laptop.write("here-only.md", "Kept on this machine.");
      yield* laptop.projects.update({
        projectId: laptop.projectId,
        commandId: CommandId.make("local-only"),
        workspaceSettings: {
          expectedRevision: laptop.current().workspaceSettings!.revision,
          localOnlyMemoryFiles: ["here-only.md"],
        },
      } as any);
      yield* laptop.engine.exchange(desktop.environmentId);
      const content = contentSent(laptop)[0]!.request.content!;
      assert.deepStrictEqual(content.memory.files.map((file) => file.name).toSorted(), [
        "MEMORY.md",
        "plain.md",
      ]);
      assert.strictEqual(content.memory.index, "# Memory\n");
    }),
  );
});

describe("PersonalShareEngine: the callee refuses, and the caller learns only why", () => {
  const refusedBy = (
    setup: (seats: { laptop: ShareSeat; desktop: ShareSeat }) => void,
    reason: string,
  ) =>
    Effect.gen(function* () {
      const { laptop, desktop } = yield* pair;
      yield* desktop.write("MEMORY.md", "# Desktop memory\n");
      setup({ laptop, desktop });
      yield* laptop.engine.exchange(desktop.environmentId);
      assertOnlyReasons(desktop);
      assertNothingMoved(laptop, desktop);
      // The driver never sends content to a callee that has not accepted it: one call only.
      assert.lengthOf(laptop.sent, 1);
      assert.strictEqual(laptop.sent[0]!.request.phase, 1);
      assert.strictEqual((yield* stateOf(laptop, desktop))?.state, reason);
    });

  it.effect("its switch is off", () =>
    refusedBy(({ desktop }) => desktop.switchOff(), "switch_off"),
  );
  it.effect("its assistant setting is off", () =>
    refusedBy(({ desktop }) => desktop.setAideEnabled(false), "switch_off"),
  );
  it.effect("it is not linked to Connect", () =>
    refusedBy(({ desktop }) => desktop.setAccount({ status: "not_linked" }), "switch_off"),
  );
  it.effect("it neither listed the caller nor has a member vouching for it", () =>
    refusedBy(({ desktop }) => desktop.switchOn([]), "not_confirmed"),
  );
  it.effect("the caller signed in with a team grant", () =>
    refusedBy(({ desktop, laptop }) => desktop.issue(laptop.environmentId, "team"), "no_grant"),
  );
  it.effect("the caller signed in with a legacy grant", () =>
    refusedBy(
      ({ desktop, laptop }) => desktop.issue(laptop.environmentId, "legacy"),
      "legacy_grant",
    ),
  );
  it.effect("the caller is on another Connect account", () =>
    refusedBy(
      ({ laptop }) => laptop.setAccount({ status: "linked", cloudUserId: OTHER_USER }),
      "other_account",
    ),
  );
  it.effect("the caller sent no Connect user header", () =>
    refusedBy(({ laptop }) => laptop.setHeader(null), "other_account"),
  );
  it.effect("the caller's header names another account than its body", () =>
    refusedBy(({ laptop }) => laptop.setHeader(OTHER_USER), "other_account"),
  );

  it.effect("a revoked grant never reaches the engine, and the caller stops calling with it", () =>
    Effect.gen(function* () {
      const { laptop, desktop } = yield* pair;
      desktop.issue(laptop.environmentId, "revoked");
      yield* laptop.engine.exchange(desktop.environmentId);
      assert.lengthOf(desktop.received, 0);
      assertNothingMoved(laptop, desktop);
      assert.strictEqual((yield* stateOf(laptop, desktop))?.state, "no_grant");
      // The pair's driver flips to the side whose grant works.
      assert.isFalse((yield* laptop.engine.reach(desktop.environmentId)).selfCanCall);
    }),
  );

  it.effect("the engine itself refuses a revoked, missing or older-version caller", () =>
    Effect.gen(function* () {
      const { laptop, desktop } = yield* pair;
      const from = laptop.environmentId;
      const cases = [
        { grant: grantOf(from, "revoked"), request: yesRequest(from), reason: "no_grant" },
        { grant: null, request: yesRequest(from), reason: "no_grant" },
        {
          grant: grantOf(from, "own"),
          request: yesRequest(from, { protocolVersion: PERSONAL_LINK_PROTOCOL_VERSION - 1 }),
          reason: "older_version",
        },
        {
          grant: grantOf(from, "own"),
          request: yesRequest(from, { linkId: null }),
          reason: "other_account",
        },
      ];
      for (const entry of cases) {
        const response = yield* desktop.answerFrom(from, entry.grant, USER, entry.request);
        assert.isUndefined(response.content);
        assert.deepStrictEqual(response.state, {
          accepted: false,
          protocolVersion: PERSONAL_LINK_PROTOCOL_VERSION,
          environmentId: desktop.environmentId,
          reason: entry.reason as any,
        });
      }
      assert.isUndefined(desktop.identity());
    }),
  );

  it.effect("a body that speaks for another machine is refused before anything is read", () =>
    Effect.gen(function* () {
      const { laptop, desktop } = yield* pair;
      const exit = yield* desktop
        .answerFrom(
          laptop.environmentId,
          grantOf(laptop.environmentId, "own"),
          USER,
          yesRequest(EnvironmentId.make("env-tower")),
        )
        .pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(exit));
      assert.lengthOf(contentAnswered(desktop), 0);
    }),
  );

  it.effect("an older callee shows as older_version and gets nothing", () =>
    Effect.gen(function* () {
      const { laptop, desktop } = yield* pair;
      desktop.setOldVersion(true);
      yield* laptop.engine.exchange(desktop.environmentId);
      assert.strictEqual((yield* stateOf(laptop, desktop))?.state, "older_version");
      assertNothingMoved(laptop, desktop);
    }),
  );

  it.effect("an unreachable callee shows offline", () =>
    Effect.gen(function* () {
      const { laptop, desktop } = yield* pair;
      desktop.setOnline(false);
      yield* laptop.engine.exchange(desktop.environmentId);
      assert.strictEqual((yield* stateOf(laptop, desktop))?.state, "offline");
      assertNothingMoved(laptop, desktop);
    }),
  );
});

describe("PersonalShareEngine: the caller refuses by its own facts", () => {
  const callerRefuses = (setup: (seats: { laptop: ShareSeat; desktop: ShareSeat }) => void) =>
    Effect.gen(function* () {
      const { laptop, desktop } = yield* pair;
      yield* laptop.write("MEMORY.md", "# Laptop memory\n");
      setup({ laptop, desktop });
      yield* laptop.engine.exchange(desktop.environmentId);
      // The callee may accept; the caller still sends no content.
      for (const entry of laptop.sent) {
        assert.isUndefined(entry.request.content);
        assert.isFalse(entry.request.state.accepted);
        assert.deepStrictEqual(Object.keys(entry.request.state).toSorted(), REFUSAL_KEYS);
      }
      assertNothingMoved(laptop, desktop);
    });

  it.effect("its owner did not list the callee", () =>
    callerRefuses(({ laptop }) => laptop.switchOn([], { start: true })),
  );
  it.effect("its switch is off", () => callerRefuses(({ laptop }) => laptop.switchOff()));
  it.effect("it issued nothing and holds only a team grant there: the callee's check refuses", () =>
    Effect.gen(function* () {
      const { laptop, desktop } = yield* pair;
      yield* laptop.write("MEMORY.md", "# Laptop memory\n");
      pairUp(laptop, desktop, { bIssuesA: "team" });
      yield* laptop.engine.exchange(desktop.environmentId);
      // The caller cannot see the kind of grant it holds; the callee refuses it, so no content moves.
      assert.lengthOf(laptop.sent, 1);
      assertOnlyReasons(desktop);
      assertNothingMoved(laptop, desktop);
      assert.strictEqual((yield* stateOf(laptop, desktop))?.state, "no_grant");
      const reach = yield* laptop.engine.reach(desktop.environmentId);
      assert.deepStrictEqual(reach, { selfCanCall: false, peerCanCall: false });
    }),
  );
});

describe("PersonalShareEngine: a peer that says yes to everything", () => {
  /** Tower answers every call as a willing starter with memory; nobody listed or vouched for it. */
  const withYesPeer = Effect.gen(function* () {
    const { network, laptop, desktop } = yield* pair;
    const tower = yield* makeShareSeat(network, "tower", "Tower");
    tower.switchOn([laptop.environmentId], { start: true });
    yield* tower.write("MEMORY.md", "# Tower\n");
    pairUp(laptop, tower);
    const asked: PersonalShareRequest[] = [];
    network.set(tower.environmentId, {
      ...tower,
      answerFrom: (_from, _grant, _header, request) =>
        Effect.sync(() => {
          asked.push(request);
          const yes = yesRequest(tower.environmentId);
          return {
            state: yes.state,
            content: {
              self: {
                environmentId: tower.environmentId,
                projectId: tower.projectId,
                coordinatorThreadId: `project-coordinator:${tower.projectId}`,
              },
              link: null,
              settings: {
                updatedAt: null,
                title: "Tower Percy",
                instructions: "",
                icon: null,
                repositoryUrls: [],
              },
              memory: {
                files: [{ name: "MEMORY.md", sha256: "0".repeat(64) }],
                index: "# Tower\n",
              },
            },
          } as any;
        }),
    });
    return { laptop, desktop, tower, asked };
  });

  it.effect("receives nothing when called, and its answer changes nothing", () =>
    Effect.gen(function* () {
      const { laptop, tower, asked } = yield* withYesPeer;
      yield* laptop.write("MEMORY.md", "# Laptop memory\n");
      yield* laptop.engine.exchange(tower.environmentId);
      assert.lengthOf(asked, 1);
      assert.isUndefined(asked[0]!.content);
      assert.deepStrictEqual(asked[0]!.state, {
        accepted: false,
        protocolVersion: PERSONAL_LINK_PROTOCOL_VERSION,
        environmentId: laptop.environmentId,
        reason: "not_confirmed",
      });
      assert.isUndefined(laptop.identity());
      assert.lengthOf(laptop.points, 0);
      assert.strictEqual((yield* stateOf(laptop, tower))?.state, "not_confirmed");
      assert.notInclude(yield* laptop.engine.candidates, tower.environmentId);
    }),
  );

  it.effect("receives nothing when it calls with a perfect request and content", () =>
    Effect.gen(function* () {
      const { laptop, tower } = yield* withYesPeer;
      yield* laptop.write("MEMORY.md", "# Laptop memory\n");
      for (const phase of [1, 2] as const) {
        const response = yield* laptop.answerFrom(
          tower.environmentId,
          grantOf(tower.environmentId, "own"),
          USER,
          yesRequest(tower.environmentId, {
            phase,
            ...(phase === 2
              ? {
                  content: {
                    self: {
                      environmentId: tower.environmentId,
                      projectId: tower.projectId,
                      coordinatorThreadId: `project-coordinator:${tower.projectId}`,
                    },
                    link: null,
                    settings: {
                      updatedAt: null,
                      title: "Tower Percy",
                      instructions: "",
                      icon: null,
                      repositoryUrls: [],
                    },
                    memory: { files: [], index: null },
                  } as any,
                }
              : {}),
          }),
        );
        assert.isUndefined(response.content);
        assert.deepStrictEqual(Object.keys(response.state).toSorted(), REFUSAL_KEYS);
      }
      assert.isUndefined(laptop.identity());
      assert.strictEqual(laptop.current().title, "Percy");
      assert.lengthOf(laptop.points, 0);
    }),
  );
});

describe("PersonalShareEngine: lapses pause", () => {
  it.effect("an unreadable Connect sign-in sends nothing and keeps the last state", () =>
    Effect.gen(function* () {
      const { laptop, desktop } = yield* pair;
      yield* laptop.engine.exchange(desktop.environmentId);
      assert.strictEqual((yield* stateOf(laptop, desktop))?.state, "joined");
      const before = laptop.sent.length;
      laptop.setAccount({ status: "unknown" });
      yield* laptop.engine.exchange(desktop.environmentId);
      assert.strictEqual(laptop.sent.length, before);
      const state = yield* stateOf(laptop, desktop);
      assert.strictEqual(state?.state, "joined");
      assert.include(state?.detail ?? "", "Paused");
      assert.strictEqual(laptop.identity()?.id, LINK);
      assert.lengthOf(laptop.points, 1);
    }),
  );

  it.effect("a callee that cannot read its sign-in answers unreachable and changes nothing", () =>
    Effect.gen(function* () {
      const { laptop, desktop } = yield* pair;
      desktop.setSettingsReadable(false);
      yield* laptop.engine.exchange(desktop.environmentId);
      assert.strictEqual((yield* stateOf(laptop, desktop))?.state, "offline");
      assertNothingMoved(laptop, desktop);
    }),
  );
});

describe("PersonalShareEngine: the owner acts while an exchange runs", () => {
  it.effect("the caller's switch goes off after phase 1: no content is sent", () =>
    Effect.gen(function* () {
      const { laptop, desktop } = yield* pair;
      yield* laptop.write("MEMORY.md", "# Laptop memory\n");
      desktop.setOnReceive((request) => {
        if (request.phase === 1) laptop.switchOff();
      });
      yield* laptop.engine.exchange(desktop.environmentId);
      assert.lengthOf(laptop.sent, 1);
      assertNothingMoved(laptop, desktop);
      assert.strictEqual((yield* stateOf(laptop, desktop))?.state, "switch_off");
    }),
  );

  it.effect("the callee drops the caller before phase 2: it answers with a reason only", () =>
    Effect.gen(function* () {
      const { laptop, desktop } = yield* pair;
      yield* desktop.write("MEMORY.md", "# Desktop memory\n");
      desktop.setOnReceive((request) => {
        if (request.phase === 2) desktop.switchOn([]);
      });
      yield* laptop.engine.exchange(desktop.environmentId);
      const last = desktop.received.at(-1)!;
      assert.strictEqual(last.request.phase, 2);
      assert.isUndefined(last.response?.content);
      assert.isFalse(last.response!.state.accepted);
      assert.isUndefined(desktop.identity());
      assert.isUndefined(laptop.identity());
      assert.lengthOf(desktop.points, 0);
      assert.lengthOf(laptop.points, 0);
    }),
  );

  it.effect("the caller's switch goes off during phase 2: the caller writes nothing", () =>
    Effect.gen(function* () {
      const { laptop, desktop } = yield* pair;
      desktop.setOnReceive((request) => {
        if (request.phase === 2) laptop.switchOff();
      });
      yield* laptop.engine.exchange(desktop.environmentId);
      // Desktop joined in its own answer; Laptop, switched off, neither links nor saves copies.
      assert.isUndefined(laptop.identity());
      assert.lengthOf(laptop.points, 0);
      assert.lengthOf(laptop.snapshots, 0);
      assert.strictEqual((yield* stateOf(laptop, desktop))?.state, "switch_off");
    }),
  );
});
