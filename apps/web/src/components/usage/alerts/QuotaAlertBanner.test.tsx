import { quotaAlerts, visibleQuotaAlerts } from "@specweave-studio/shared/quotaAlerts";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { QuotaAlertBanner, planLabel } from "./QuotaAlertBanner";
import { quotaAlertNotified, recordQuotaAlertNotification } from "./quotaAlertNotifications";

const HOUR = 3_600_000;
const now = Date.parse("2026-11-14T20:00:00.000Z");

const account = (key: string, resetsIn: number, leftPercent: number) => ({
  accountKey: key,
  driver: "codex",
  machines: ["m4"],
  offline: false,
  windows: [
    { id: "secondary", title: "Weekly", leftPercent, resetsAt: now + resetsIn, long: true },
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
    expect(html).toContain('role="status"');
  });

  it("offers to use the quota only where a boost can run, and names a running one", () => {
    const alerts = quotaAlerts([account("codex:a@x.dev", 9 * HOUR, 62)], [], now);
    const banner = (props: object) =>
      renderToStaticMarkup(
        <QuotaAlertBanner
          alerts={alerts}
          labelOf={() => "Codex Pro"}
          now={now}
          onOpen={() => undefined}
          onDismiss={() => undefined}
          onBoost={() => undefined}
          onEndBoost={() => undefined}
          {...props}
        />,
      );
    expect(banner({ canBoost: () => true })).toContain(
      "Use it for new worker threads until it resets",
    );
    expect(banner({ canBoost: () => false })).not.toContain("Use it for new worker threads");
    const running = banner({
      canBoost: () => true,
      boosts: [{ accountKey: "codex:a@x.dev", label: "Codex Pro", until: now + 9 * HOUR }],
    });
    expect(running).toContain("New worker threads use Codex Pro until");
    expect(running).toContain("End now");
    // Already running for this account: no second start.
    expect(running).not.toContain("Use it for new worker threads until it resets");
  });

  it("keeps a running boost on show after its warning is dismissed", () => {
    const html = renderToStaticMarkup(
      <QuotaAlertBanner
        alerts={[]}
        labelOf={() => "Codex Pro"}
        now={now}
        onOpen={() => undefined}
        onDismiss={() => undefined}
        boosts={[{ accountKey: "codex:a@x.dev", label: "Codex Pro", until: now + 9 * HOUR }]}
        onEndBoost={() => undefined}
      />,
    );
    expect(html).toContain("New worker threads use Codex Pro until");
    expect(html).not.toContain("Dismiss until the next reset");
  });

  it("says a promised reset is expected and links its source", () => {
    const promise = {
      id: "p",
      driver: "codex",
      publishedAt: now - HOUR,
      sourceUrl: "https://x.com/example/status/9",
    };
    const html = render(quotaAlerts([account("codex:a@x.dev", 96 * HOUR, 62)], [], now, [promise]));
    expect(html).toContain("Codex Pro reset expected today: 62% left on m4 will be replaced");
    expect(html).toContain('href="https://x.com/example/status/9"');
    expect(html).not.toContain("announced");
  });

  it("names a plan once, without repeating the provider", () => {
    expect(planLabel("Claude", "Claude Ultra Subscription")).toBe("Claude Ultra");
    expect(planLabel("Codex", "Pro")).toBe("Codex Pro");
    expect(planLabel("Claude", undefined)).toBe("Claude");
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

describe("quota alert notification record", () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    });
  });

  it("lets one period notify once and the next period again", () => {
    const key = "codex:a@x.dev|window:secondary";
    expect(quotaAlertNotified(key, now)).toBe(false);
    expect(recordQuotaAlertNotification(key, now)).toBe(true);
    expect(quotaAlertNotified(key, now)).toBe(true);
    // The same reset re-read three seconds later is the same period.
    expect(quotaAlertNotified(key, now + 3000)).toBe(true);
    expect(quotaAlertNotified(key, now + 5 * HOUR)).toBe(false);
  });
});
