// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProviderDriverKind } from "@specweave-studio/contracts";

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => new Map() }));
vi.mock("../../../state/presentation", () => ({
  environmentPresentations: { presentationsAtom: {} },
}));
vi.mock("../../chat/ProviderInstanceIcon", () => ({ ProviderInstanceIcon: () => <i /> }));

import type { HostLimitBlock, HostProviderRow } from "../../../studio/hostLimitsModel";
import { HostLimitsCompactView } from "./HostLimits";

const now = Date.parse("2026-10-17T12:00:00Z");
const HOUR = 3_600_000;

function row(
  label: string,
  used: number,
  sharedWith: string[] = [],
  identity: string | null = null,
): HostProviderRow {
  return {
    key: label,
    instanceId: label.toLowerCase(),
    driver: ProviderDriverKind.make("codex"),
    label,
    iconUrl: undefined,
    identity,
    plan: "Max",
    sharedWith,
    windows: [
      {
        id: "session",
        label: "Session",
        kind: "session",
        usedPercent: used,
        resetsAt: now + 2 * HOUR,
        stale: false,
      },
    ],
    peak: used,
    bankedResets: 0,
    notice: null,
    checkedAt: now,
  };
}

function block(
  label: string,
  status: HostLimitBlock["status"],
  providers: HostProviderRow[],
): HostLimitBlock {
  return {
    environmentId: EnvironmentId.make(label),
    label,
    isProjectHost: false,
    isThisMachine: false,
    status,
    readAt: now - 4 * HOUR,
    fromSavedReading: status === "offline",
    providers,
  };
}

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("HostLimitsCompactView", () => {
  it("puts each host's status in its header and a provider with its account under it", () => {
    act(() =>
      root.render(
        <HostLimitsCompactView
          now={now}
          blocks={[
            block("m4", "online", [row("Claude", 13, ["m1"], "a@example.com"), row("Grok", 100)]),
            block("m1", "offline", [row("Codex", 85)]),
          ]}
        />,
      ),
    );
    const hosts = [...container.querySelectorAll(".sws-hl-compact-host")];
    expect(hosts.map((host) => host.querySelector(".sws-hl-compact-status")?.textContent)).toEqual([
      "Online",
      "Offline · 4h ago",
    ]);
    const rows = [...container.querySelectorAll(".sws-hl-compact-entry")].map((el) => ({
      value: el.querySelector(".sws-hl-compact-value")?.textContent,
      aside: el.querySelector(".sws-hl-compact-aside")?.textContent,
      account: el.querySelector(".sws-hl-compact-account")?.textContent,
    }));
    // Every provider shows its window with its reset; the account names who shares its quota.
    expect(rows).toEqual([
      { value: "87% left", aside: "in 2h 0m", account: "a@example.com · also on m1" },
      { value: "Limit reached", aside: "in 2h 0m", account: "Account not reported" },
      { value: "15% left", aside: "in 2h 0m", account: "Account not reported" },
    ]);
  });

  it("marks this machine and the project, and opens the coordinator's account in full", () => {
    const m4 = {
      ...block("m4", "online", [row("Claude", 13, [], "a@example.com"), row("Codex", 40)]),
      isProjectHost: true,
      isThisMachine: true,
    };
    act(() =>
      root.render(
        <HostLimitsCompactView
          now={now}
          blocks={[m4]}
          coordinator={{ environmentId: m4.environmentId, instanceId: "claude" }}
        />,
      ),
    );
    const badges = [...container.querySelectorAll(".sws-hl-compact-head .sws-hl-badge")];
    expect(badges.map((badge) => badge.textContent)).toEqual(["This machine", "This project"]);
    const [claude, codex] = [...container.querySelectorAll(".sws-hl-compact-entry")];
    expect(claude?.hasAttribute("data-coordinator")).toBe(true);
    expect(claude?.querySelector(".sws-hl-tag")?.textContent).toBe("Coordinator");
    expect(claude?.querySelector(".sws-hl-compact-account")?.textContent).toBe(
      "a@example.com · Max",
    );
    expect(
      [...(claude?.querySelectorAll(".sws-hl-compact-window") ?? [])].map((el) => el.textContent),
    ).toEqual(["Session87% leftin 2h 0m"]);
    expect(codex?.hasAttribute("data-coordinator")).toBe(false);
    expect(codex?.querySelectorAll(".sws-hl-compact-window")).toHaveLength(1);
  });

  it("lists a 5-hour and a weekly window side by side and marks the one that binds", () => {
    const claude: HostProviderRow = {
      ...row("Claude", 88),
      windows: [
        {
          id: "five_hour",
          label: "Session",
          kind: "session",
          usedPercent: 30,
          resetsAt: now + 2 * HOUR,
          stale: false,
          durationMins: 300,
        },
        {
          id: "seven_day",
          label: "Weekly",
          kind: "weekly",
          usedPercent: 88,
          resetsAt: now + 100 * HOUR,
          stale: false,
          durationMins: 10_080,
        },
      ],
    };
    const spent: HostProviderRow = {
      ...row("Codex", 100),
      windows: [
        {
          id: "primary",
          label: "Session",
          kind: "session",
          usedPercent: 10,
          resetsAt: now + HOUR,
          stale: false,
          durationMins: 300,
          blockedBy: { label: "Weekly", resetsAt: now + 50 * HOUR },
        },
        {
          id: "secondary",
          label: "Weekly",
          kind: "weekly",
          usedPercent: 100,
          resetsAt: now + 50 * HOUR,
          stale: false,
        },
      ],
    };
    act(() =>
      root.render(
        <HostLimitsCompactView now={now} blocks={[block("m4", "online", [claude, spent])]} />,
      ),
    );
    const windows = [...container.querySelectorAll(".sws-hl-compact-window")].map((el) => ({
      rank: el.getAttribute("data-rank"),
      text: el.textContent,
    }));
    expect(windows).toEqual([
      { rank: "other", text: "5-hour70% leftin 2h 0m" },
      { rank: "binding", text: "Weekly, runs out first12% leftin 4d 4h" },
      // A spent weekly: the 5-hour's 90% is not usable, and it says why.
      { rank: "other", text: "5-hourBlockedby Weekly, usable again in 2d 2h" },
      { rank: "binding", text: "Weekly, runs out firstLimit reachedin 2d 2h" },
    ]);
  });
});
