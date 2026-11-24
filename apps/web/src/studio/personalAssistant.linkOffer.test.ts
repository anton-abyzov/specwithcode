import { PERSONAL_LINK_PROTOCOL_VERSION } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import { seatInputOf } from "../components/studio/PersonalAssistantLinkFlow";
import { personalAssistantLinkOffer } from "./personalAssistant";

// Fictional machines and ids; none names a real person or folder.
type Assistant = Parameters<typeof personalAssistantLinkOffer>[0][number];

const member = (environmentId: string, projectId: string) => ({
  environmentId,
  projectId,
  coordinatorThreadId: `coord-${projectId}`,
});

const seat = (
  environmentId: string,
  options: {
    readonly kind?: string;
    readonly archived?: boolean;
    readonly linkedAs?: { readonly id: string; readonly members: ReadonlyArray<unknown> };
  } = {},
): Assistant => ({
  environmentId,
  workspaceSettings: {
    kind: options.kind ?? "personal",
    archived: options.archived ?? false,
    ...(options.linkedAs === undefined ? {} : { logicalProject: options.linkedAs }),
  },
});

const linkedM4M5 = {
  id: "percy-link",
  members: [member("m4", "percy-m4"), member("m5", "percy-m5")],
};

describe("personalAssistantLinkOffer", () => {
  it("is false with no assistants", () => {
    expect(personalAssistantLinkOffer([])).toBe(false);
  });

  it("is false when every seat is on one machine", () => {
    expect(personalAssistantLinkOffer([seat("m4")])).toBe(false);
    expect(personalAssistantLinkOffer([seat("m4"), seat("m4")])).toBe(false);
  });

  it("is true with unlinked seats on two machines", () => {
    expect(personalAssistantLinkOffer([seat("m4"), seat("m5")])).toBe(true);
  });

  it("is false when every seat is one linked assistant with more than one member", () => {
    expect(
      personalAssistantLinkOffer([
        seat("m4", { linkedAs: linkedM4M5 }),
        seat("m5", { linkedAs: linkedM4M5 }),
      ]),
    ).toBe(false);
  });

  it("is true when two are linked and a third machine has its own", () => {
    expect(
      personalAssistantLinkOffer([
        seat("m4", { linkedAs: linkedM4M5 }),
        seat("m5", { linkedAs: linkedM4M5 }),
        seat("win"),
      ]),
    ).toBe(true);
  });

  it("treats a one-member logical project as unlinked", () => {
    const solo = (environmentId: string) => ({
      id: `solo-${environmentId}`,
      members: [member(environmentId, `percy-${environmentId}`)],
    });
    expect(
      personalAssistantLinkOffer([
        seat("m4", { linkedAs: solo("m4") }),
        seat("m5", { linkedAs: solo("m5") }),
      ]),
    ).toBe(true);
    // Two seats naming the same one-member link are still not linked to each other.
    const lone = { id: "lone", members: [member("m4", "percy-m4")] };
    expect(
      personalAssistantLinkOffer([seat("m4", { linkedAs: lone }), seat("m5", { linkedAs: lone })]),
    ).toBe(true);
  });

  it("is true when machines are in two different links", () => {
    const linkedWinM1 = {
      id: "other-link",
      members: [member("win", "percy-win"), member("m1", "percy-m1")],
    };
    expect(
      personalAssistantLinkOffer([
        seat("m4", { linkedAs: linkedM4M5 }),
        seat("m5", { linkedAs: linkedM4M5 }),
        seat("win", { linkedAs: linkedWinM1 }),
        seat("m1", { linkedAs: linkedWinM1 }),
      ]),
    ).toBe(true);
  });

  it("ignores archived assistants", () => {
    expect(personalAssistantLinkOffer([seat("m4"), seat("m5", { archived: true })])).toBe(false);
    expect(
      personalAssistantLinkOffer([
        seat("m4", { linkedAs: linkedM4M5 }),
        seat("m5", { linkedAs: linkedM4M5 }),
        seat("win", { archived: true }),
      ]),
    ).toBe(false);
  });

  it("ignores projects that are not personal assistants", () => {
    expect(personalAssistantLinkOffer([seat("m4"), seat("m5", { kind: "code" })])).toBe(false);
    expect(
      personalAssistantLinkOffer([
        seat("m4"),
        { environmentId: "m5", workspaceSettings: null },
        { environmentId: "win" },
      ]),
    ).toBe(false);
    expect(
      personalAssistantLinkOffer([
        seat("m4", { linkedAs: linkedM4M5 }),
        seat("m5", { linkedAs: linkedM4M5 }),
        seat("win", { kind: "code" }),
      ]),
    ).toBe(false);
  });
});

describe("seatInputOf", () => {
  type Seat = Parameters<typeof seatInputOf>[0];
  type Preview = NonNullable<Seat["preview"]>;

  const fullPreview = (): Preview =>
    ({
      protocolVersion: PERSONAL_LINK_PROTOCOL_VERSION,
      projectId: "percy-m5",
      assistantName: "Percy M5",
      icon: null,
      memoryFileCount: 1,
      machineLabel: "M5",
      memoryFileNames: ["notes.md"],
      logicalProjectId: null,
      members: [],
      routineOwner: false,
      self: member("m5", "percy-m5"),
      createdAt: "2026-03-01T00:00:00.000Z",
      memoryFiles: [
        {
          name: "notes.md",
          sha256: "abc",
          updatedAt: "2026-03-02T00:00:00.000Z",
          byteLength: 3,
        },
      ],
      settingsRevision: 4,
      memoryDigest: "digest-1",
    }) as unknown as Preview;

  const seatWith = (preview: Preview | null): Seat =>
    ({
      environmentId: "m5",
      projectId: "percy-m5",
      title: "Percy",
      createdAt: "2026-01-01T00:00:00.000Z",
      preview,
    }) as unknown as Seat;

  it("supports linking when the preview has self, memory digest and settings revision", () => {
    const input = seatInputOf(seatWith(fullPreview()));
    expect(input.supportsPersonalLink).toBe(true);
    expect(input.machineLabel).toBe("M5");
    expect(input.title).toBe("Percy M5");
    expect(input.createdAt).toBe("2026-03-01T00:00:00.000Z");
    expect(input.existingLogicalProjectId).toBeNull();
    expect(input.memoryFiles).toHaveLength(1);
  });

  it("does not support linking without a preview, and falls back to the seat", () => {
    const input = seatInputOf(seatWith(null));
    expect(input.supportsPersonalLink).toBe(false);
    expect(input.machineLabel).toBe("m5");
    expect(input.title).toBe("Percy");
    expect(input.createdAt).toBe("2026-01-01T00:00:00.000Z");
    expect(input.existingLogicalProjectId).toBeNull();
    expect(input.memoryFiles).toEqual([]);
  });

  it.each(["self", "memoryDigest", "settingsRevision"] as const)(
    "does not support linking when the preview lacks %s",
    (field) => {
      const preview = { ...fullPreview() } as Record<string, unknown>;
      delete preview[field];
      expect(seatInputOf(seatWith(preview as unknown as Preview)).supportsPersonalLink).toBe(false);
    },
  );

  it("does not support linking for an older protocol version", () => {
    const preview = {
      ...fullPreview(),
      protocolVersion: PERSONAL_LINK_PROTOCOL_VERSION - 1,
    } as unknown as Preview;
    expect(seatInputOf(seatWith(preview)).supportsPersonalLink).toBe(false);
  });

  it("names the existing link only when it has more than one member", () => {
    const linked = {
      ...fullPreview(),
      logicalProjectId: "percy-link",
      members: [member("m4", "percy-m4"), member("m5", "percy-m5")],
    } as unknown as Preview;
    expect(seatInputOf(seatWith(linked)).existingLogicalProjectId).toBe("percy-link");
    const alone = {
      ...fullPreview(),
      logicalProjectId: "percy-link",
      members: [member("m5", "percy-m5")],
    } as unknown as Preview;
    expect(seatInputOf(seatWith(alone)).existingLogicalProjectId).toBeNull();
  });
});
