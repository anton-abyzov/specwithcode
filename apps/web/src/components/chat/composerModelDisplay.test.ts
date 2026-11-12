import { ProviderInstanceId } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import { NO_PROVIDER_MODEL_SELECTION } from "~/providerInstances";

import { composerChipModel, composerDisplayedThreadSelection } from "./composerModelDisplay";

const codex = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" };
const claude = { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-opus-5-5" };

describe("composerDisplayedThreadSelection", () => {
  it("names a new chat's send target, not the Choose a model placeholder", () => {
    expect(
      composerDisplayedThreadSelection({
        isServerThread: false,
        threadSelection: NO_PROVIDER_MODEL_SELECTION,
        sendTarget: codex,
      }),
    ).toEqual(codex);
  });

  it("follows a pick on a draft at once, even over a project default seed", () => {
    expect(
      composerDisplayedThreadSelection({
        isServerThread: false,
        threadSelection: claude,
        sendTarget: codex,
      }),
    ).toEqual(codex);
  });

  it("keeps a saved thread on its own model, which a pending pick is compared with", () => {
    expect(
      composerDisplayedThreadSelection({
        isServerThread: true,
        threadSelection: claude,
        sendTarget: codex,
      }),
    ).toEqual(claude);
  });

  it("keeps the placeholder on a draft only when no provider can run it", () => {
    expect(
      composerDisplayedThreadSelection({
        isServerThread: false,
        threadSelection: NO_PROVIDER_MODEL_SELECTION,
        sendTarget: NO_PROVIDER_MODEL_SELECTION,
      }),
    ).toEqual(NO_PROVIDER_MODEL_SELECTION);
  });
});

describe("composerChipModel", () => {
  it("names the thread's model when nothing else was picked", () => {
    for (const turnRunning of [false, true])
      expect(
        composerChipModel({ current: claude, pick: claude, pickExplicit: true, turnRunning }),
      ).toEqual({ shown: claude, state: "thread" });
  });

  it("keeps a running turn's model and reads the pick as next", () => {
    expect(
      composerChipModel({ current: claude, pick: codex, pickExplicit: true, turnRunning: true }),
    ).toEqual({ shown: claude, state: "next" });
  });

  it("names the pick itself once the turn has stopped", () => {
    expect(
      composerChipModel({ current: claude, pick: codex, pickExplicit: true, turnRunning: false }),
    ).toEqual({ shown: codex, state: "pick" });
  });

  it("names another model of the same provider at once too", () => {
    const sonnet = { instanceId: claude.instanceId, model: "claude-sonnet-5-5" };
    expect(
      composerChipModel({ current: claude, pick: sonnet, pickExplicit: true, turnRunning: false }),
    ).toEqual({ shown: sonnet, state: "pick" });
  });

  it("ignores a seeded draft copy that is no pick, running or not", () => {
    for (const turnRunning of [false, true])
      expect(
        composerChipModel({ current: claude, pick: codex, pickExplicit: false, turnRunning }),
      ).toEqual({ shown: claude, state: "thread" });
  });
});
