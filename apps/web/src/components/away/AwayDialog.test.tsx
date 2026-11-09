// @vitest-environment jsdom
import type { AwayAccessRequestRecord, AwayPlan, EnvironmentId } from "@specweave-studio/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { pendingAccessRequests, requestChangeSummary } from "./awayAccessRequests.logic";
import { AwayDialogView, type AwayDialogViewProps } from "./AwayDialog";
import {
  accessRequestText,
  awayPlanSummary,
  canRequestAccess,
  defaultAwayTarget,
  groupAwayPlan,
} from "./awayDialog.logic";

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

const M4 = "env-m4" as EnvironmentId;
const MINI = "env-ministorm" as EnvironmentId;
const MAC = "env-mac" as EnvironmentId;

const plan: AwayPlan = {
  targetEnvironmentId: MINI,
  targetLabel: "Ministorm",
  items: [
    {
      kind: "thread",
      id: "t1",
      title: "Fix the build",
      action: "move",
      reason: "Moves to Ministorm.",
    },
    {
      kind: "thread",
      id: "t2",
      title: "Write docs",
      action: "handoff-ready",
      reason: "Ministorm: no .env.local",
    },
    {
      kind: "routine",
      id: "r1",
      title: "Deploy hook",
      action: "pause",
      reason: "Its URL belongs to this machine, so it pauses here while you are away.",
    },
    { kind: "coordinator", id: "p1", title: "Insta", action: "move", reason: "Hands over." },
  ],
  missingGrants: [
    {
      kind: "routines",
      machineEnvironmentId: MINI,
      machineLabel: "Ministorm",
      detail: "Ministorm does not let M4's coordinator manage routines.",
      fix: "On Ministorm, turn on Routines for M4 in Settings > Machines > Who can run work here.",
    },
  ],
  ready: false,
  checkedAt: "2026-11-09T10:00:00.000Z",
};

const props = (patch: Partial<AwayDialogViewProps> = {}): AwayDialogViewProps => ({
  intent: "away",
  destinations: [{ environmentId: MINI, label: "Ministorm", state: "reachable" }],
  target: MINI,
  onTarget: vi.fn(),
  plan,
  checking: false,
  error: null,
  requesting: false,
  request: null,
  requestError: null,
  onRequestAccess: vi.fn(),
  onRecheck: vi.fn(),
  onClose: vi.fn(),
  ...patch,
});

const button = (text: string) =>
  [...document.querySelectorAll("button")].find((item) => item.textContent === text);

it("shows the plan grouped by kind with an action and reason per row", async () => {
  await act(async () => root.render(<AwayDialogView {...props()} />));
  const text = document.body.textContent ?? "";
  expect(text).toContain("Leave this machine");
  expect(text).toContain("Threads (2)");
  expect(text).toContain("Routines (1)");
  expect(text).toContain("Coordinators (1)");
  expect(document.querySelector('[data-away-action="handoff-ready"]')?.textContent).toContain(
    "Ministorm: no .env.local",
  );
  expect(document.querySelector('[data-away-action="pause"]')?.textContent).toContain("Pauses");
  expect(text).toContain("Needed first (1)");
  // Leaving is a later phase: the button is there but off.
  expect(button("Leave (coming next)")?.disabled).toBe(true);
});

it("sends every missing item with one Request access button, then waits", async () => {
  const onRequestAccess = vi.fn();
  await act(async () => root.render(<AwayDialogView {...props({ onRequestAccess })} />));
  await act(async () => button("Request access")?.click());
  expect(onRequestAccess).toHaveBeenCalledOnce();

  await act(async () =>
    root.render(
      <AwayDialogView
        {...props({ request: { requestId: "r", status: "sent", detail: "Sent." } })}
      />,
    ),
  );
  expect(button("Request sent")?.disabled).toBe(true);
  expect(document.body.textContent).toContain("Waiting for approval on Ministorm.");
});

it("says what Bring back does for now", async () => {
  await act(async () => root.render(<AwayDialogView {...props({ intent: "back" })} />));
  expect(document.body.textContent).toContain("Bring work back");
});

it("preselects the remembered machine when online, else the first online one", () => {
  const destinations = [
    { environmentId: MAC, label: "Mac", state: "offline" as const },
    { environmentId: MINI, label: "Ministorm", state: "reachable" as const },
    { environmentId: M4, label: "M4", state: "reachable" as const },
  ];
  expect(defaultAwayTarget(destinations, M4)).toBe(M4);
  expect(defaultAwayTarget(destinations, MAC)).toBe(MINI);
  expect(defaultAwayTarget(destinations, null)).toBe(MINI);
  expect(defaultAwayTarget([], null)).toBeNull();
});

it("groups, counts and words the plan", () => {
  expect(groupAwayPlan(plan).map((group) => group.title)).toEqual([
    "Threads",
    "Routines",
    "Coordinators",
  ]);
  expect(awayPlanSummary(plan)).toBe("2 move, 1 needs a check, 1 pauses");
  expect(awayPlanSummary({ items: [] })).toBe("Nothing here needs to move.");
  expect(canRequestAccess(plan)).toBe(true);
  expect(
    canRequestAccess({
      ...plan,
      missingGrants: [{ ...plan.missingGrants[0]!, machineEnvironmentId: M4 }],
    }),
  ).toBe(false);
  expect(accessRequestText({ requestId: "r", status: "approved", detail: "" }, "Ministorm")).toBe(
    "Ministorm approved. Checking again.",
  );
});

it("lists pending access requests and what approving changes", () => {
  const request: AwayAccessRequestRecord = {
    requestId: "r1",
    fromEnvironmentId: M4,
    fromLabel: "M4",
    missing: [
      plan.missingGrants[0]!,
      { ...plan.missingGrants[0]!, kind: "secret-file", detail: "no .env.local" },
    ],
    changes: { routines: true },
    status: "pending",
    createdAt: "2026-11-09T10:00:00.000Z",
    decidedAt: null,
    detail: null,
  };
  expect(
    pendingAccessRequests([request, { ...request, requestId: "r0", status: "approved" }]),
  ).toEqual([request]);
  expect(requestChangeSummary(request)).toBe(
    "Approve lets its coordinator manage routines. 1 step still needs doing by hand.",
  );
});
