import { quotaAlerts, visibleQuotaAlerts } from "@specweave-studio/shared/quotaAlerts";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { QuotaAlertBanner } from "./QuotaAlertBanner";
import { claimQuotaAlertNotification } from "./quotaAlertNotifications";

const HOUR = 3_600_000;
const now = Date.parse("2026-11-14T20:00:00.000Z");

const account = (key: string, resetsIn: number, leftPercent: number) => ({
  accountKey: key,
  driver: "codex",
  machines: ["m4"],
  offline: false,
  windows: [
    { id: "secondary", title: "Weekly", leftPercent, resetsAt: now + resetsIn, expiring: true },
  ],
  renewal: null,
  credits: null,
});

const render = (alerts: ReturnType<typeof quotaAlerts>) =>
  renderToStaticMarkup(
    <QuotaAlertBanner
      alerts={alerts}
      labelOf={() => "Codex Pro"}
      now={now}
      onOpen={() => undefined}
      onDismiss={() => undefined}
    />,
  );

describe("QuotaAlertBanner", () => {
  it("names the account, machine, what is left and the time to reset", () => {
    const html = render(quotaAlerts([account("codex:a@x.dev", 9 * HOUR, 62)], [], now));
    expect(html).toContain("Codex Pro on m4: 62% of its weekly quota resets in 9 h");
    expect(html).toContain("See subscriptions");
    expect(html).toContain('aria-label="Dismiss until the next reset"');
  });

  it("shows the two soonest and counts the rest", () => {
    const alerts = quotaAlerts(
      [
        account("codex:a@x.dev", 9 * HOUR, 62),
        account("codex:b@x.dev", 3 * HOUR, 80),
        account("codex:c@x.dev", 20 * HOUR, 45),
      ],
      [],
      now,
    );
    const html = render(alerts);
    expect(html.indexOf("80%")).toBeLessThan(html.indexOf("62%"));
    expect(html).not.toContain("45%");
    expect(html).toContain("and 1 more subscription");
  });

  it("renders nothing with no alert, or once every alert is dismissed for its period", () => {
    expect(render([])).toBe("");
    const alerts = quotaAlerts([account("codex:a@x.dev", 9 * HOUR, 62)], [], now);
    const dismissed = { [alerts[0]!.key]: alerts[0]!.periodEnd };
    expect(render(visibleQuotaAlerts(alerts, dismissed))).toBe("");
  });
});

describe("claimQuotaAlertNotification", () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    });
  });

  it("lets one period notify once and the next period again", () => {
    expect(claimQuotaAlertNotification("codex:a@x.dev|window:secondary@1")).toBe(true);
    expect(claimQuotaAlertNotification("codex:a@x.dev|window:secondary@1")).toBe(false);
    expect(claimQuotaAlertNotification("codex:a@x.dev|window:secondary@2")).toBe(true);
  });
});
