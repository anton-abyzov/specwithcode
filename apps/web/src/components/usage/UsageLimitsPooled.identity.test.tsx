// @vitest-environment jsdom
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@specweave-studio/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("../../hooks/useSettings", () => ({
  usePrimarySettings: (select: (settings: { timestampFormat: string }) => unknown) =>
    select({ timestampFormat: "locale" }),
}));
vi.mock("../../state/session", () => ({
  useEnvironmentScope: () => true,
  readEnvironmentScope: () => true,
}));
vi.mock("../../state/server", () => ({ serverEnvironment: { consumeResetCredit: "consume" } }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../../state/presentation", () => ({
  environmentPresentations: { presentationsAtom: "presentations" },
}));
vi.mock("../../localApi", () => ({ ensureLocalApi: () => ({ shell: { openExternal: vi.fn() } }) }));

import { UsageLimitsPooled } from "./UsageLimitsPooled";

const now = Date.parse("2026-10-15T12:00:00.000Z");
const checkedAt = "2026-10-15T11:59:00.000Z";
const claude = ProviderDriverKind.make("claudeAgent");

function claudeOn(auth: ServerProvider["auth"], usedPercent: number): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("claudeAgent"),
    driver: claude,
    displayName: "Claude",
    enabled: true,
    installed: true,
    version: "2.1.0",
    status: "ready",
    auth,
    checkedAt,
    models: [],
    slashCommands: [],
    skills: [],
    usageLimits: {
      checkedAt,
      windows: [
        {
          id: "five_hour",
          kind: "session",
          label: "Session",
          usedPercent,
          windowDurationMins: 300,
          resetsAt: "2026-10-15T14:00:00.000Z",
        },
      ],
    },
  };
}

function machine(label: string, providers: ServerProvider[]) {
  return { entry: { target: { label } }, serverConfig: { providers } };
}

describe("pooled quota bars name the account and the machine", () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  async function render(presentations: Parameters<typeof UsageLimitsPooled>[0]["presentations"]) {
    await act(() => root.render(<UsageLimitsPooled presentations={presentations} now={now} />));
  }

  const segments = () =>
    [...container.querySelectorAll<HTMLButtonElement>("button[aria-label]")].map(
      (button) => button.getAttribute("aria-label") ?? "",
    );

  it("labels each bar with the reported email and machine instead of the instance name", async () => {
    await render(
      new Map([
        [
          EnvironmentId.make("m1"),
          machine("Anton's MacBook Pro M1Max (190)", [
            claudeOn(
              { status: "authenticated", email: "work@example.com", label: "Claude Max" },
              2,
            ),
          ]),
        ],
        [
          EnvironmentId.make("m4"),
          machine("Anton's MacBook M4MAX (149)", [
            claudeOn({ status: "authenticated", email: "home@example.com" }, 0),
          ]),
        ],
      ]),
    );
    const text = container.textContent ?? "";
    expect(text).toContain("work@example.com");
    expect(text).toContain("Anton's MacBook Pro M1Max (190)");
    expect(text).toContain("home@example.com");
    expect(text).toContain("Anton's MacBook M4MAX (149)");
    expect(segments()).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^work@example\.com on Anton's MacBook Pro M1Max \(190\): 98% left/),
        expect.stringMatching(/^home@example\.com on Anton's MacBook M4MAX \(149\): 100% left/),
      ]),
    );
  });

  it("falls back to the plan, then to the instance name, without inventing an email", async () => {
    await render(
      new Map([
        [
          EnvironmentId.make("plan"),
          machine("Plan host", [claudeOn({ status: "authenticated", label: "Claude Pro" }, 50)]),
        ],
        [
          EnvironmentId.make("old"),
          machine("Old host", [claudeOn({ status: "authenticated" }, 10)]),
        ],
      ]),
    );
    expect(segments()).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^Claude Pro on Plan host: 50% left/),
        expect.stringMatching(/^Claude on Old host: 90% left/),
      ]),
    );
    expect(container.textContent).not.toContain("@");
  });

  it("shows the full identity in the segment details", async () => {
    await render(
      new Map([
        [
          EnvironmentId.make("m4"),
          machine("Anton's MacBook M4MAX (149)", [
            claudeOn(
              { status: "authenticated", email: "home@example.com", label: "Claude Max" },
              30,
            ),
          ]),
        ],
      ]),
    );
    const segment = container.querySelector<HTMLButtonElement>("button[aria-label^='home@']")!;
    await act(async () => segment.click());
    const details = document.body.textContent ?? "";
    expect(details).toContain("Account");
    expect(details).toContain("Plan");
    expect(details).toContain("Claude Max");
    expect(details).toContain("Machine");
  });

  it("says a kept read is from an offline machine and when it was taken", async () => {
    const kept = claudeOn({ status: "authenticated", email: "away@example.com" }, 100);
    await render(
      new Map([
        [
          EnvironmentId.make("m3"),
          {
            ...machine("Anton's MacBook Pro", [
              {
                ...kept,
                usageLimits: {
                  checkedAt: "2026-10-15T09:00:00.000Z",
                  windows: [
                    {
                      id: "seven_day",
                      kind: "weekly",
                      label: "Weekly",
                      usedPercent: 100,
                      windowDurationMins: 7 * 24 * 60,
                      resetsAt: "2026-10-15T10:00:00.000Z",
                    },
                  ],
                },
              },
            ]),
            connection: { phase: "reconnecting" },
          },
        ],
      ]),
    );
    expect(segments()).toEqual([
      expect.stringMatching(
        /^away@example\.com on Anton's MacBook Pro · offline: 100% left, reset$/,
      ),
    ]);
    const segment = container.querySelector<HTMLButtonElement>("button[aria-label^='away@']")!;
    await act(async () => segment.click());
    const details = document.body.textContent ?? "";
    expect(details).toContain("reset since the last read");
    expect(details).toContain("3h 0m ago · machine offline");
  });
});
