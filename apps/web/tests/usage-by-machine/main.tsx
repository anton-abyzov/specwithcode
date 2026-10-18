// Synthetic data only: no server, account, provider or store.
import type { EnvironmentId, ServerProvider } from "@specweave-studio/contracts";
import { createRoot } from "react-dom/client";

import { HostLimitsCompactView } from "../../src/components/studio/shell/HostLimits";
import { ProviderInstanceIcon } from "../../src/components/chat/ProviderInstanceIcon";
import {
  Popover,
  PopoverPopup,
  PopoverTitle,
  PopoverTrigger,
} from "../../src/components/ui/popover";
import type { HostLimitBlock, HostProviderRow } from "../../src/studio/hostLimitsModel";
import { applyThemePalette } from "../../src/themePalette";
import "../../src/components/studio/shell/shell.css";
import "../../src/components/studio/shell/usage.css";
import "./fixture.css";

const dark = new URLSearchParams(location.search).get("theme") === "dark";
document.documentElement.classList.toggle("dark", dark);
applyThemePalette("studio-chat", dark ? "dark" : "light");

const now = Date.parse("2026-10-17T12:00:00Z");
const HOUR = 3_600_000;

function row(
  driver: string,
  label: string,
  used: number,
  extra: Partial<HostProviderRow> = {},
): HostProviderRow {
  return {
    key: `${driver}:${label}:${used}:${extra.sharedWith?.length ?? 0}`,
    driver: driver as ServerProvider["driver"],
    label,
    iconUrl: undefined,
    identity: "you@example.com",
    plan: "Max",
    sharedWith: [],
    windows: [
      {
        id: "session",
        label: "Session",
        kind: "session",
        usedPercent: used,
        resetsAt: now + 2 * HOUR + 15 * 60_000,
        stale: false,
      },
    ],
    peak: used,
    bankedResets: 0,
    notice: null,
    checkedAt: now,
    ...extra,
  } as HostProviderRow;
}

const blocks: HostLimitBlock[] = [
  {
    environmentId: "m4" as EnvironmentId,
    label: "Work Mac (M4 Max)",
    isProjectHost: true,
    status: "online",
    readAt: now,
    fromSavedReading: false,
    providers: [
      row("claudeAgent", "Claude", 13, { sharedWith: ["Home MacBook Pro"] }),
      row("codex", "Codex", 53, { sharedWith: ["Office MacBook Pro (M1 Max)"] }),
      row("grok", "Grok", 100),
    ],
  },
  {
    environmentId: "mbp" as EnvironmentId,
    label: "Home MacBook Pro",
    isProjectHost: false,
    status: "offline",
    readAt: now - 4 * HOUR,
    fromSavedReading: true,
    providers: [
      row("claudeAgent", "Claude", 0),
      row("codex", "Codex", 46, { sharedWith: ["Work Mac (M4 Max)"] }),
    ],
  },
  {
    environmentId: "m1" as EnvironmentId,
    label: "Office MacBook Pro (M1 Max)",
    isProjectHost: false,
    status: "offline",
    readAt: now - 4 * HOUR,
    fromSavedReading: true,
    providers: [
      row("claudeAgent", "Claude", 10, { sharedWith: ["Work Mac (M4 Max)"] }),
      row("codex", "Codex", 85),
    ],
  },
  {
    environmentId: "linux" as EnvironmentId,
    label: "Build server with a very long machine name in the lab",
    isProjectHost: false,
    status: "connecting",
    readAt: null,
    fromSavedReading: false,
    providers: [],
  },
];

// The Claude section the popover shows under the grid, in its own classes.
function ClaudeSection() {
  const windows = [
    ["Session", 91, "resets in 3h 37m"],
    ["Weekly", 87, "resets in 5d 9h"],
    ["Weekly · Fable", 98, "resets in 5d 9h"],
  ] as const;
  return (
    <section className="sws-usage-provider" aria-label="Claude usage">
      <header>
        <ProviderInstanceIcon
          driverKind={"claudeAgent" as ServerProvider["driver"]}
          displayName="Claude"
          showBadge={false}
          className="size-4"
          iconClassName="size-4 text-foreground/80"
        />
        <strong>Claude</strong>
        <span className="sws-usage-plan">Claude Max Subscription</span>
      </header>
      {windows.map(([label, left, reset]) => (
        <div key={label} className="sws-usage-window">
          <span className="sws-usage-window-label">{label}</span>
          <span className="sws-usage-bar" data-tone="ok" aria-hidden>
            <span style={{ width: `${left}%` }} />
          </span>
          <span className="sws-usage-window-value" data-tone="ok">
            {left}% left
          </span>
          <span className="sws-usage-window-reset">{reset}</span>
        </div>
      ))}
    </section>
  );
}

function App() {
  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "flex-end", padding: 16 }}>
      <Popover defaultOpen>
        <PopoverTrigger className="sws-usage-chip">87% left</PopoverTrigger>
        <PopoverPopup side="top" align="start" width="lg" padding="compact">
          <div className="sws-usage-popover" data-case="popover">
            <PopoverTitle>Coordinator usage on Work Mac (M4 Max)</PopoverTitle>
            <HostLimitsCompactView blocks={blocks} now={now} />
            <ClaudeSection />
          </div>
        </PopoverPopup>
      </Popover>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
