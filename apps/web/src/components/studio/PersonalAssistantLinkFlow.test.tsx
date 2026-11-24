import { PERSONAL_LINK_PROTOCOL_VERSION, type EnvironmentId } from "@specweave-studio/contracts";
import { planPersonalAssistantMigration } from "@specweave-studio/shared/personalAssistantMigration";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  existingLinkRunnerOf,
  existingLinkTitleOf,
  personalLinkBlockedMessage,
  type PersonalLinkJoinStep,
  personalLinkJoinSteps,
  personalLinkSetupOnly,
  type PreviewedSeat,
  runPersonalLinkJoinSteps,
  seatInputOf,
} from "./PersonalAssistantLinkFlow";
import {
  distinctMachineLabels,
  PersonalAssistantMergeDialog,
} from "./PersonalAssistantMergeDialog";

// Fictional machines and ids; none names a real person or folder.
const member = (environmentId: string) => ({
  environmentId,
  projectId: `percy-${environmentId}`,
  coordinatorThreadId: `coord-${environmentId}`,
});

type Preview = NonNullable<PreviewedSeat["preview"]>;

const previewed = (
  environmentId: string,
  options: {
    readonly link?: { readonly id: string; readonly members: string[] };
    readonly routineOwner?: boolean;
    readonly name?: string;
    readonly identityId?: string | null;
  } = {},
): PreviewedSeat =>
  ({
    environmentId,
    projectId: `percy-${environmentId}`,
    title: "Percy",
    createdAt: "2026-01-01T00:00:00.000Z",
    preview: {
      protocolVersion: PERSONAL_LINK_PROTOCOL_VERSION,
      projectId: `percy-${environmentId}`,
      assistantName: options.name ?? "Percy",
      icon: null,
      memoryFileCount: 0,
      machineLabel: environmentId.toUpperCase(),
      memoryFileNames: [],
      logicalProjectId: options.link?.id ?? options.identityId ?? null,
      members: (options.link?.members ?? []).map(member),
      routineOwner: options.routineOwner ?? true,
      self: member(environmentId),
      createdAt: "2026-01-01T00:00:00.000Z",
      memoryFiles: [],
      settingsRevision: 3,
      memoryDigest: `digest-${environmentId}`,
    } as unknown as Preview,
    previewError: null,
  }) as PreviewedSeat;

const stepsFor = (seats: PreviewedSeat[], owner: string, name = "Percy") => {
  const plan = planPersonalAssistantMigration(seats.map(seatInputOf));
  return {
    plan,
    ...personalLinkJoinSteps({
      seats,
      canonicalSeats: plan.canonicalSeats,
      existingLinkId: plan.existingLinkId,
      routineOwnerEnvironmentId: owner as EnvironmentId,
      canonicalName: name,
      clashes: plan.clashes,
      resolutions: {},
    }),
  };
};

describe("seatInputOf preview failures", () => {
  it("keeps the real reason and marks the seat unreachable, not out of date", () => {
    const seat = { ...previewed("b"), preview: null, previewError: "connection lost" };
    const plan = planPersonalAssistantMigration([seatInputOf(previewed("a")), seatInputOf(seat)]);
    expect(plan.unreachableSeats).toEqual([
      { environmentId: "b", machineLabel: "b", message: "connection lost" },
    ]);
    expect(plan.unsupportedPeers).toEqual([]);
  });
});

describe("personalLinkJoinSteps (1448 C2)", () => {
  it("links new seats with one stable id, the routine runner first", () => {
    const seats = [previewed("a"), previewed("b"), previewed("c")];
    const first = stepsFor(seats, "b");
    const reopened = stepsFor([...seats], "b");
    expect(first.logicalProjectId).toBe(reopened.logicalProjectId);
    expect(first.steps.map((s) => s.environmentId)).toEqual(["b", "a", "c"]);
    expect(first.steps.map((s) => s.input.routineOwner)).toEqual([true, false, false]);
    expect(new Set(first.steps.map((s) => s.input.logicalProjectId)).size).toBe(1);
    expect(new Set(first.steps.map((s) => s.input.operationId)).size).toBe(1);
    expect(first.steps[0]!.input.approval).toEqual({
      expectedSettingsRevision: 3,
      memoryDigest: "digest-b",
    });
  });

  it("adds a third machine to an existing link: same id and name, linked seats first", () => {
    const link = { id: "logical:x", members: ["a", "b"] };
    const seats = [
      previewed("c"),
      previewed("a", { link, routineOwner: true, name: "Percy Home" }),
      previewed("b", { link, routineOwner: false, name: "Percy Home" }),
    ];
    const { steps, logicalProjectId } = stepsFor(seats, "a", "Something else");
    expect(logicalProjectId).toBe("logical:x");
    expect(steps.map((s) => s.environmentId)).toEqual(["a", "b", "c"]);
    for (const step of steps) {
      expect(step.input.logicalProjectId).toBe("logical:x");
      expect(step.input.canonicalName).toBe("Percy Home");
      expect(step.input.members.map((m) => m.environmentId).sort()).toEqual(["a", "b", "c"]);
    }
  });

  it("finishes a half-done link with the id the first seat joined", () => {
    const seats = [
      previewed("a", { link: { id: "logical:x", members: ["a", "b"] } }),
      previewed("b"),
    ];
    const { steps } = stepsFor(seats, "a");
    expect(steps.map((s) => s.input.logicalProjectId)).toEqual(["logical:x", "logical:x"]);
  });

  it("moves an existing link's runner only after every seat joined: off, then on", () => {
    const link = { id: "logical:x", members: ["a", "b"] };
    const seats = [
      previewed("a", { link, routineOwner: true }),
      previewed("b", { link, routineOwner: false }),
      previewed("c"),
    ];
    const { steps } = stepsFor(seats, "c");
    expect(steps.map((s) => [s.environmentId, s.input.routineOwner])).toEqual([
      ["a", true],
      ["b", false],
      ["c", false],
      ["a", false],
      ["c", true],
    ]);
    expect(steps[3]!.input.approval).toBeUndefined();
    expect(steps[4]!.input.approval).toBeUndefined();
  });

  it("reads the existing link's name and runner", () => {
    const link = { id: "logical:x", members: ["a", "b"] };
    const seats = [
      previewed("a", { link, routineOwner: false, name: "P" }),
      previewed("b", { link, routineOwner: true, name: "P" }),
    ];
    expect(existingLinkTitleOf(seats, "logical:x")).toBe("P");
    expect(existingLinkRunnerOf(seats, "logical:x")).toBe("b");
    expect(existingLinkTitleOf(seats, null)).toBeNull();
  });
});

const dialogSeat = (environmentId: string, overrides: Record<string, unknown> = {}) => ({
  environmentId: environmentId as EnvironmentId,
  machineLabel: environmentId.toUpperCase(),
  title: "Percy",
  supportsPersonalLink: true,
  ...overrides,
});

const render = (props: Partial<Parameters<typeof PersonalAssistantMergeDialog>[0]>) =>
  renderToStaticMarkup(
    <PersonalAssistantMergeDialog
      seats={[dialogSeat("a"), dialogSeat("b")]}
      clashes={[]}
      onConfirm={() => undefined}
      onCancel={() => undefined}
      {...props}
    />,
  );

describe("PersonalAssistantMergeDialog", () => {
  it("shows an unreachable machine's reason and never asks to update it", () => {
    const html = render({
      seats: [
        dialogSeat("a"),
        dialogSeat("b", { supportsPersonalLink: false, previewError: "connection lost" }),
      ],
      onLeaveOut: () => undefined,
      onRetryUnreachable: () => undefined,
    });
    expect(html).toContain("Could not read B: connection lost");
    expect(html).toContain("Leave B out");
    expect(html).toContain("Try again");
    expect(html).not.toContain("Update these machines");
  });

  it("still asks to update a machine that answered with an old protocol", () => {
    const html = render({
      seats: [dialogSeat("a"), dialogSeat("b", { supportsPersonalLink: false })],
    });
    expect(html).toContain("Update these machines before linking");
  });

  it("does not nest a second dialog role inside the popup", () => {
    expect(render({})).not.toContain('role="dialog"');
  });

  it("keeps an existing link's name read-only", () => {
    const html = render({ lockedName: "Percy Home" });
    expect(html).toContain('value="Percy Home"');
    expect(html).toContain("readOnly");
  });

  it("shows a blocking reason for two different links", () => {
    expect(render({ blockedMessage: "two links" })).toContain("two links");
  });

  it("tells apart machines that share a label", () => {
    const labels = distinctMachineLabels([
      { environmentId: "env-11111111-a", machineLabel: "MacBook Pro" },
      { environmentId: "env-22222222-b", machineLabel: "MacBook Pro" },
      { environmentId: "env-3", machineLabel: "Desk" },
    ]);
    expect(labels.get("env-11111111-a")).not.toBe(labels.get("env-22222222-b"));
    expect(labels.get("env-3")).toBe("Desk");
  });
});

describe("runPersonalLinkJoinSteps", () => {
  const step = (machineLabel: string, runnerOnly = false) =>
    ({
      environmentId: machineLabel,
      machineLabel,
      input: {},
      runnerOnly,
    }) as unknown as PersonalLinkJoinStep;

  it("stops at the first failed join, so later seats are never called", async () => {
    const called: string[] = [];
    const run = await runPersonalLinkJoinSteps([step("A"), step("B"), step("C")], async (s) => {
      called.push(s.machineLabel);
      return { error: s.machineLabel === "B" ? "stale_plan" : null };
    });
    expect(called).toEqual(["A", "B"]);
    expect(run.linked).toEqual(["A"]);
    expect(run.failure).toBe("B: stale_plan");
  });

  it("points a failed runner move at Settings", async () => {
    const run = await runPersonalLinkJoinSteps([step("A"), step("A", true)], async (s) => ({
      error: s.runnerOnly ? "offline" : null,
    }));
    expect(run.failure).toContain("Settings > Routines");
  });
});

describe("personalLinkSetupOnly", () => {
  const seats = [{ environmentId: "a" }, { environmentId: "b" }];

  it("shows the merge review on a machine without an assistant while others are separate", () => {
    expect(
      personalLinkSetupOnly({
        ownEnvironmentId: "c",
        seats,
        canonicalSeatCount: 2,
        alreadyLinked: false,
      }),
    ).toBe(false);
  });

  it("offers only Set up here once the others are linked, or there is one", () => {
    expect(
      personalLinkSetupOnly({
        ownEnvironmentId: "c",
        seats,
        canonicalSeatCount: 2,
        alreadyLinked: true,
      }),
    ).toBe(true);
    expect(
      personalLinkSetupOnly({
        ownEnvironmentId: "c",
        seats: seats.slice(0, 1),
        canonicalSeatCount: 1,
        alreadyLinked: false,
      }),
    ).toBe(true);
    expect(
      personalLinkSetupOnly({
        ownEnvironmentId: "a",
        seats,
        canonicalSeatCount: 2,
        alreadyLinked: true,
      }),
    ).toBe(false);
  });
});

describe("personalLinkBlockedMessage", () => {
  it("names a link member that is not taking part", () => {
    const link = { id: "logical:x", members: ["a", "b"] };
    const seats = [previewed("a", { link }), previewed("c")];
    const plan = planPersonalAssistantMigration(seats.map(seatInputOf));
    expect(personalLinkBlockedMessage(plan, seats)).toContain("b is on the existing link");
  });

  it("is null when nothing blocks", () => {
    const seats = [previewed("a"), previewed("b")];
    expect(
      personalLinkBlockedMessage(planPersonalAssistantMigration(seats.map(seatInputOf)), seats),
    ).toBeNull();
  });
});
