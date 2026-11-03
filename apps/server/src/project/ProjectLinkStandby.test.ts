import {
  EnvironmentId,
  type LogicalProjectMember,
  ProjectId,
  type ProjectLinkError,
  type StandbyRearmConsent,
  ThreadId,
} from "@specweave-studio/contracts";
import { afterEach, describe, expect, it } from "@effect/vitest";
import { TEAM_RULES_NONE, type TeamRulesState } from "@specweave-studio/shared/teamRules";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import { TeamRules, teamRulesOf } from "../teamRules/TeamRules.ts";
import * as ProjectLink from "./ProjectLink.ts";
import { legacyPair, link, machine, removeCheckouts } from "./ProjectLink.testkit.ts";
import { PEER_ARM_NO_CONSENT } from "./ProjectLinkStandby.ts";

afterEach(removeCheckouts);

const chainId = "77777777-7777-4777-8777-777777777777";
const otherChain = "88888888-8888-4888-8888-888888888888";
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
const HOLD: TeamRulesState = { status: "hold", issues: ["broken"] };

type Machine = ReturnType<typeof machine>;

/** Runs on one machine with fixed team rules, so the machine's own file never decides a test. */
const on = <A>(
  target: Machine,
  use: (link: ProjectLink.ProjectLink["Service"]) => Effect.Effect<A, ProjectLinkError>,
  rules: TeamRulesState = TEAM_RULES_NONE,
) =>
  Effect.runPromiseExit(
    Effect.gen(function* () {
      return yield* use(yield* ProjectLink.ProjectLink);
    }).pipe(Effect.provide(target.layer), Effect.provideService(TeamRules, teamRulesOf(rules))),
  ).then((exit) => {
    if (Exit.isSuccess(exit)) return exit.value;
    throw Cause.squash(exit.cause);
  });

/**
 * M4 coordinates EasyChamp and the M3 copy is a member. M3's identity also
 * lists an M1 copy, as a third machine of the owner's list.
 */
const setup = async () => {
  const pair = legacyPair();
  const { prepared } = await link(pair);
  const logicalProjectId = prepared.logicalProject.id;
  const m1: LogicalProjectMember = {
    environmentId: EnvironmentId.make("m1"),
    projectId: ProjectId.make("easychamp-m1"),
    coordinatorThreadId: ThreadId.make("project-coordinator:easychamp-m1"),
  };
  const copy = pair.m3.projects.get(pair.joining.projectId)!;
  const settings = copy.workspaceSettings!;
  pair.m3.projects.set(pair.joining.projectId, {
    ...copy,
    workspaceSettings: {
      ...settings,
      logicalProject: {
        ...settings.logicalProject!,
        members: [...settings.logicalProject!.members, m1],
      },
    },
  });
  const consent = (
    members: ReadonlyArray<LogicalProjectMember> = [pair.kept, pair.joining, m1],
    overrides: Partial<StandbyRearmConsent> = {},
  ): StandbyRearmConsent => ({ chainId, members, afterMinutes: 5, fromEpoch: 2, ...overrides });
  const writeConsent = (value: StandbyRearmConsent | null) =>
    on(pair.m3, (service) =>
      service.acceptStandby({
        projectId: pair.joining.projectId,
        logicalProjectId,
        rearm: value,
      }),
    );
  const ownerAccept = (coordinator: LogicalProjectMember, epoch: number, afterMinutes = 15) =>
    on(pair.m3, (service) =>
      service.acceptStandby({
        projectId: pair.joining.projectId,
        logicalProjectId,
        standby: { coordinator, epoch, afterMinutes: afterMinutes as 15 },
      }),
    );
  const peerAccept = (
    input: { epoch?: number; chainId?: string; caller?: string } = {},
    rules?: TeamRulesState,
  ) =>
    on(
      pair.m3,
      (service) =>
        service.acceptStandbyFromPeer({
          logicalProjectId,
          callerEnvironmentId: input.caller ?? pair.kept.environmentId,
          epoch: input.epoch ?? 3,
          chainId: input.chainId ?? chainId,
        }),
      rules,
    );
  return { pair, logicalProjectId, m1, consent, writeConsent, ownerAccept, peerAccept };
};

describe("re-arm consent and peer registration", () => {
  it("writes the owner's consent only when every machine is listed, this one included, once", async () => {
    const { pair, logicalProjectId, m1, consent, writeConsent } = await setup();
    const stranger: LogicalProjectMember = { ...m1, environmentId: EnvironmentId.make("m9") };
    for (const members of [
      [pair.kept, stranger],
      [pair.joining, pair.joining],
      [pair.kept, m1],
    ])
      expect((await pair.m3.fails(writeConsent(consent(members)))).code).toBe("invalid");
    expect(
      (
        await pair.m3.fails(
          on(pair.m3, (service) =>
            service.acceptStandby({ projectId: pair.joining.projectId, logicalProjectId }),
          ),
        )
      ).code,
    ).toBe("invalid");
    expect(pair.m3.rearm.size).toBe(0);

    expect(await writeConsent(consent())).toEqual({
      standby: null,
      replayed: true,
      rearm: { chainId },
    });
    const written = pair.m3.rearm.get(logicalProjectId)!;
    expect(written).toMatchObject({
      projectId: pair.joining.projectId,
      consent: consent(),
      run: null,
    });
    // The same consent again keeps when it was written, so a waiting re-arm keeps its backoff.
    await writeConsent(consent());
    expect(pair.m3.rearm.get(logicalProjectId)!.consentUpdatedAt).toBe(written.consentUpdatedAt);
    expect(await writeConsent(null)).toEqual({ standby: null, replayed: true, rearm: null });
    expect(pair.m3.rearm.size).toBe(0);
    // Another project's id is refused before anything is written.
    expect(
      (
        await pair.m3.fails(
          on(pair.m3, (service) =>
            service.acceptStandby({
              projectId: pair.joining.projectId,
              logicalProjectId: "logical:other",
              rearm: consent(),
            }),
          ),
        )
      ).code,
    ).toBe("not_linked");
  });

  it("accepts a peer only under a matching consent naming the caller, at or above its epoch", async () => {
    const { pair, logicalProjectId, m1, consent, writeConsent, peerAccept } = await setup();
    const refused = async (attempt: Promise<unknown>) => {
      const error = await pair.m3.fails(attempt);
      return error.detail === PEER_ARM_NO_CONSENT ? "no_consent" : error.code;
    };
    expect(await refused(peerAccept())).toBe("no_consent");
    await writeConsent(consent());
    expect(await refused(peerAccept({ chainId: otherChain }))).toBe("no_consent");
    expect(await refused(peerAccept({ epoch: 1 }))).toBe("superseded_conflict");
    expect(await refused(peerAccept({}, HOLD))).toBe("invalid");
    expect(await refused(peerAccept({ caller: "m9" }))).toBe("invalid");
    await writeConsent(consent([pair.joining, m1]));
    expect(await refused(peerAccept())).toBe("no_consent");
    expect(pair.m3.standby.size).toBe(0);

    await writeConsent(consent());
    const armed = await peerAccept();
    expect(armed).toMatchObject({
      replayed: false,
      // The delay is the owner's, from the consent.
      standby: { coordinator: pair.kept, epoch: 3, afterMinutes: 5 },
    });
    expect(pair.m3.standby.get(logicalProjectId)).toMatchObject({
      coordinator: pair.kept,
      epoch: 3,
      armedBy: { kind: "peer", chainId },
    });
    expect((await peerAccept()).replayed).toBe(true);
  });

  it("never replaces a registration for a newer coordinator, on the owner's path", async () => {
    const { pair, logicalProjectId, m1, ownerAccept } = await setup();
    await ownerAccept(pair.kept, 5);
    const held = pair.m3.standby.get(logicalProjectId);
    expect((await pair.m3.fails(ownerAccept(pair.kept, 3))).code).toBe("superseded_conflict");
    expect((await pair.m3.fails(ownerAccept(m1, 5))).code).toBe("superseded_conflict");
    expect(pair.m3.standby.get(logicalProjectId)).toEqual(held);
    // A newer coordinator, or the same one with another delay, is accepted.
    expect((await ownerAccept(pair.kept, 5, 30)).standby).toMatchObject({ afterMinutes: 30 });
    expect((await ownerAccept(m1, 6)).standby).toMatchObject({ coordinator: m1, epoch: 6 });
    expect(pair.m3.standby.get(logicalProjectId)?.armedBy).toEqual({ kind: "owner" });
  });

  it("never replaces a registration for a newer coordinator, on the peer's path", async () => {
    const { pair, logicalProjectId, m1, consent, writeConsent, ownerAccept, peerAccept } =
      await setup();
    await writeConsent(consent());
    await ownerAccept(m1, 6);
    expect((await pair.m3.fails(peerAccept({ epoch: 5 }))).code).toBe("superseded_conflict");
    expect((await pair.m3.fails(peerAccept({ epoch: 6 }))).code).toBe("superseded_conflict");
    expect(pair.m3.standby.get(logicalProjectId)).toMatchObject({ coordinator: m1, epoch: 6 });
    expect(await peerAccept({ epoch: 7 })).toMatchObject({
      standby: { coordinator: pair.kept, epoch: 7 },
    });
    // The owner's own registration of the same coordinator keeps the owner's mark.
    await ownerAccept(pair.kept, 8);
    await peerAccept({ epoch: 8 });
    expect(pair.m3.standby.get(logicalProjectId)).toMatchObject({
      epoch: 8,
      afterMinutes: 5,
      armedBy: { kind: "owner" },
    });
  });

  it("refuses a coordinator at this copy's epoch when it gave way to another there", async () => {
    const { pair, logicalProjectId, m1, consent, writeConsent, ownerAccept, peerAccept } =
      await setup();
    await writeConsent(consent());
    // A person took the project over on M1 at epoch 3, the same epoch an automatic takeover computes.
    const copy = pair.m3.projects.get(pair.joining.projectId)!;
    const settings = copy.workspaceSettings!;
    pair.m3.projects.set(pair.joining.projectId, {
      ...copy,
      workspaceSettings: {
        ...settings,
        coordinatorBinding: {
          ...settings.coordinatorBinding!,
          state: "transferred",
          epoch: 3,
          successor: m1,
        },
      },
    });
    expect((await pair.m3.fails(peerAccept({ epoch: 3 }))).code).toBe("superseded_conflict");
    expect((await pair.m3.fails(ownerAccept(pair.kept, 3))).code).toBe("superseded_conflict");
    expect(pair.m3.standby.size).toBe(0);
    // The successor it gave way to, or a later epoch, is still accepted.
    expect((await ownerAccept(m1, 3)).standby).toMatchObject({ coordinator: m1, epoch: 3 });
    expect(await peerAccept({ epoch: 4 })).toMatchObject({
      standby: { coordinator: pair.kept, epoch: 4 },
    });
    expect(pair.m3.standby.get(logicalProjectId)).toMatchObject({ epoch: 4 });
  });

  it("keeps a registration from before re-arm marked as the owner's when a peer repeats it", async () => {
    const { pair, logicalProjectId, consent, writeConsent, ownerAccept, peerAccept } =
      await setup();
    await writeConsent(consent());
    await ownerAccept(pair.kept, 4, 5);
    const { armedBy: _armedBy, ...older } = pair.m3.standby.get(logicalProjectId)!;
    pair.m3.standby.set(logicalProjectId, older);
    expect(await peerAccept({ epoch: 4 })).toMatchObject({ replayed: true });
    expect(pair.m3.standby.get(logicalProjectId)?.armedBy).toBeUndefined();
  });

  it("disarms with belowEpoch only a registration older than it", async () => {
    const { pair, logicalProjectId, ownerAccept } = await setup();
    await ownerAccept(pair.kept, 5);
    const disarm = (belowEpoch: number) =>
      on(pair.m3, (service) =>
        service.acceptStandby({
          projectId: pair.joining.projectId,
          logicalProjectId,
          standby: null,
          belowEpoch,
        }),
      );
    expect(await disarm(5)).toMatchObject({ replayed: true, standby: { epoch: 5 } });
    expect(pair.m3.standby.size).toBe(1);
    expect(await disarm(6)).toEqual({ standby: null, replayed: false });
    expect(pair.m3.standby.size).toBe(0);
    expect(await disarm(6)).toEqual({ standby: null, replayed: true });
  });

  it("clears this copy's consent when it leaves the project", async () => {
    const { pair, logicalProjectId, consent, writeConsent } = await setup();
    await writeConsent(consent());
    await on(pair.m3, (service) =>
      service.unlink({
        operationId: "99999999-9999-4999-8999-999999999999",
        projectId: pair.joining.projectId,
        side: "member",
        notes: [],
      }),
    );
    expect(pair.m3.rearm.has(logicalProjectId)).toBe(false);
  });
});

describe("a stale standby does not fire", () => {
  /** M3 stands by for M4 at epoch 0 and heard its last lease 20 minutes ago. */
  const silent = async () => {
    const context = await setup();
    const { pair, logicalProjectId, ownerAccept } = context;
    await ownerAccept(pair.kept, 0);
    const record = pair.m3.standby.get(logicalProjectId)!;
    const at = DateTime.toEpochMillis(DateTime.nowUnsafe()) - 20 * 60_000;
    pair.m3.standby.set(logicalProjectId, {
      ...record,
      lastLeaseAt: iso(at),
      lastSeq: 3,
      watchingSince: iso(at - 60_000),
      leaseSinceWatching: true,
    });
    const auto = (knownHigherEpoch?: number) =>
      on(pair.m3, (service) => service.autoTakeover({ logicalProjectId, knownHigherEpoch }));
    return { ...context, auto };
  };

  it("disarms when another machine claimed the epoch it would take over at", async () => {
    const { pair, logicalProjectId, auto } = await silent();
    pair.m3.epochs.set(logicalProjectId, {
      logicalProjectId,
      epoch: 1,
      claimedBy: "m1",
      claimedAt: "",
    });
    expect(await auto()).toEqual({ outcome: "disarmed" });
    expect(pair.m3.standby.size).toBe(0);
    expect(pair.m3.ownershipModes).toEqual(["join-as-member"]);
  });

  it("disarms when a member reported a newer active coordinator", async () => {
    const { pair, auto } = await silent();
    expect(await auto(1)).toEqual({ outcome: "disarmed" });
    expect(pair.m3.standby.size).toBe(0);
  });

  it("still fires over an older claim, or its own", async () => {
    const { pair, logicalProjectId, auto } = await silent();
    pair.m3.epochs.set(logicalProjectId, {
      logicalProjectId,
      epoch: 1,
      claimedBy: pair.m3.environmentId,
      claimedAt: "",
    });
    const taken = await auto(0);
    expect(taken.outcome).toBe("taken-over");
  });
});
