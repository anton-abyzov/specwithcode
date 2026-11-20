// Whether the guide asks for a review (1398 AC-23): decided for the model that builds the feature.
import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ModelSelection,
  type ServerProvider,
} from "@specweave-studio/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));

const { secondFamilyReady } = await import("./FirstFeatureGuide");

const now = Date.parse("2026-11-18T12:00:00.000Z");
const provider = (id: string, slugs: ReadonlyArray<string>): ServerProvider => ({
  instanceId: ProviderInstanceId.make(id),
  driver: ProviderDriverKind.make(id),
  enabled: true,
  installed: true,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-11-18T12:00:00.000Z",
  version: null,
  models: slugs.map((slug) => ({ slug, name: slug, isCustom: false, capabilities: null })),
  slashCommands: [],
  skills: [],
});
const sel = (instanceId: string, model: string): ModelSelection => ({
  instanceId: ProviderInstanceId.make(instanceId),
  model,
});
const providers = [
  provider("claudeAgent", ["claude-opus-5-5"]),
  provider("codex", ["gpt-6.1-sol"]),
];
// The machine's default is Claude; the review order lists only a GPT model.
const settings = {
  ...DEFAULT_SERVER_SETTINGS,
  defaultModelSelection: sel("claudeAgent", "claude-opus-5-5"),
  adversarialReview: {
    autoOnFeatureComplete: false,
    reviewers: [sel("codex", "gpt-6.1-sol")],
    tier: "regular" as const,
  },
};
const ask = (author: ModelSelection | null) =>
  secondFamilyReady({
    providers,
    settings,
    project: null,
    projectId: ProjectId.make("sample"),
    author,
    nowMs: now,
  });

describe("secondFamilyReady", () => {
  it("asks about the coordinator that builds the feature, not the machine's default", () => {
    // Built by Claude: the GPT reviewer is another family.
    expect(ask(sel("claudeAgent", "claude-opus-5-5"))).toBe(true);
    // The sample's coordinator was switched to Codex: the only reviewer is the same family.
    expect(ask(sel("codex", "gpt-6.1-sol"))).toBe(false);
  });

  it("cannot tell without the builder, the providers or the settings", () => {
    expect(ask(null)).toBeNull();
    expect(
      secondFamilyReady({
        providers: undefined,
        settings,
        project: null,
        projectId: ProjectId.make("sample"),
        author: sel("codex", "gpt-6.1-sol"),
        nowMs: now,
      }),
    ).toBeNull();
  });
});
