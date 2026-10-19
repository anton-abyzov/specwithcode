import { EnvironmentId, type StorageStatus } from "@specweave-studio/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { LowDiskSpaceNoticeCard } from "./LowDiskSpaceBanner";
import { resolveLowDiskSpaceNotices } from "./LowDiskSpaceBanner.logic";

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
