// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { SPECWEAVE_DECLINED_WAKE, SPECWEAVE_SET_UP_WAKE } from "@specweave-studio/contracts";

import {
  answerSpecweave,
  isOpenRequest,
  markSettingUp,
  openSetupRequest,
  readProjectFacts,
  recordDeclined,
  recordSetupSuccess,
  setRequestState,
  settleAfterSetup,
  specweaveSetupFile,
  specweaveWakeMessage,
} from "./SpecweaveSetupRequests.ts";

const roots: string[] = [];
async function stateFile() {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "specweave-requests-"));
  roots.push(root);
  return specweaveSetupFile(root);
}
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

describe("SpecweaveSetupRequests (1396 AC-05, AC-07)", () => {
  it("keeps one open card per project: a second request returns the open one", async () => {
    const file = await stateFile();
    const first = await openSetupRequest(file, {
      projectId: "p1",
      threadId: "thread-a",
      gitRepository: false,
    });
    expect(first.created).toBe(true);
    expect(first.request).toMatchObject({
      threadId: "thread-a",
      state: "asking",
      gitRepository: false,
    });
    const second = await openSetupRequest(file, {
      projectId: "p1",
      threadId: "thread-b",
      gitRepository: true,
    });
    expect(second.created).toBe(false);
    expect(second.request.requestId).toBe(first.request.requestId);
    expect(second.request.threadId).toBe("thread-a");
    // Another project gets its own card.
    const other = await openSetupRequest(file, {
      projectId: "p2",
      threadId: "thread-c",
      gitRepository: true,
    });
    expect(other.created).toBe(true);
  });

  it("moves a card through its states, stays answerable after a failure, and opens a new one once settled", async () => {
    const file = await stateFile();
    const { request } = await openSetupRequest(file, {
      projectId: "p1",
      threadId: "t",
      gitRepository: true,
    });
    const failed = await setRequestState(file, {
      projectId: "p1",
      requestId: request.requestId,
      state: "failed",
      detail: "specweave init exited with 1.",
    });
    expect(failed).toMatchObject({ state: "failed", detail: "specweave init exited with 1." });
    expect(isOpenRequest(failed ?? undefined)).toBe(true);
    const on = await setRequestState(file, {
      projectId: "p1",
      requestId: request.requestId,
      state: "on",
    });
    expect(on?.state).toBe("on");
    expect(on?.detail).toBeUndefined();
    expect(isOpenRequest(on ?? undefined)).toBe(false);
    // A stale request id moves nothing.
    expect(
      await setRequestState(file, { projectId: "p1", requestId: "stale", state: "declined" }),
    ).toBeNull();
    const next = await openSetupRequest(file, {
      projectId: "p1",
      threadId: "t2",
      gitRepository: true,
    });
    expect(next.created).toBe(true);
  });

  it("stores the decline until a successful setup clears it", async () => {
    const file = await stateFile();
    expect(await readProjectFacts(file, "p1")).toEqual({});
    await recordDeclined(file, "p1");
    expect((await readProjectFacts(file, "p1")).declined).toBe(true);
    await recordSetupSuccess(file, "p1");
    expect(await readProjectFacts(file, "p1")).toEqual({});
  });

  it("serializes concurrent writes so none is lost", async () => {
    const file = await stateFile();
    await Promise.all(
      Array.from({ length: 12 }, (_, index) => recordDeclined(file, `p${String(index)}`)),
    );
    for (let index = 0; index < 12; index += 1) {
      expect((await readProjectFacts(file, `p${String(index)}`)).declined).toBe(true);
    }
  });

  it("reads a missing or broken file as empty", async () => {
    const file = await stateFile();
    await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true });
    await NodeFSP.writeFile(file, "{not json");
    expect(await readProjectFacts(file, "p1")).toEqual({});
    await recordDeclined(file, "p1");
    expect((await readProjectFacts(file, "p1")).declined).toBe(true);
  });

  it("a card's setup moves it to setting up, then on, and wakes its thread once", async () => {
    const file = await stateFile();
    const { request } = await openSetupRequest(file, {
      projectId: "p1",
      threadId: "thread-a",
      gitRepository: true,
    });
    expect((await markSettingUp(file, "p1", request.requestId))?.state).toBe("setting_up");
    const settled = await settleAfterSetup(file, {
      projectId: "p1",
      requestId: request.requestId,
      result: { ok: true },
    });
    expect(settled.request?.state).toBe("on");
    expect(settled.wake).toEqual({
      threadId: "thread-a",
      requestId: request.requestId,
      outcome: "set_up",
    });
    expect(specweaveWakeMessage(settled.wake!)).toEqual({
      id: `specweave-setup:${request.requestId}:set_up`,
      text: SPECWEAVE_SET_UP_WAKE,
    });
    // The card is settled: a second setup wakes nothing.
    expect(await settleAfterSetup(file, { projectId: "p1", result: { ok: true } })).toEqual({});
  });

  it("a Board setup settles the open card too; a Board failure leaves it alone", async () => {
    const file = await stateFile();
    await openSetupRequest(file, { projectId: "p1", threadId: "thread-a", gitRepository: true });
    const failed = await settleAfterSetup(file, {
      projectId: "p1",
      result: { ok: false, detail: "npm failed", needsNode: false },
    });
    expect(failed).toEqual({});
    expect((await readProjectFacts(file, "p1")).request?.state).toBe("asking");
    const settled = await settleAfterSetup(file, { projectId: "p1", result: { ok: true } });
    expect(settled.wake?.outcome).toBe("set_up");
  });

  it.each([
    [false, "failed"],
    [true, "node_missing"],
  ] as const)(
    "a card's failed setup (needsNode %s) reads %s with the reason",
    async (needsNode, state) => {
      const file = await stateFile();
      const { request } = await openSetupRequest(file, {
        projectId: "p1",
        threadId: "thread-a",
        gitRepository: true,
      });
      const settled = await settleAfterSetup(file, {
        projectId: "p1",
        requestId: request.requestId,
        result: { ok: false, detail: "Node.js is missing", needsNode },
      });
      expect(settled.request).toMatchObject({ state, detail: "Node.js is missing" });
      expect(settled.wake).toBeUndefined();
      expect(isOpenRequest(settled.request)).toBe(true);
    },
  );

  it("Plan without it declines the project, closes the card and wakes its thread", async () => {
    const file = await stateFile();
    const { request } = await openSetupRequest(file, {
      projectId: "p1",
      threadId: "thread-a",
      gitRepository: true,
    });
    const answered = await answerSpecweave(file, {
      projectId: "p1",
      answer: "plan_without",
      requestId: request.requestId,
    });
    expect(answered.facts.declined).toBe(true);
    expect(answered.request?.state).toBe("declined");
    expect(specweaveWakeMessage(answered.wake!).text).toBe(SPECWEAVE_DECLINED_WAKE);
    const again = await answerSpecweave(file, { projectId: "p1", answer: "plan_without" });
    expect(again.wake).toBeUndefined();
  });

  it.each([
    ["not_now", true, false],
    ["advice_dismissed", true, true],
    ["advice_seen", false, true],
  ] as const)("%s: declined %s, advice seen %s, no wake", async (answer, declined, seen) => {
    const file = await stateFile();
    await openSetupRequest(file, { projectId: "p1", threadId: "thread-a", gitRepository: true });
    const answered = await answerSpecweave(file, { projectId: "p1", answer });
    expect(answered.facts.declined === true).toBe(declined);
    expect(answered.facts.adviceSeen === true).toBe(seen);
    expect(answered.wake).toBeUndefined();
    expect(answered.facts.request?.state).toBe("asking");
  });

  it("a stale press on a settled card changes nothing", async () => {
    const file = await stateFile();
    const { request } = await openSetupRequest(file, {
      projectId: "p1",
      threadId: "thread-a",
      gitRepository: true,
    });
    await settleAfterSetup(file, {
      projectId: "p1",
      requestId: request.requestId,
      result: { ok: true },
    });
    expect(await markSettingUp(file, "p1", request.requestId)).toBeNull();
    const failed = await settleAfterSetup(file, {
      projectId: "p1",
      requestId: request.requestId,
      result: { ok: false, detail: "npm failed", needsNode: false },
    });
    expect(failed).toEqual({});
    expect((await readProjectFacts(file, "p1")).request?.state).toBe("on");
  });

  // A press that read the card open before a settle landed used to write over
  // the settle. The open check and the write are now one queued step.
  it("two presses landing at once never flip a settled card back or wake twice", async () => {
    for (let round = 0; round < 10; round += 1) {
      const file = await stateFile();
      const { request } = await openSetupRequest(file, {
        projectId: "p1",
        threadId: "thread-a",
        gitRepository: true,
      });
      const press = async () => {
        await markSettingUp(file, "p1", request.requestId);
        return settleAfterSetup(file, {
          projectId: "p1",
          requestId: request.requestId,
          result: { ok: true },
        });
      };
      const settled = await Promise.all([press(), press()]);
      expect(settled.filter((result) => result.wake !== undefined)).toHaveLength(1);
      expect((await readProjectFacts(file, "p1")).request?.state).toBe("on");
      // A late press whose read raced a settle leaves the card On.
      const late = await Promise.all([
        settleAfterSetup(file, { projectId: "p1", result: { ok: true } }),
        markSettingUp(file, "p1", request.requestId),
      ]);
      expect(late[1]).toBeNull();
      expect((await readProjectFacts(file, "p1")).request?.state).toBe("on");
    }
  });

  it("a press and a settle landing at once leave the card On", async () => {
    for (let round = 0; round < 20; round += 1) {
      const file = await stateFile();
      const { request } = await openSetupRequest(file, {
        projectId: "p1",
        threadId: "thread-a",
        gitRepository: true,
      });
      await markSettingUp(file, "p1", request.requestId);
      await Promise.all([
        settleAfterSetup(file, {
          projectId: "p1",
          requestId: request.requestId,
          result: { ok: true },
        }),
        markSettingUp(file, "p1", request.requestId),
      ]);
      expect((await readProjectFacts(file, "p1")).request?.state).toBe("on");
    }
  });
});
