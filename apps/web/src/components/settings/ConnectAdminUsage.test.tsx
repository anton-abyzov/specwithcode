import type { RelayAdminUsageResponse } from "@specweave-studio/contracts/relayAdmin";
import { act, type ReactNode } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { ConnectAdminRead } from "~/cloud/connectAdminState";
import type { PublicDownloads } from "~/cloud/publicDownloads";
import { englishPhrase } from "../../i18n";
import { ConnectAdminUsage } from "./ConnectAdminUsage";
import { formatCount, usageRows, weekBars, weekDate } from "./ConnectAdminUsage.logic";

const state = vi.hoisted(() => ({
  usageReads: 0,
  usage: undefined as unknown,
  downloadReads: 0,
  downloads: undefined as unknown,
}));

vi.mock("~/cloud/connectAdminState", () => ({
  readConnectAdmin: (
    read: (client: unknown, clerkToken: string) => unknown,
  ): Promise<ConnectAdminRead<unknown>> => {
    read({ usage: () => void (state.usageReads += 1) }, "clerk-token");
    return Promise.resolve(state.usage as ConnectAdminRead<unknown>);
  },
}));
vi.mock("~/cloud/publicDownloads", () => ({
  readPublicDownloads: () => {
    state.downloadReads += 1;
    return Promise.resolve(state.downloads);
  },
}));
vi.mock("./settingsLayout", () => ({
  SettingsSection: ({ title, children }: { title: string; children: ReactNode }) => (
    <section>
      <h3>{title}</h3>
      {children}
    </section>
  ),
}));

const weeks = (counts: ReadonlyArray<number>) =>
  counts.map((count, index) => ({
    weekStart: new Date(Date.UTC(2026, 7, 24 + index * 7)).toISOString(),
    count,
  }));

const usage: RelayAdminUsageResponse = {
  generatedAt: "2026-11-11T12:00:00.000Z",
  signUps: {
    total: 1083,
    created: { day: 2, week: 9, month: 31 },
    active: { day: 12, week: 40, month: 61 },
    weekly: weeks([0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]),
    complete: true,
  },
  connect: {
    created: { day: 1, week: 4, month: 14 },
    active: { day: 6, week: 15, month: 19 },
    machinesLinked: { day: 3, week: 8, month: 27 },
    weekly: weeks([0, 0, 0, 0, 0, 1, 2, 2, 3, 4, 2, 1]),
  },
};

const downloads: PublicDownloads = {
  installers: { mac: 2915, windows: 1330, linux: 1382, releases: 162, complete: true },
  npm: [
    { name: "specweave", week: 3900, month: 16078 },
    { name: "vskill", week: 510, month: 2156 },
  ],
};

let renderer: ReactTestRenderer | null = null;

async function mount(refreshKey = 0) {
  await act(async () => {
    renderer = create(<ConnectAdminUsage refreshKey={refreshKey} locale="en" />);
  });
}

const textOf = (node: ReactTestInstance | string): string =>
  typeof node === "string" ? node : node.children.map(textOf).join("");
const pageText = () => textOf(renderer!.root);
const rowText = (label: string) =>
  textOf(renderer!.root.find((node) => node.type === "tr" && textOf(node).startsWith(label))).slice(
    label.length,
  );

beforeEach(() => {
  state.usageReads = 0;
  state.downloadReads = 0;
  state.usage = { ok: true, value: usage };
  state.downloads = downloads;
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
});

describe("ConnectAdminUsage", () => {
  it("shows sign-ups, activity and what Connect saw for each period", async () => {
    await mount();
    const text = pageText();
    expect(text).toContain("Usage");
    expect(text).toContain("Signed up in total1,083");
    expect(rowText("New sign-ups")).toBe("2931");
    expect(rowText("People active")).toBe("124061");
    expect(rowText("New accounts on Connect")).toBe("1414");
    expect(rowText("Accounts seen by Connect")).toBe("61519");
    expect(rowText("Machines linked")).toBe("3827");
    expect(text).toContain("Sign-ups per week");
    expect(text).toContain("New accounts on Connect per week");
    expect(text).toContain("The app sends no usage data");
    expect(text).not.toContain("at least this many");
  });

  it("draws one bar per week with its count, the tallest week full height", async () => {
    await mount();
    const charts = renderer!.root.findAll(
      (node) => node.props["data-testid"] === "connect-admin-usage-weeks",
    );
    expect(charts).toHaveLength(2);
    const bars = charts[0]!.findAll((node) => node.type === "li");
    expect(bars).toHaveLength(12);
    // A screen reader hears the week and its count; the bar and the bare number are hidden.
    expect(textOf(bars.at(-1)!.find((node) => node.props.className === "sr-only"))).toBe(
      "Week of Nov 9: 10",
    );
    const heights = bars.map(
      (bar) => bar.find((node) => node.props["data-bar"] === "").props.style.height,
    );
    expect(heights[0]).toBe("0%");
    expect(heights.at(-1)).toBe("100%");
  });

  it("shows installer downloads per system and npm installs", async () => {
    await mount();
    const text = pageText();
    expect(text).toContain("Mac installer2,915");
    expect(text).toContain("Windows installer1,330");
    expect(text).toContain("Linux packages1,382");
    expect(text).toContain("added up over 162 releases on GitHub");
    expect(text).not.toContain("Older releases were not counted.");
    expect(rowText("specweave")).toBe("3,90016,078");
    expect(rowText("vskill")).toBe("5102,156");
  });

  it("keeps Connect's numbers when Clerk was not read, and says so", async () => {
    state.usage = { ok: true, value: { ...usage, signUps: null } };
    await mount();
    const text = pageText();
    expect(text).toContain("Sign-ups could not be read from Clerk.");
    expect(text).not.toContain("Signed up in total");
    expect(text).not.toContain("New sign-ups");
    expect(rowText("Machines linked")).toBe("3827");
    expect(
      renderer!.root.findAll((node) => node.props["data-testid"] === "connect-admin-usage-weeks"),
    ).toHaveLength(1);
  });

  it("says when the sign-up numbers are a lower bound", async () => {
    state.usage = {
      ok: true,
      value: { ...usage, signUps: { ...usage.signUps!, complete: false } },
    };
    await mount();
    expect(pageText()).toContain("The sign-up numbers are at least this many.");
  });

  it("says which download source could not be read and shows the other", async () => {
    state.downloads = { installers: null, npm: downloads.npm };
    await mount();
    expect(pageText()).toContain("Installer downloads could not be read from GitHub.");
    expect(rowText("specweave")).toBe("3,90016,078");

    act(() => renderer?.unmount());
    state.downloads = { installers: { ...downloads.installers!, complete: false }, npm: null };
    await mount();
    expect(pageText()).toContain("Installs from npm could not be read.");
    expect(pageText()).toContain("Older releases were not counted.");
  });

  it("never shows a failed read as zeros, and reads again on Try again", async () => {
    state.usage = { ok: false, failure: { kind: "unavailable", status: 503, traceId: "t-1" } };
    await mount();
    expect(pageText()).toContain("SpecWithCode Connect could not read its data");
    expect(pageText()).not.toContain("Machines linked");
    // The downloads do not depend on Connect.
    expect(pageText()).toContain("Mac installer2,915");
    expect(state.usageReads).toBe(1);

    state.usage = { ok: true, value: usage };
    await act(async () => {
      renderer!.root
        .find((node) => node.type === "button" && textOf(node) === "Try again")
        .props.onClick();
    });
    expect(state.usageReads).toBe(2);
    expect(rowText("Machines linked")).toBe("3827");
  });

  it("offers no retry to an account that is not an owner", async () => {
    state.usage = { ok: false, failure: { kind: "not_owner", status: 404, traceId: null } };
    await mount();
    expect(pageText()).toContain("This account is not a Connect owner");
    expect(renderer!.root.findAll((node) => node.type === "button")).toHaveLength(0);
  });

  it("reads again when the page refreshes, keeping the numbers on screen meanwhile", async () => {
    await mount();
    let release: () => void = () => {};
    state.usage = new Promise((resolve) => {
      release = () =>
        resolve({
          ok: true,
          value: { ...usage, connect: { ...usage.connect, machinesLinked: usage.connect.active } },
        });
    });
    await act(async () => {
      renderer!.update(<ConnectAdminUsage refreshKey={1} locale="en" />);
    });
    expect(state.usageReads).toBe(2);
    expect(state.downloadReads).toBe(2);
    expect(pageText()).not.toContain("Loading usage…");
    expect(rowText("Machines linked")).toBe("3827");
    await act(async () => release());
    expect(rowText("Machines linked")).toBe("61519");
  });
});

describe("usage logic", () => {
  it("lists Clerk's rows only when Clerk was read", () => {
    expect(usageRows(englishPhrase, usage).map((row) => row.id)).toEqual([
      "sign-ups",
      "active",
      "connect-new",
      "connect-seen",
      "machines",
    ]);
    expect(usageRows(englishPhrase, { ...usage, signUps: null }).map((row) => row.id)).toEqual([
      "connect-new",
      "connect-seen",
      "machines",
    ]);
  });

  it("scales bars to the tallest week and keeps a small week visible", () => {
    const bars = weekBars(weeks([0, 1, 100]), "en");
    expect(bars.map((bar) => bar.height)).toEqual([0, 6, 100]);
    expect(weekBars(weeks([0, 0]), "en").map((bar) => bar.height)).toEqual([0, 0]);
    expect(weekBars([], "en")).toEqual([]);
  });

  it("writes numbers and week dates in the reader's language", () => {
    expect(formatCount(16078, "en")).toBe("16,078");
    expect(formatCount(16078, "de")).toBe("16.078");
    // The week is cut in UTC, so the date is the same wherever it is read.
    expect(weekDate("2026-11-09T00:00:00.000Z", "en")).toBe("Nov 9");
    expect(weekDate("not a date", "en")).toBe("not a date");
  });
});
