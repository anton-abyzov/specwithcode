import { describe, expect, it } from "vite-plus/test";

import { personalAssistantSidebarOffer } from "./personalAssistant";

// Fictional machines and ids; none names a real person or folder.
const seat = (
  environmentId: string,
  options: { readonly kind?: string; readonly archived?: boolean; readonly id?: string } = {},
) => ({
  id: options.id ?? `percy-${environmentId}`,
  environmentId,
  createdAt: "2026-01-01T00:00:00.000Z",
  workspaceSettings: { kind: options.kind ?? "personal", archived: options.archived ?? false },
});

const offer = (
  assistants: ReturnType<typeof seat>[],
  options: {
    readonly sharedHere?: boolean;
    readonly own?: string | null;
    readonly label?: string | null;
    readonly machineCount?: number;
  } = {},
) =>
  personalAssistantSidebarOffer({
    assistants,
    ownEnvironmentId: options.own === undefined ? "studio" : options.own,
    ownMachineLabel: options.label === undefined ? "Studio" : options.label,
    machineCount: options.machineCount ?? 2,
    sharedHere: options.sharedHere ?? false,
  });

describe("the sidebar's assistant offer (1448 AC-11)", () => {
  it("offers the switch while it is off here and an assistant exists on another machine", () => {
    expect(offer([seat("laptop")])).toEqual({
      kind: "share",
      machine: "Studio",
      label: "Use my Percy on Studio",
    });
  });

  it("offers the switch even when this machine has an assistant of its own", () => {
    expect(offer([seat("studio"), seat("laptop")])?.kind).toBe("share");
  });

  it("never offers a separate set-up beside another machine's assistant", () => {
    expect(offer([seat("laptop")])?.kind).not.toBe("create");
  });

  it("offers nothing once the switch is on and this machine has its seat", () => {
    expect(offer([seat("studio"), seat("laptop")], { sharedHere: true })).toBeNull();
  });

  it("offers Set up when no assistant exists anywhere, as before", () => {
    expect(offer([], { machineCount: 1 })).toEqual({ kind: "create", label: "Set up" });
    expect(offer([], { machineCount: 3 })).toEqual({ kind: "create", label: "Set up here" });
  });

  it("offers nothing when this machine's assistant is the only one", () => {
    expect(offer([seat("studio")])).toBeNull();
  });

  it("does not count an archived assistant or a code project as an assistant elsewhere", () => {
    expect(offer([seat("studio"), seat("laptop", { archived: true })])).toBeNull();
    expect(offer([seat("studio"), seat("laptop", { kind: "code" })])).toBeNull();
  });

  it("offers Set up, not the switch, to a window with no machine of its own", () => {
    expect(offer([], { own: null, label: null })).toEqual({ kind: "create", label: "Set up here" });
    expect(offer([seat("laptop")], { own: null, label: null })).toBeNull();
  });

  it("falls back to Set up when this machine cannot be named", () => {
    expect(offer([seat("laptop")], { label: null })).toEqual({
      kind: "create",
      label: "Set up here",
    });
  });
});
