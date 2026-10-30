import { ProviderInstanceId, type ServerProvider } from "@specweave-studio/contracts";
import { createModelSelection } from "@specweave-studio/shared/model";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const toasts = vi.hoisted(() => [] as Array<{ title?: string }>);
vi.mock("~/components/ui/toast", () => ({
  stackedThreadToast: (toast: object) => toast,
  toastManager: { add: (toast: { title?: string }) => toasts.push(toast) },
}));

import { useComposerDraftStore } from "../composerDraftStore";
import { followNewestModels } from "./followNewestModels";

const claude = ProviderInstanceId.make("claudeAgent");
const codex = ProviderInstanceId.make("codex");
const providers = [
  {
    instanceId: claude,
    models: [
      { slug: "claude-opus-5-5", name: "Claude Opus 5.5" },
      { slug: "claude-opus-6", name: "Claude Opus 6" },
    ],
  },
  { instanceId: codex, models: [{ slug: "gpt-6.1-sol", name: "GPT-6.1-Sol" }] },
] as unknown as ReadonlyArray<ServerProvider>;

describe("followNewestModels", () => {
  beforeEach(() => {
    toasts.length = 0;
    useComposerDraftStore.setState({
      stickyModelSelectionByProvider: {
        [claude]: createModelSelection(claude, "claude-opus-5-5"),
        [codex]: createModelSelection(codex, "gpt-6.1-sol"),
      },
      stickyActiveProvider: codex,
    });
  });

  it("moves a followed family to its newest version and keeps the active provider", () => {
    followNewestModels(providers, { [claude]: "opus" });
    const state = useComposerDraftStore.getState();
    expect(state.stickyModelSelectionByProvider[claude]?.model).toBe("claude-opus-6");
    expect(state.stickyActiveProvider).toBe(codex);
    expect(toasts.map((toast) => toast.title)).toEqual(["New chats now use Claude Opus 6"]);
  });

  it("changes nothing without a followed family", () => {
    followNewestModels(providers, {});
    expect(useComposerDraftStore.getState().stickyModelSelectionByProvider[claude]?.model).toBe(
      "claude-opus-5-5",
    );
    expect(toasts).toEqual([]);
  });

  it("never follows to a model hidden in the provider's settings", () => {
    followNewestModels(
      providers,
      { [claude]: "opus" },
      { [claude]: { hiddenModels: ["claude-opus-6"] } },
    );
    expect(useComposerDraftStore.getState().stickyModelSelectionByProvider[claude]?.model).toBe(
      "claude-opus-5-5",
    );
    expect(toasts).toEqual([]);
  });
});
