// Synthetic data only: no server, account, provider or store.
import type { EnvironmentId, ServerProvider } from "@specweave-studio/contracts";
import { ArrowRightIcon } from "lucide-react";
import { createRoot } from "react-dom/client";

import {
  HostLimitsCompactView,
  MachineLimitBlocksView,
} from "../../src/components/studio/shell/HostLimits";
import {
  Popover,
  PopoverPopup,
  PopoverTitle,
  PopoverTrigger,
} from "../../src/components/ui/popover";
import type {
  HostLimitBlock,
  HostLimitWindow,
  HostProviderRow,
} from "../../src/studio/hostLimitsModel";
import { applyThemePalette } from "../../src/themePalette";
import "../../src/components/studio/shell/shell.css";
import "../../src/components/studio/shell/usage.css";
import "./fixture.css";

const params = new URLSearchParams(location.search);
const dark = params.get("theme") === "dark";
document.documentElement.classList.toggle("dark", dark);
applyThemePalette("studio-chat", dark ? "dark" : "light");

const now = Date.parse("2026-10-17T12:00:00Z");
const HOUR = 3_600_000;

function win(
  label: string,
  used: number,
  resetHours: number,
  extra: Partial<HostLimitWindow> = {},
): HostLimitWindow {
  const session = label.startsWith("Session");
  return {
    id: label.toLowerCase(),
    label,
    kind: session ? "session" : "weekly",
    usedPercent: used,
    resetsAt: now + resetHours * HOUR,
    stale: false,
    durationMins: session ? 300 : 10_080,
    ...extra,
  } as HostLimitWindow;
}

function row(
  driver: string,
  label: string,
  identity: string | null,
  windows: HostLimitWindow[],
  extra: Partial<HostProviderRow> = {},
): HostProviderRow {
  const wide = windows.filter((entry) => entry.modelScope === undefined);
  return {
    key: `${driver}:${identity ?? label}`,
    instanceId: driver,
    driver: driver as ServerProvider["driver"],
    label,
    iconUrl: undefined,
    identity,
    plan: driver === "claudeAgent" ? "Claude Max Subscription" : "Pro",
    sharedWith: [],
    windows,
    peak: Math.max(...(wide.length > 0 ? wide : windows).map((entry) => entry.usedPercent)),
    bankedResets: 0,
    notice: null,
    checkedAt: now,
    ...extra,
  } as HostProviderRow;
}

const blocks: HostLimitBlock[] = [
  {
    environmentId: "mbp" as EnvironmentId,
    label: "Work MacBook Pro",
    isProjectHost: true,
    isThisMachine: true,
    status: "online",
    readAt: now,
    fromSavedReading: false,
    providers: [
      row(
        "claudeAgent",
        "Claude",
        "you@work.example",
        [
          win("Session", 1, 0.85),
          win("Weekly", 2, 153),
          win("Weekly · Fable", 3, 153, { modelScope: "fable" }),
        ],
        { bankedResets: 1 },
      ),
      row("codex", "Codex", "me@home.example", [win("Weekly", 38, 161)], {
        sharedWith: ["Studio Mac (M4 Max)"],
      }),
    ],
  },
  {
    environmentId: "m4" as EnvironmentId,
    label: "Studio Mac (M4 Max)",
    isProjectHost: false,
    isThisMachine: false,
    status: "online",
    readAt: now,
    fromSavedReading: false,
    providers: [
      row(
        "claudeAgent",
        "Claude",
        "team@company.example",
        [win("Session", 30, 2.4), win("Weekly", 88, 112)],
        { sharedWith: ["Office MacBook Pro (M1 Max)"] },
      ),
      row("codex", "Codex", "me@home.example", [win("Weekly", 38, 161)], {
        sharedWith: ["Work MacBook Pro"],
      }),
      row("grok", "Grok", "me@home.example", [win("Weekly", 100, 1.95)]),
    ],
  },
  {
    environmentId: "m1" as EnvironmentId,
    label: "Office MacBook Pro (M1 Max)",
    isProjectHost: false,
    isThisMachine: false,
    status: "offline",
    readAt: now - 4 * HOUR,
    fromSavedReading: true,
    providers: [
      row(
        "claudeAgent",
        "Claude",
        "team@company.example",
        // Saved four hours ago: the 5-hour window has reset since.
        [win("Session", 64, 0, { resetsAt: null, stale: true }), win("Weekly", 85, 116)],
        { sharedWith: ["Studio Mac (M4 Max)"] },
      ),
      row("codex", "Codex", "work@company.example", [win("Weekly", 0, 167)]),
    ],
  },
  {
    environmentId: "m1max" as EnvironmentId,
    label: "Lab MacBook Pro (M1 Max)",
    isProjectHost: false,
    isThisMachine: false,
    status: "online",
    readAt: now,
    fromSavedReading: false,
    providers: [
      // The weekly is spent: the 5-hour window's 90% cannot be used until it resets.
      row("claudeAgent", "Claude", "admin@company.example", [
        win("Session", 10, 3.1, { blockedBy: { label: "Weekly", resetsAt: now + 77 * HOUR } }),
        win("Weekly", 100, 77),
      ]),
      row("codex", "Codex", "admin@company.example", [win("Session", 0, 5), win("Weekly", 0, 168)]),
      // A long agent name truncates and still leaves room for the account.
      row(
        "acpRegistry",
        "GitHub Copilot Enterprise Coding Agent (preview)",
        "admin@company.example",
        [win("Monthly", 40, 300, { kind: "monthly" })],
      ),
    ],
  },
  {
    environmentId: "linux" as EnvironmentId,
    label: "Build server with a very long machine name in the lab",
    isProjectHost: false,
    isThisMachine: false,
    status: "connecting",
    readAt: null,
    fromSavedReading: false,
    providers: [],
  },
];

function PopoverCase() {
  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "flex-end", padding: 16 }}>
      <Popover defaultOpen>
        <PopoverTrigger className="sws-usage-chip">98% left</PopoverTrigger>
        <PopoverPopup side="top" align="start" width="lg" padding="compact">
          <div className="sws-usage-popover" data-case="popover">
            <header className="sws-usage-popover-head">
              <PopoverTitle>Limits by machine</PopoverTitle>
              <p>
                Each machine uses its own sign-ins. Every limit window is listed; when a provider
                has several, the one that runs out first is brighter.
              </p>
            </header>
            <HostLimitsCompactView
              blocks={blocks}
              now={now}
              coordinator={{ environmentId: "mbp" as EnvironmentId, instanceId: "claudeAgent" }}
            />
            <footer>
              <span className="sws-usage-link">
                All limits and accounts <ArrowRightIcon aria-hidden />
              </span>
              <span className="sws-usage-link">
                This project's tokens <ArrowRightIcon aria-hidden />
              </span>
            </footer>
          </div>
        </PopoverPopup>
      </Popover>
    </div>
  );
}

// Usage → Limits, By machine: the blocks the page renders, without its chrome.
function LimitsCase() {
  return (
    <div data-case="limits" style={{ maxWidth: 960, margin: "0 auto", padding: 16 }}>
      <MachineLimitBlocksView blocks={blocks} now={now} />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  params.get("case") === "limits" ? <LimitsCase /> : <PopoverCase />,
);
