/** The receiver delta reviews: start-only sends, reach, credentials and membership. */
import { describe, expect, it } from "@effect/vitest";
import { parseTeamRulesText, type TeamRulesState } from "@specweave-studio/shared/teamRules";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import {
  M5,
  LINUX,
  M4,
  PROJECT,
  WORKER,
  memberOf,
  members,
  projectOf,
  policyFor,
  callerFrom,
  request,
  deliver,
  refusedWith,
  settle,
  records,
  run,
  namesBoth,
} from "./CoordinatorMessageReceiver.testkit.ts";

describe("CoordinatorMessageReceiver starts a turn now or keeps the message (round 3 finding 1)", () => {
  it.effect("asks for a turn that starts now, never one that waits in the thread's queue", () =>
    run((receiver, harness) =>
      Effect.gen(function* () {
        yield* deliver(receiver, callerFrom(LINUX), request());
        yield* settle;
        expect(harness.sends[0]!.startOnly).toBe(true);
        expect(harness.sends[0]!.mode).toBe("queue");
        expect(harness.dispatched).toEqual([]);
      }),
    ),
  );

  it.effect("keeps a message the thread cannot start now, and checks it all again next time", () =>
    run((receiver, harness) =>
      Effect.gen(function* () {
        yield* deliver(receiver, callerFrom(LINUX), request());
        harness.send = "refused";
        yield* settle;
        expect(harness.sends).toHaveLength(1);
        expect((yield* records)[0]!.state).toBe("settling");
        // Nothing waits anywhere but the store, so a revoke now keeps it from the agent.
        harness.policies.set(LINUX, policyFor(LINUX, { revokedAt: "1970-01-01T00:01:00.000Z" }));
        harness.send = "started";
        yield* receiver.flush;
        expect(harness.sends).toHaveLength(1);
        expect((yield* records)[0]!.state).toBe("refused");
        expect(harness.dispatched).toEqual([]);
      }),
    ),
  );

  it.effect("retries a send under the same ids, so one that started is never sent twice", () =>
    run((receiver, harness) =>
      Effect.gen(function* () {
        yield* deliver(receiver, callerFrom(LINUX), request());
        harness.send = "unknown";
        yield* settle;
        expect((yield* records)[0]!.state).toBe("settling");
        harness.send = "refused";
        yield* receiver.flush;
        harness.send = "started";
        yield* receiver.flush;
        expect(harness.sends).toHaveLength(3);
        expect(new Set(harness.sends.map((send) => send.commandId)).size).toBe(1);
        expect(new Set(harness.sends.map((send) => send.messageId)).size).toBe(1);
        expect((yield* records)[0]!.state).toBe("delivered");
      }),
    ),
  );

  it.effect("sends newer merged text under a new id", () =>
    run((receiver, harness) =>
      Effect.gen(function* () {
        yield* deliver(receiver, callerFrom(LINUX), request());
        harness.send = "refused";
        yield* settle;
        yield* deliver(receiver, callerFrom(LINUX), request({ text: "Newer text." }));
        harness.send = "started";
        yield* receiver.flush;
        expect(harness.sends[1]!.text).toContain("Newer text.");
        expect(harness.sends[1]!.commandId).not.toBe(harness.sends[0]!.commandId);
      }),
    ),
  );

  it.effect("never marks a message delivered when a repeat merged into it during the send", () =>
    run((receiver, harness) =>
      Effect.gen(function* () {
        yield* deliver(receiver, callerFrom(LINUX), request());
        harness.duringSend = deliver(receiver, callerFrom(LINUX), request({ text: "Newer text." }));
        yield* settle;
        const row = (yield* records)[0]!;
        expect(row.count).toBe(2);
        expect(row.state).not.toBe("delivered");
        yield* TestClock.adjust("46 seconds");
        yield* receiver.flush;
        expect(harness.sends.at(-1)!.text).toContain("Newer text.");
        expect((yield* records)[0]!.state).toBe("delivered");
      }),
    ),
  );
});

const rulesWith = (reach: Record<string, unknown>, fingerprint = "3a9f"): TeamRulesState => {
  const parsed = parseTeamRulesText(JSON.stringify({ version: 1, owner: "Release notes", reach }));
  if (!parsed.ok) throw new Error(parsed.issues.join("\n"));
  return { status: "active", rules: parsed.rules, fingerprint, warnings: [] };
};

describe("CoordinatorMessageReceiver applies the reach rules again at delivery (round 3 finding 2)", () => {
  it.effect("drops a message after the rules stop other machines reaching this one", () =>
    run((receiver, harness) =>
      Effect.gen(function* () {
        yield* deliver(receiver, callerFrom(LINUX), request());
        harness.teamRules = rulesWith({ machines: "none" });
        yield* settle;
        expect(harness.sends).toHaveLength(0);
        expect((yield* records)[0]!.state).toBe("refused");
      }),
    ),
  );

  it.effect("drops a message after this machine's rules no longer match the sender's", () =>
    run((receiver, harness) =>
      Effect.gen(function* () {
        harness.teamRules = rulesWith({ machines: "same-rules" });
        yield* deliver(receiver, callerFrom(LINUX), request(), true, "3a9f");
        yield* settle;
        expect(harness.sends).toHaveLength(1);
        yield* deliver(
          receiver,
          callerFrom(LINUX),
          request({ subject: "Second subject" }),
          true,
          "3a9f",
        );
        harness.teamRules = rulesWith({ machines: "same-rules" }, "77bb");
        yield* settle;
        expect(harness.sends).toHaveLength(1);
        expect((yield* records)[1]!.state).toBe("refused");
      }),
    ),
  );

  it.effect("checks each message at its own time, not the time the pass began", () =>
    run((receiver, harness) =>
      Effect.gen(function* () {
        harness.policies.set(LINUX, policyFor(LINUX, { endsAt: "1970-01-01T00:00:50.000Z" }));
        yield* deliver(
          receiver,
          callerFrom(LINUX),
          request({ kind: "finding", subject: "First", refs: [] }),
        );
        yield* deliver(
          receiver,
          callerFrom(LINUX),
          request({ kind: "finding", subject: "Second", refs: [] }),
        );
        // The first send takes ten seconds; the grant ends during it.
        harness.duringSend = TestClock.adjust("10 seconds");
        yield* settle;
        expect(harness.sends).toHaveLength(1);
        expect((yield* records).map((row) => row.state)).toEqual(["delivered", "refused"]);
      }),
    ),
  );
});

describe("CoordinatorMessageReceiver binds a message to its exact member copies (round 3 finding 3)", () => {
  it.effect(
    "drops a message after its destination copy rejoined while another copy here stayed",
    () =>
      run((receiver, harness) =>
        Effect.gen(function* () {
          const second = memberOf(M5, "project-m5-second");
          harness.projects.set(PROJECT, projectOf(PROJECT, { members: [second, ...members] }));
          yield* deliver(receiver, callerFrom(LINUX), request());
          harness.projects.set(
            PROJECT,
            projectOf(PROJECT, {
              members: [second, memberOf(M5, PROJECT, 2), members[1]!, members[2]!],
            }),
          );
          yield* settle;
          expect(harness.sends).toHaveLength(0);
          expect((yield* records)[0]!.state).toBe("refused");
        }),
      ),
  );

  it.effect("refuses a sender with two copies in the project: it cannot say which one sent", () =>
    run((receiver, harness) =>
      Effect.gen(function* () {
        harness.projects.set(
          PROJECT,
          projectOf(PROJECT, { members: [...members, memberOf(LINUX, "project-linux-second")] }),
        );
        const refusal = yield* refusedWith(receiver, callerFrom(LINUX), request());
        expect(refusal.code).toBe("needs_grant");
        namesBoth(refusal, "linux-mini");
      }),
    ),
  );
});

describe("CoordinatorMessageReceiver never creates the grant it checks (delta finding 2)", () => {
  it.effect("names both machines when it keeps no grant for the sender", () =>
    run((receiver) =>
      Effect.gen(function* () {
        const refusal = yield* receiver.ungranted(LINUX);
        expect(refusal).toMatchObject({ status: 403, code: "needs_grant" });
        namesBoth(refusal, "linux-mini");
      }),
    ),
  );

  it.effect("resolves the route's grant without creating or settling a policy", () =>
    run((receiver, harness) =>
      Effect.gen(function* () {
        const client = {
          principal: { kind: "coordinator" as const, environmentId: LINUX },
          label: "linux-mini",
          access: "auto",
        };
        expect(yield* receiver.grantFor(client)).toMatchObject({
          coordinatorEnvironmentId: LINUX,
          revoked: false,
        });
        harness.policies.delete(LINUX);
        expect(yield* receiver.grantFor(client)).toBeUndefined();
        expect(yield* receiver.grantFor({ label: "a browser", access: "auto" })).toBeUndefined();
        expect(harness.grantCalls).not.toContain("forClient");
        expect(harness.grantCalls).not.toContain("policies");
        expect(harness.grantCalls).not.toContain("forCoordinator");
      }),
    ),
  );
});

describe("CoordinatorMessageReceiver checks the admitting credential again (delta finding 3)", () => {
  it.effect("drops a message whose admitting session ended", () =>
    run((receiver, harness) =>
      Effect.gen(function* () {
        yield* deliver(receiver, callerFrom(LINUX), request({ kind: "finding", refs: [] }));
        harness.sessions.delete(`session-${LINUX}`);
        yield* settle;
        expect(harness.sends).toHaveLength(0);
        expect((yield* records)[0]!.state).toBe("refused");
      }),
    ),
  );

  it.effect("drops a message whose admitting session expired, even while it is connected", () =>
    run((receiver, harness) =>
      Effect.gen(function* () {
        yield* deliver(receiver, callerFrom(LINUX), request({ kind: "finding", refs: [] }));
        harness.sessions.set(`session-${LINUX}`, {
          peer: LINUX,
          scopes: ["orchestration:read", "orchestration:operate"],
          expiresAt: 1000,
        });
        yield* settle;
        expect(harness.sends).toHaveLength(0);
        expect((yield* records)[0]!.state).toBe("refused");
      }),
    ),
  );

  it.effect("drops a problem whose admitting session lost the operate scope, not a finding", () =>
    run((receiver, harness) =>
      Effect.gen(function* () {
        yield* deliver(receiver, callerFrom(LINUX), request());
        yield* deliver(
          receiver,
          callerFrom(LINUX),
          request({ kind: "finding", subject: "A finding", refs: [] }),
        );
        harness.sessions.set(`session-${LINUX}`, { peer: LINUX, scopes: ["orchestration:read"] });
        yield* settle;
        expect(harness.sends).toHaveLength(1);
        expect(harness.sends[0]!.text).toContain("A finding");
        const states = (yield* records).map((row) => [row.kind, row.state]);
        expect(states).toEqual([
          ["problem", "refused"],
          ["finding", "delivered"],
        ]);
      }),
    ),
  );

  it.effect("drops a message whose session now acts for another machine", () =>
    run((receiver, harness) =>
      Effect.gen(function* () {
        yield* deliver(receiver, callerFrom(LINUX), request());
        harness.sessions.set(`session-${LINUX}`, {
          peer: M4,
          scopes: ["orchestration:read", "orchestration:operate"],
        });
        yield* settle;
        expect(harness.sends).toHaveLength(0);
      }),
    ),
  );
});

describe("CoordinatorMessageReceiver ties a message to its membership (delta finding 4)", () => {
  it.effect("drops a message after its sender left and joined again", () =>
    run((receiver, harness) =>
      Effect.gen(function* () {
        yield* deliver(receiver, callerFrom(LINUX), request());
        harness.projects.set(
          PROJECT,
          projectOf(PROJECT, {
            members: [members[0]!, memberOf(LINUX, "project-linux", 2), members[2]!],
          }),
        );
        yield* settle;
        expect(harness.sends).toHaveLength(0);
        expect((yield* records)[0]!.state).toBe("refused");
      }),
    ),
  );
});

describe("CoordinatorMessageReceiver frames only current members (delta finding 5)", () => {
  it.effect("leaves out a step and refs for a machine that left the project", () =>
    run((receiver, harness) =>
      Effect.gen(function* () {
        yield* deliver(
          receiver,
          callerFrom(LINUX),
          request({
            userStep: { environmentId: M4, text: "Restart the build on M4" },
            refs: [
              { kind: "thread", environmentId: M5, threadId: WORKER, title: "In the project" },
              { kind: "report", environmentId: M4, path: "reports/build.md", bytes: 900 },
              { kind: "file", environmentId: M4, path: "logs/build.log", bytes: 1200 },
              { kind: "report", environmentId: LINUX, path: "reports/kept.md", bytes: 300 },
            ],
          }),
        );
        harness.projects.set(PROJECT, projectOf(PROJECT, { members: [members[0]!, members[1]!] }));
        yield* settle;
        const text = harness.sends[0]!.text;
        expect(text).not.toContain("User step proposed");
        expect(text).not.toContain("Restart the build on M4");
        expect(text).not.toContain("on M4");
        expect(text).toContain("Report on linux-mini");
        expect(text).toContain("In the project");
        expect(text).toContain("2 references were left out");
      }),
    ),
  );
});
