import { ProviderInstanceId } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import { NO_PROVIDER_MODEL_SELECTION } from "~/providerInstances";

import { composerDisplayedThreadSelection } from "./composerModelDisplay";

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

  it("keeps a saved thread on its own model so a pending pick reads next", () => {
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
