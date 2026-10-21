import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ModelSelection,
} from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";
import { deriveProviderInstanceEntries } from "../providerInstances";
import {
  resolveComposerDraftProvider,
  resolveComposerProviderSelection,
  resolveComposerServerProviderSync,
} from "./ChatView.logic";

const claude = ProviderInstanceId.make("claudeAgent");
const acpCopilot = ProviderInstanceId.make("acpRegistry_copilot");
const githubCopilot = ProviderInstanceId.make("copilot");

const entries = deriveProviderInstanceEntries(
  (
    [
      ["claudeAgent", claude],
      ["acpRegistry", acpCopilot],
      ["copilot", githubCopilot],
    ] as const
  ).map(([driver, instanceId]) => ({
    driver: ProviderDriverKind.make(driver),
    instanceId,
    enabled: true,
    installed: true,
    status: "ready" as const,
    auth: { status: "authenticated" as const },
    version: null,
    checkedAt: "2026-10-20T18:30:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
  })),
);

const serverClaude: ModelSelection = { instanceId: claude, model: "claude-opus-5-5" };
const seededCopilot: ModelSelection = { instanceId: acpCopilot, model: "claude-opus-5.5" };

/** The provider the composer shows and sends to, as ChatView and ChatComposer resolve it. */
function composerProvider(draft: {
  provider: ProviderInstanceId | null;
  explicit: boolean;
}): ProviderInstanceId | undefined {
  return resolveComposerProviderSelection({
    entries,
    candidateInstanceIds: [
      resolveComposerDraftProvider({
        draftProvider: draft.provider,
        draftExplicit: draft.explicit,
        serverInstanceId: serverClaude.instanceId,
      }),
      // shell runtime and saved selection both name Claude after the return at reset
      claude,
      serverClaude.instanceId,
    ],
    // a thread that can hand off between providers leaves the picker unlocked
    lockedProvider: null,
    lockedInstanceId: claude,
  }).selectedProviderEntry?.instanceId;
}

describe("composer provider after a server-side switch while the chat was closed", () => {
  it("shows the thread's provider, not a stale seeded Copilot draft", () => {
    // Reported October 20, 2026: sidebar Claude, composer Copilot after the
    // limit fallback returned the thread to Claude at its reset.
    expect(composerProvider({ provider: acpCopilot, explicit: false })).toBe(claude);
  });

  it("keeps a provider the user picked and has not sent yet", () => {
    expect(composerProvider({ provider: acpCopilot, explicit: true })).toBe(acpCopilot);
  });

  it("keeps the two Copilot providers distinct", () => {
    expect(composerProvider({ provider: githubCopilot, explicit: true })).toBe(githubCopilot);
    expect(composerProvider({ provider: acpCopilot, explicit: true })).toBe(acpCopilot);
  });

  it("leaves unsaved drafts on their own provider", () => {
    expect(
      resolveComposerDraftProvider({
        draftProvider: acpCopilot,
        draftExplicit: false,
        serverInstanceId: null,
      }),
    ).toBe(acpCopilot);
  });
});

describe("resolveComposerServerProviderSync", () => {
  const base = {
    server: serverClaude,
    serverChangedInPlace: false,
    draftProvider: acpCopilot,
    draftExplicit: false,
    draftSelection: seededCopilot,
  };

  it("reseeds a stale seeded draft on arrival, reload or reconnect", () => {
    expect(resolveComposerServerProviderSync(base)).toBe("reseed");
  });

  it("reseeds a seeded draft whose model went stale on the same provider", () => {
    expect(
      resolveComposerServerProviderSync({
        ...base,
        draftProvider: claude,
        draftSelection: { instanceId: claude, model: "claude-opus-5" },
      }),
    ).toBe("reseed");
  });

  it("does nothing once the draft matches the server", () => {
    expect(
      resolveComposerServerProviderSync({
        ...base,
        draftProvider: claude,
        draftSelection: serverClaude,
      }),
    ).toBe("none");
  });

  it("keeps an unsent explicit pick on arrival", () => {
    expect(resolveComposerServerProviderSync({ ...base, draftExplicit: true })).toBe("none");
  });

  it("follows a switch the server makes while the chat is open, as before", () => {
    expect(
      resolveComposerServerProviderSync({
        ...base,
        draftExplicit: true,
        serverChangedInPlace: true,
      }),
    ).toBe("reseed");
  });

  it("adopts an explicit pick once the server runs it, so a later return moves the composer", () => {
    expect(
      resolveComposerServerProviderSync({
        ...base,
        server: seededCopilot,
        draftExplicit: true,
      }),
    ).toBe("adopt");
    // After adoption the flag is gone; the later return to Claude reseeds.
    expect(resolveComposerServerProviderSync(base)).toBe("reseed");
  });

  it("does nothing without a server selection or a draft provider", () => {
    expect(resolveComposerServerProviderSync({ ...base, server: null })).toBe("none");
    expect(
      resolveComposerServerProviderSync({ ...base, draftProvider: null, draftSelection: null }),
    ).toBe("none");
  });
});
