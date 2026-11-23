// @vitest-environment jsdom
import {
  EnvironmentId,
  ProviderInstanceId,
  ProviderDriverKind,
  type ServerProvider,
} from "@specweave-studio/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
import {
  replacesBankedNotice,
  expiringFullResets,
  resetExpiryMessage,
  resetExpiryNotice,
  resetExpiryAccounts,
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
    `2 full resets expire within 48 hours. The first expires ${new Date(first.expiresAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`,
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
          banner={{
            label: "studio-host",
            message: resetExpiryMessage(1, credit("first", 48 * hour).expiresAt),
          }}
        />,
      ),
    );
    expect(host.textContent).toContain(
      `1 full reset expires ${new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(now + 48 * hour)} at ${new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(now + 48 * hour)}. Use it or lose it.`,
    );
    await act(async () => host.querySelector("button")!.click());
    expect(consume).not.toHaveBeenCalled();
    const confirm = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "Use credit",
    );
    expect(confirm).toBeDefined();
    await act(async () => confirm!.click());
    expect(consume).toHaveBeenCalledWith({ environmentId, input });
    await act(async () =>
      root.render(
        <ResetCredits
          environmentId={environmentId}
          input={input}
          now={now}
          credits={{ availableCount: 0 }}
          banner={{ label: "studio-host", message: null }}
        />,
      ),
    );
    expect(host.textContent).toContain("Reset applied.");
    expect(host.querySelector("button")).toBeNull();
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

it("uses the newest native snapshot even without usage windows or matching timestamp precision", () => {
  const host = (checkedAt: string, availableCount: number) => {
    const provider: ServerProvider = {
      driver: ProviderDriverKind.make("codex"),
      instanceId: ProviderInstanceId.make("codex"),
      enabled: true,
      installed: true,
      version: "1",
      status: "ready",
      auth: { status: "authenticated", email: "user@example.com" },
      checkedAt,
      models: [],
      slashCommands: [],
      skills: [],
      usageLimits: {
        checkedAt,
        windows: [],
        resetCredits: { availableCount, fullResetExpiries: [credit("first", hour)] },
      },
    };
    return { entry: { target: { label: "studio-host" } }, serverConfig: { providers: [provider] } };
  };
  const presentations = new Map([
    [EnvironmentId.make("studio-host"), host("2026-11-28T12:00:00Z", 1)],
    [EnvironmentId.make("studio-host-two"), host("2026-11-28T12:00:00.500Z", 0)],
  ]);
  expect(resetExpiryAccounts(presentations, now).map((item) => item.message)).toEqual([null]);
});
