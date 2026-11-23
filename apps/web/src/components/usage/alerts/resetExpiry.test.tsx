// @vitest-environment jsdom
import { EnvironmentId, ProviderInstanceId } from "@specweave-studio/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
import {
  replacesBankedNotice,
  expiringFullResets,
  resetExpiryMessage,
  resetExpiryNotice,
} from "./resetExpiry";
import { ResetCredits } from "../UsageLimits";

vi.mock("../../../notificationConnection", () => ({
  notificationAvailability: () => "granted",
  notificationsConnected: () => true,
}));
vi.mock("../../../state/session", () => ({
  readEnvironmentScope: () => true,
  useEnvironmentScope: () => true,
}));
vi.mock("../../../state/server", () => ({ serverEnvironment: { consumeResetCredit: "consume" } }));
const consume = vi.hoisted(() =>
  vi.fn(async () => ({ _tag: "Success", value: { outcome: "reset" } })),
);
vi.mock("../../../state/use-atom-command", () => ({ useAtomCommand: () => consume }));

const now = new Date(2026, 10, 28, 15, 15).getTime();
const hour = 3600000;
const credit = (id: string, offset: number) => ({
  id,
  expiresAt: new Date(now + offset).toISOString(),
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("includes exactly 48 hours and excludes expired and unavailable credits", () => {
  const first = credit("first", 1);
  const last = credit("last", 48 * hour);
  const credits = {
    availableCount: 5,
    fullResetExpiries: [last, credit("later", 48 * hour + 1), first, credit("ended", 0), first],
  };
  expect(expiringFullResets(credits, now)).toEqual([first, last]);
  expect(expiringFullResets({ ...credits, availableCount: 0 }, now)).toEqual([]);
  expect(resetExpiryMessage(2, first.expiresAt)).toContain(
    "2 full resets expire within 48 hours. The first expires Nov 28",
  );
});

it("notifies once per credit after reloading, including when its expiry changes", async () => {
  localStorage.clear();
  const shown = vi.fn();
  vi.stubGlobal(
    "Notification",
    class {
      constructor() {
        shown();
      }
      addEventListener() {}
    },
  );
  vi.spyOn(document, "hasFocus").mockReturnValue(false);
  const notify = async (id: string, offset: number) => {
    const { notifyQuotaAlert } = await import("./quotaAlertNotifications");
    notifyQuotaAlert({ ...resetExpiryNotice(credit(id, offset)), onOpen: vi.fn() });
  };
  await notify("first", hour);
  vi.resetModules();
  await notify("first", 24 * hour);
  await notify("second", hour);
  expect(shown).toHaveBeenCalledTimes(2);
});

it("shows the deadline and spends only after confirming Use reset", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  const environmentId = EnvironmentId.make("studio-host");
  const input = { instanceId: ProviderInstanceId.make("codex") };
  try {
    await act(async () =>
      root.render(
        <ResetCredits
          environmentId={environmentId}
          input={input}
          now={now}
          credits={{ availableCount: 1 }}
          message={resetExpiryMessage(1, credit("first", 48 * hour).expiresAt)}
        />,
      ),
    );
    expect(host.textContent).toContain(
      "1 full reset expires Nov 30 at 3:15 PM. Use it or lose it.",
    );
    await act(async () => host.querySelector("button")!.click());
    expect(consume).not.toHaveBeenCalled();
    const confirm = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "Use credit",
    );
    expect(confirm).toBeDefined();
    await act(async () => confirm!.click());
    expect(consume).toHaveBeenCalledWith({ environmentId, input });
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

it("replaces only the aggregate notification for the same credit expiry", () => {
  const warning = { key: "account", expiring: [credit("first", hour)] };
  const alert = { kind: "bankedReset", accountKey: "account", periodEnd: now + hour };
  expect(replacesBankedNotice(alert, [warning])).toBe(true);
  expect(replacesBankedNotice(alert, [])).toBe(false);
  expect(replacesBankedNotice({ ...alert, kind: "window" }, [warning])).toBe(false);
  expect(replacesBankedNotice({ ...alert, accountKey: "another" }, [warning])).toBe(false);
});
