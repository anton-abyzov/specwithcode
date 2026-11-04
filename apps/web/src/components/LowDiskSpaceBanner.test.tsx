import {
  EnvironmentId,
  type StorageHomeUsage,
  type StorageStatus,
} from "@specweave-studio/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { LowDiskSpaceNoticeCard } from "./LowDiskSpaceBanner";
import {
  describeHomeUsageParts,
  forgetRecoveredDismissals,
  resolveLowDiskSpaceNotices,
} from "./LowDiskSpaceBanner.logic";

const THIS_MAC = EnvironmentId.make("env-m4");
const REMOTE = EnvironmentId.make("env-m1");

const storage = (level: StorageStatus["level"], freeBytes: number): StorageStatus => ({
  level,
  freeBytes,
  totalBytes: 994_000_000_000,
  checkedAt: "2026-10-18T12:00:00.000Z",
});

const resolve = (
  statuses: Parameters<typeof resolveLowDiskSpaceNotices>[0]["statuses"],
  dismissed: ReadonlyArray<string> = [],
  primaryIsThisMachine = true,
) =>
  resolveLowDiskSpaceNotices({
    statuses,
    primaryEnvironmentId: THIS_MAC,
    primaryIsThisMachine,
    labelFor: (environmentId) =>
      environmentId === REMOTE
        ? "Anton's MacBook M1"
        : environmentId === THIS_MAC
          ? "Anton's MacBook M4MAX"
          : undefined,
    dismissed: new Set(dismissed),
    appName: "SpecWithCode",
  });

describe("resolveLowDiskSpaceNotices", () => {
  it("shows one notice for this Mac and a named one for another machine", () => {
    const notices = resolve([
      { environmentId: REMOTE, os: "darwin", storage: storage("critical", 640_000_000) },
      { environmentId: THIS_MAC, os: "darwin", storage: storage("low", 3_249_000_000) },
    ]);
    expect(notices.map(({ message }) => message)).toEqual([
      "This Mac is almost out of disk space (3.2 GB free). SpecWithCode may stop responding until you free some space.",
      "Anton's MacBook M1 is almost out of disk space (640 MB free). SpecWithCode on it may stop responding until you free some space.",
    ]);
    expect(notices.map(({ level }) => level)).toEqual(["low", "critical"]);
  });

  it("names the serving machine in a browser, since it is not the one in front of the person", () => {
    const notices = resolve(
      [
        { environmentId: REMOTE, os: "darwin", storage: storage("critical", 640_000_000) },
        { environmentId: THIS_MAC, os: "darwin", storage: storage("low", 3_249_000_000) },
      ],
      [],
      false,
    );
    expect(notices.map(({ message }) => message)).toEqual([
      "Anton's MacBook M4MAX is almost out of disk space (3.2 GB free). SpecWithCode on it may stop responding until you free some space.",
      "Anton's MacBook M1 is almost out of disk space (640 MB free). SpecWithCode on it may stop responding until you free some space.",
    ]);
  });

  it("stays quiet for disks with room", () => {
    expect(
      resolve([{ environmentId: THIS_MAC, os: "darwin", storage: storage("ok", 5_500_000_000) }]),
    ).toEqual([]);
  });

  it("says computer for a primary machine that is not a Mac", () => {
    const [notice] = resolve([
      { environmentId: THIS_MAC, os: "linux", storage: storage("low", 2_000_000_000) },
    ]);
    expect(notice?.message.startsWith("This computer is almost out of disk space")).toBe(true);
  });

  it("keeps a dismissed notice closed until the disk gets worse", () => {
    const low = { environmentId: THIS_MAC, os: "darwin", storage: storage("low", 3e9) };
    expect(resolve([low], ["env-m4:low"])).toEqual([]);
    const critical = { ...low, storage: storage("critical", 4e8) };
    expect(resolve([critical], ["env-m4:low"]).map(({ key }) => key)).toEqual(["env-m4:critical"]);
  });
});

const homeUsage = (
  level: StorageHomeUsage["level"],
  overrides: Partial<StorageHomeUsage> = {},
): StorageHomeUsage => ({
  level,
  path: "/Users/anton/.specwithcode",
  totalBytes: 172e9,
  warnAboveBytes: 50e9,
  parts: [
    { key: "worktrees", bytes: 102e9 },
    { key: "database", bytes: 23e9 },
    { key: "backups", bytes: 21e9 },
    { key: "release", bytes: 14e9 },
  ],
  worktreeCount: 40,
  complete: true,
  checkedAt: "2026-11-03T12:00:00.000Z",
  ...overrides,
});

describe("app folder size", () => {
  it("raises no notice for a large or growing folder while the disk has room", () => {
    for (const level of ["large", "growing"] as const)
      expect(
        resolve([
          {
            environmentId: THIS_MAC,
            os: "darwin",
            storage: { ...storage("ok", 40e9), homeUsage: homeUsage(level) },
          },
          {
            environmentId: REMOTE,
            os: "darwin",
            storage: { ...storage("ok", 300e9), homeUsage: homeUsage(level) },
          },
        ]),
      ).toEqual([]);
  });

  it("puts the folder breakdown on the one low disk card for the primary machine", () => {
    const notices = resolve([
      {
        environmentId: THIS_MAC,
        os: "darwin",
        storage: { ...storage("low", 3e9), homeUsage: homeUsage("large") },
      },
    ]);
    expect(notices).toEqual([
      expect.objectContaining({
        key: "env-m4:low",
        level: "low",
        action: "review-storage",
        title: "Low disk space",
        message:
          "This Mac is almost out of disk space (3.0 GB free). SpecWithCode may stop responding until you free some space. The SpecWithCode folder takes 172 GB (worktrees 102 GB, database 23 GB, update backups 21 GB, remaining categories 26 GB), counting cloned files in full.",
      }),
    ]);
    const markup = renderToStaticMarkup(
      <LowDiskSpaceNoticeCard
        notice={notices[0]!}
        onDismiss={() => {}}
        onReviewStorage={() => {}}
      />,
    );
    expect(markup).toContain("Review storage");
    expect(markup).toContain('aria-label="Dismiss low disk space notice"');
  });

  it("stays quiet for a low disk on another machine and speaks up when it is critical", () => {
    const remote = (level: StorageStatus["level"], freeBytes: number) => ({
      environmentId: REMOTE,
      os: "darwin",
      storage: { ...storage(level, freeBytes), homeUsage: homeUsage("large") },
    });
    expect(resolve([remote("low", 3e9)])).toEqual([]);
    const notices = resolve([remote("critical", 6e8)]);
    expect(notices.map(({ key, action }) => [key, action])).toEqual([
      ["env-m1:critical", "review-storage"],
    ]);
    expect(notices[0]?.message).toBe(
      "Anton's MacBook M1 is almost out of disk space (600 MB free). SpecWithCode on it may stop responding until you free some space. The SpecWithCode folder takes 172 GB (worktrees 102 GB, database 23 GB, update backups 21 GB, remaining categories 26 GB), counting cloned files in full.",
    );
  });

  it("keeps a dismissed low card hidden and shows it again when the disk turns critical", () => {
    const status = (level: StorageStatus["level"], freeBytes: number) => ({
      environmentId: THIS_MAC,
      os: "darwin",
      storage: { ...storage(level, freeBytes), homeUsage: homeUsage("large") },
    });
    expect(resolve([status("low", 3e9)], ["env-m4:low"])).toEqual([]);
    expect(resolve([status("critical", 4e8)], ["env-m4:low"]).map(({ key }) => key)).toEqual([
      "env-m4:critical",
    ]);
  });
});

describe("dismissals", () => {
  it("are forgotten once that machine's disk has room again, and kept for others", () => {
    const dismissed = new Set(["env-m4:low", "env-m4:critical", "env-m1:critical"]);
    const next = forgetRecoveredDismissals(dismissed, [
      { environmentId: THIS_MAC, os: "darwin", storage: storage("ok", 40e9) },
      { environmentId: REMOTE, os: "darwin", storage: storage("critical", 4e8) },
    ]);
    expect([...next]).toEqual(["env-m1:critical"]);
    const same = forgetRecoveredDismissals(next, [
      { environmentId: REMOTE, os: "darwin", storage: storage("critical", 4e8) },
    ]);
    expect(same).toBe(next);
  });

  it("call a stopped-early folder check a lower bound", () => {
    const [notice] = resolve([
      {
        environmentId: THIS_MAC,
        os: "darwin",
        storage: {
          ...storage("low", 3e9),
          homeUsage: homeUsage("ok", { complete: false, totalBytes: 40e9, parts: [] }),
        },
      },
    ]);
    expect(
      notice?.message.endsWith(
        "The SpecWithCode folder takes at least 40 GB, counting cloned files in full.",
      ),
    ).toBe(true);
  });
});

describe("LowDiskSpaceNoticeCard", () => {
  it("renders the message once, calmly, with a dismiss control", () => {
    const [notice] = resolve([
      { environmentId: THIS_MAC, os: "darwin", storage: storage("low", 3_249_000_000) },
    ]);
    const markup = renderToStaticMarkup(
      <LowDiskSpaceNoticeCard notice={notice!} onDismiss={() => {}} />,
    );
    expect(markup).toContain('role="status"');
    expect(markup).toContain('data-variant="warning"');
    expect(markup).toContain("Low disk space");
    expect(markup).toContain("This Mac is almost out of disk space (3.2 GB free).");
    expect(markup).toContain('aria-label="Dismiss low disk space notice"');
  });
});

describe("storage category breakdown", () => {
  it("accounts for the omitted categories in the reported 159 GB", () => {
    expect(
      describeHomeUsageParts(
        homeUsage("large", {
          totalBytes: 159e9,
          parts: [
            { key: "backups", bytes: 67e9 },
            { key: "worktrees", bytes: 29e9 },
            { key: "database", bytes: 22e9 },
            { key: "other", bytes: 19e9 },
            { key: "release", bytes: 15e9 },
            { key: "scratch", bytes: 7e9 },
          ],
        }),
      ),
    ).toBe("update backups 67 GB, worktrees 29 GB, database 22 GB, remaining categories 41 GB");
  });

  it("does not invent a remainder when every category is shown", () => {
    expect(
      describeHomeUsageParts(
        homeUsage("large", {
          totalBytes: 52e9,
          parts: [
            { key: "other", bytes: 20e9 },
            { key: "scratch", bytes: 17e9 },
            { key: "release", bytes: 15e9 },
          ],
        }),
      ),
    ).toBe("other 20 GB, scratch folders 17 GB, release builds 15 GB");
  });

  it("calculates the remainder before rounding each displayed size", () => {
    expect(
      describeHomeUsageParts(
        homeUsage("large", {
          totalBytes: 159261579019,
          parts: [
            { key: "backups", bytes: 67120023378 },
            { key: "worktrees", bytes: 29226333773 },
            { key: "database", bytes: 22236545024 },
          ],
        }),
      ),
    ).toContain("remaining categories 41 GB");
  });
});
