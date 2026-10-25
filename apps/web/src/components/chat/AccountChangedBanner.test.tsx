import type { RunId, ServerProvider } from "@specweave-studio/contracts";
import { isValidElement, type ReactElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";

import {
  accountChangeAutoContinues,
  accountChangedBannerItem,
  accountChangedWithRoom,
} from "./AccountChangedBanner";

vi.mock("../ui/button", () => ({ Button: "button" }));

let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  if (renderer) await act(() => renderer!.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

const HOUR = 60 * 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

type Limits = NonNullable<ServerProvider["usageLimits"]>;
const claude = (limits: { [K in keyof Limits]?: Limits[K] | undefined }): ServerProvider =>
  ({
    instanceId: "claudeAgent",
    driver: "claudeAgent",
    enabled: true,
    installed: true,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: iso(HOUR),
    version: null,
    models: [],
    slashCommands: [],
    skills: [],
    usageLimits: {
      checkedAt: iso(HOUR),
      windows: [{ id: "five_hour", kind: "session", label: "Session", usedPercent: 14 }],
      nativeAllowanceObservedAt: iso(HOUR),
      accountChangedAt: iso(HOUR),
      ...limits,
    },
  }) as unknown as ServerProvider;

it("shows the change only for a stop before it, with a complete read of the new account that has room", () => {
  expect(accountChangedWithRoom(claude({}), 0, HOUR)).toBe(true);
  expect(accountChangedWithRoom(claude({}), HOUR, HOUR)).toBe(false);
  expect(accountChangedWithRoom(claude({ accountChangedAt: undefined }), 0, HOUR)).toBe(false);
  expect(accountChangedWithRoom(claude({ nativeAllowanceObservedAt: undefined }), 0, HOUR)).toBe(
    false,
  );
  expect(
    accountChangedWithRoom(claude({ nativeAllowanceObservedAt: iso(HOUR - 1) }), 0, HOUR),
  ).toBe(false);
  expect(accountChangedWithRoom(claude({ unavailable: { reason: "probeFailed" } }), 0, HOUR)).toBe(
    false,
  );
  expect(
    accountChangedWithRoom(
      claude({
        windows: [{ id: "five_hour", kind: "session", label: "Session", usedPercent: 100 }],
      }),
      0,
      HOUR,
    ),
  ).toBe(false);
  expect(accountChangedWithRoom(undefined, 0, HOUR)).toBe(false);
});

it("says the subscription changed in the same CLI, continues or asks to confirm, and claims nothing more", () => {
  const base = {
    runId: "run-1" as RunId,
    providerName: "Claude",
    onContinue: async () => {},
    onDismiss: () => {},
  };
  const auto = accountChangedBannerItem({ ...base, autoContinuing: true });
  expect(auto.title).toBe("Claude subscription changed");
  expect(auto.description).toBe(
    "We detected a sign-in to another subscription in the same Claude CLI. The limit was on the previous one, and the new one has room. This thread continues on the new subscription shortly.",
  );
  expect(auto.actions).toBeNull();
  expect(auto.priority).toBe("urgent");
  expect(auto.dismissLabel).toBe("Dismiss subscription change notice");
  const manual = accountChangedBannerItem({ ...base, autoContinuing: false });
  expect(manual.description).toBe(
    "We detected a sign-in to another subscription in the same Claude CLI. The limit was on the previous one, and the new one has room.",
  );
  expect(isValidElement(manual.actions)).toBe(true);
  for (const text of [auto.title, auto.description, manual.description])
    expect(String(text)).not.toMatch(/cache|cost|billing|free|api key|model/i);
});

it("shows a failed confirmation inline, and clears it on the next try", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let fail = true;
  const item = accountChangedBannerItem({
    runId: "run-1" as RunId,
    providerName: "Claude",
    autoContinuing: false,
    onContinue: async () => {
      if (fail) throw new Error("Thread is busy on another device.");
    },
    onDismiss: () => {},
  });
  await act(async () => {
    renderer = create(item.actions as ReactElement);
  });
  const alerts = () => renderer!.root.findAll((node) => node.props.role === "alert");
  expect(alerts()).toHaveLength(0);
  const button = () => renderer!.root.findByType("button");
  expect(button().children).toEqual(["Confirm and continue"]);
  await act(async () => {
    await button().props.onClick();
  });
  expect(alerts()).toHaveLength(1);
  expect(alerts()[0]!.children).toEqual(["Thread is busy on another device."]);
  expect(button().props.disabled).toBe(false);
  fail = false;
  await act(async () => {
    await button().props.onClick();
  });
  expect(alerts()).toHaveLength(0);
});

it("promises a continue only when the server would send one", () => {
  const armed = {
    driver: "claudeAgent",
    autoApprove: true,
    runId: "run-1" as RunId,
    limitRecovery: { runId: "run-1" as RunId, autoResume: true },
    settledOverride: null,
    snoozedUntil: null,
    pendingRequest: false,
    project: { paused: false, archived: false },
    nowMs: HOUR,
  };
  expect(accountChangeAutoContinues(armed)).toBe(true);
  expect(accountChangeAutoContinues({ ...armed, driver: "codex" })).toBe(true);
  for (const blocked of [
    { driver: "opencode" },
    { driver: undefined },
    // The project asks first: the person confirms the change.
    { autoApprove: false },
    { limitRecovery: null },
    { limitRecovery: { runId: "run-0" as RunId, autoResume: true } },
    { limitRecovery: { runId: "run-1" as RunId, autoResume: false } },
    { settledOverride: "settled" },
    { snoozedUntil: iso(2 * HOUR) },
    // A question or approval waiting on the person: the server refuses the resume.
    { pendingRequest: true },
    { project: { paused: true, archived: false } },
    { project: { paused: false, archived: true } },
  ])
    expect(accountChangeAutoContinues({ ...armed, ...blocked })).toBe(false);
  // A snooze that already ran out holds nothing.
  expect(accountChangeAutoContinues({ ...armed, snoozedUntil: iso(HOUR - 1) })).toBe(true);
});
