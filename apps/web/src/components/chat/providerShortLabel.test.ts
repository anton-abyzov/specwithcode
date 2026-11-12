import { ProviderInstanceId } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import { chipAccountTag, providerShortLabels } from "./providerShortLabel";

const entry = (
  id: string,
  driverKind: string,
  displayName: string,
  auth: Record<string, unknown> = { status: "unknown" },
  acpRegistryAgentId?: string,
) =>
  ({
    instanceId: ProviderInstanceId.make(id),
    driverKind,
    displayName,
    acpRegistryAgentId,
    snapshot: { auth },
  }) as never;

describe("providerShortLabels", () => {
  it("tells two accounts of one product apart by the word that differs", () => {
    const labels = providerShortLabels([
      entry("a", "acpRegistry", "Copilot Enterprise (acme-corp)", undefined, "github-copilot"),
      entry("b", "acpRegistry", "Copilot personal (fixture-person)", undefined, "github-copilot"),
    ]);
    expect([...labels.values()]).toEqual(["Enterprise", "Personal"]);
  });

  it("names a lone provider by its plan, else its short name", () => {
    const labels = providerShortLabels([
      entry("claudeAgent", "claudeAgent", "Claude Code", {
        status: "authenticated",
        label: "Claude Max",
      }),
      entry("codex", "codex", "Codex (work)"),
    ]);
    expect([...labels.values()]).toEqual(["Claude Max", "Codex"]);
  });

  it("keeps whole names when the short ones would read alike", () => {
    const labels = providerShortLabels([
      entry("a", "codex", "Codex"),
      entry("b", "codex", "Codex"),
    ]);
    expect([...labels.values()]).toEqual(["Codex", "Codex"]);
  });
});

describe("chipAccountTag", () => {
  const copilots = [
    entry("a", "acpRegistry", "Copilot Enterprise (acme-corp)", undefined, "github-copilot"),
    entry("b", "acpRegistry", "Copilot personal (fixture-person)", undefined, "github-copilot"),
    entry("claudeAgent", "claudeAgent", "Claude Code", {
      status: "authenticated",
      label: "Claude Max",
    }),
  ];
  it("tags the chip only when the product is signed in more than once", () => {
    expect(chipAccountTag(copilots, ProviderInstanceId.make("b"))).toBe("Personal");
    expect(chipAccountTag(copilots, ProviderInstanceId.make("claudeAgent"))).toBeNull();
    expect(chipAccountTag(copilots, ProviderInstanceId.make("missing"))).toBeNull();
  });
});
