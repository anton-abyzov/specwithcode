// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { SPECWEAVE_NEEDED_MESSAGE } from "@specweave-studio/contracts";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  readProjectFacts,
  recordDeclined,
  specweaveSetupFile,
} from "../../../project/SpecweaveSetupRequests.ts";
import {
  SPECWEAVE_ALREADY_ON_MESSAGE,
  SPECWEAVE_CARD_ELSEWHERE_MESSAGE,
  SPECWEAVE_CARD_OPEN_MESSAGE,
  SPECWEAVE_DECLINED_MESSAGE,
  SPECWEAVE_PERSONAL_MESSAGE,
  launchPlansWithoutSpecweave,
  raiseSetupCardBeside,
  requestSpecweaveSetup,
  setupTargetOf,
  specweaveNeededLaunch,
  type SpecweaveSetupTarget,
} from "./requestSpecweaveSetup.ts";

const roots: string[] = [];
async function temp(prefix: string) {
  const root = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), prefix)),
  );
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

async function target(
  options: { git?: boolean; on?: boolean; personal?: boolean; threadId?: string | null } = {},
): Promise<SpecweaveSetupTarget> {
  const workspaceRoot = await temp("request-setup-project-");
  if (options.git === true)
    NodeChildProcess.execFileSync("git", ["init", "-q"], { cwd: workspaceRoot });
  if (options.on === true) {
    await NodeFSP.mkdir(NodePath.join(workspaceRoot, ".specweave"), { recursive: true });
    await NodeFSP.writeFile(NodePath.join(workspaceRoot, ".specweave/config.json"), "{}");
  }
  return {
    stateDir: await temp("request-setup-state-"),
    projectId: "project-1",
    workspaceRoot,
    personal: options.personal === true,
    threadId: options.threadId === undefined ? "thread-1" : options.threadId,
  };
}

describe("request_specweave_setup (1396 AC-06)", () => {
  it("raises one card in the asking thread, with the Git hint read from the folder", async () => {
    const plain = await target();
    const result = await requestSpecweaveSetup(plain);
    expect(result).toMatchObject({
      raised: true,
      state: "off",
      message: SPECWEAVE_CARD_OPEN_MESSAGE,
    });
    expect(result.specweaveSetupRequest).toMatchObject({
      threadId: "thread-1",
      state: "asking",
      gitRepository: false,
    });
    // A second thread of the project gets the open card back, not a new one.
    const again = await requestSpecweaveSetup({ ...plain, threadId: "thread-2" });
    expect(again.message).toBe(SPECWEAVE_CARD_ELSEWHERE_MESSAGE);
    expect(again.specweaveSetupRequest?.requestId).toBe(result.specweaveSetupRequest?.requestId);

    const repo = await target({ git: true });
    expect((await requestSpecweaveSetup(repo)).specweaveSetupRequest?.gitRepository).toBe(true);
  });

  it("raises nothing where SpecWeave is on or for a personal assistant, and says so", async () => {
    expect(await requestSpecweaveSetup(await target({ on: true }))).toEqual({
      raised: false,
      state: "on",
      message: SPECWEAVE_ALREADY_ON_MESSAGE,
    });
    expect(await requestSpecweaveSetup(await target({ personal: true }))).toEqual({
      raised: false,
      state: "off",
      message: SPECWEAVE_PERSONAL_MESSAGE,
    });
  });

  it("after Plan without it raises nothing, unless the user asked again", async () => {
    const declined = await target();
    await recordDeclined(specweaveSetupFile(declined.stateDir), declined.projectId);
    expect(await requestSpecweaveSetup(declined)).toMatchObject({
      raised: false,
      message: SPECWEAVE_DECLINED_MESSAGE,
    });
    expect(await launchPlansWithoutSpecweave(declined)).toBe(true);
    expect((await requestSpecweaveSetup(declined, { askedByUser: true })).raised).toBe(true);
  });

  it("a launch that needs SpecWeave returns the instruction and the card", async () => {
    const plain = await target();
    const needed = await specweaveNeededLaunch(plain);
    expect(needed).toMatchObject({
      launched: false,
      needs: "specweave",
      message: SPECWEAVE_NEEDED_MESSAGE,
    });
    expect(needed.specweaveSetupRequest?.threadId).toBe("thread-1");
    expect(SPECWEAVE_NEEDED_MESSAGE).toBe(
      "SpecWeave is not set up in this project. The user has a card to set it up. End your turn; their answer wakes you.",
    );
    // Outside a thread there is no card, but the launch still stops.
    expect(
      (await specweaveNeededLaunch(await target({ threadId: null }))).specweaveSetupRequest,
    ).toBeUndefined();
  });

  it("raises the card beside an unfinished project's launch, never after a decline", async () => {
    const plain = await target();
    await raiseSetupCardBeside(plain);
    expect((await requestSpecweaveSetup(plain)).specweaveSetupRequest?.threadId).toBe("thread-1");
    const declined = await target();
    await recordDeclined(specweaveSetupFile(declined.stateDir), declined.projectId);
    await raiseSetupCardBeside(declined);
    expect(
      (await readProjectFacts(specweaveSetupFile(declined.stateDir), declined.projectId)).request,
    ).toBeUndefined();
  });

  it("puts a launch's card in the caller's thread in that project, else its coordinator", () => {
    const project = {
      id: "project-1",
      workspaceRoot: "/p",
      workspaceSettings: { kind: "code", coordinatorThreadId: "coordinator" },
    };
    expect(setupTargetOf(project, { id: "worker", projectId: "project-1" }, "/s").threadId).toBe(
      "worker",
    );
    expect(setupTargetOf(project, { id: "elsewhere", projectId: "other" }, "/s").threadId).toBe(
      "coordinator",
    );
    expect(setupTargetOf(project, undefined, "/s").threadId).toBe("coordinator");
  });
});
