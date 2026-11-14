import { describe, expect, it } from "vite-plus/test";
import type { FolderCopyStatus } from "@specweave-studio/contracts";
import {
  addRateSample,
  countsText,
  phaseLabel,
  rateOf,
  sourceProgressView,
  statusProgressView,
  timeLeftText,
  type RateSample,
} from "./copyProgress";
import { overallFraction } from "./folderCopyActivity";

const status = (overrides: Partial<FolderCopyStatus>): FolderCopyStatus =>
  ({
    state: "transferring",
    progress: null,
    totals: null,
    committed: false,
    projectId: null,
    failedStep: null,
    ...overrides,
  }) as FolderCopyStatus;

describe("copy progress phases", () => {
  it("names each phase by the machine doing it", () => {
    expect(phaseLabel("measure", "m4", "m5")).toBe("Measure on m4");
    expect(phaseLabel("send", "m4", "m5")).toBe("Send to m5");
    expect(phaseLabel("apply", "m4", "m5")).toBe("Apply on m5");
  });

  it("measures on the source: counts so far, then reading files against a total", () => {
    const listing = sourceProgressView({ files: 94_543, bytes: 5_900_000_000 }, "m4");
    expect(listing).toMatchObject({ phase: "measure", step: "Measuring the folder on m4" });
    expect(listing.fraction).toBeNull();
    expect(countsText(listing)).toEqual({ bytes: "5.9 GB", files: "94,543 files" });

    const hashing = sourceProgressView(
      {
        step: "hashing",
        files: 1_386,
        bytes: 219_000_000,
        totalFiles: 121_868,
        totalBytes: 7_460_000_000,
      },
      "m4",
    );
    expect(hashing.step).toBe("Reading files on m4");
    expect(hashing.fraction).toBeCloseTo(219 / 7460, 5);
    expect(countsText(hashing)).toEqual({
      bytes: "219 MB of 7.5 GB",
      files: "1,386 of 121,868 files",
    });
  });

  it("sends, checks and applies on the destination with its counts", () => {
    const sending = statusProgressView(
      status({
        state: "transferring",
        progress: {
          phase: "files",
          filesDone: 1200,
          filesTotal: 4000,
          bytesDone: 2_000_000_000,
          bytesTotal: 8_000_000_000,
          bytesLocal: 500_000_000,
        },
      }),
      "m4",
      "m5",
    )!;
    expect(sending).toMatchObject({
      phase: "send",
      step: "Sending files to m5",
      fraction: 0.25,
      bytesLocal: 500_000_000,
    });
    expect(countsText(sending)).toEqual({
      bytes: "2.0 GB of 8.0 GB",
      files: "1,200 of 4,000 files",
    });
    expect(statusProgressView(status({ state: "verifying" }), "m4", "m5")?.step).toBe(
      "Checking files on m5",
    );
    expect(statusProgressView(status({ state: "applying" }), "m4", "m5")).toMatchObject({
      phase: "apply",
      fraction: null,
    });
    expect(statusProgressView(status({ state: "scanning" }), "m4", "m5")).toMatchObject({
      phase: "measure",
      step: "Comparing with m5",
    });
    // Waiting for review or undone: nothing is running.
    expect(statusProgressView(status({ state: "previewed" }), "m4", "m5")).toBeNull();
    expect(statusProgressView(status({ state: "undone" }), "m4", "m5")).toBeNull();
  });

  it("reads finished once registered, and failed in the phase it stopped", () => {
    const totals = {
      filesToMove: 121_868,
      bytesToMove: 7_460_000_000,
      bytesPresent: 0,
      decisionsNeeded: 0,
    };
    expect(
      statusProgressView(status({ state: "applied", totals }), "m4", "m5")?.outcome,
    ).toBe("running");
    const done = statusProgressView(
      status({ state: "applied", totals, committed: true, projectId: "p" as never }),
      "m4",
      "m5",
    )!;
    expect(done).toMatchObject({ outcome: "finished", fraction: 1, step: "Copied to m5" });
    expect(
      statusProgressView(status({ state: "failed", failedStep: "transferring" }), "m4", "m5"),
    ).toMatchObject({ outcome: "failed", phase: "send" });
    expect(
      statusProgressView(status({ state: "failed", failedStep: "applying" }), "m4", "m5"),
    ).toMatchObject({ outcome: "failed", phase: "apply" });
    expect(
      statusProgressView(status({ state: "failed", failedStep: "scanning" }), "m4", "m5"),
    ).toMatchObject({ outcome: "failed", phase: "measure" });
  });

  it("gives the sidebar the whole copy across three equal phases", () => {
    const base = { machine: "m5", label: "Copying files", fraction: 0.5, waiting: false };
    expect(overallFraction(base)).toBe(0.5);
    const sending = statusProgressView(
      status({
        state: "transferring",
        progress: {
          phase: "files",
          filesDone: 1,
          filesTotal: 2,
          bytesDone: 50,
          bytesTotal: 100,
          bytesLocal: 0,
        },
      }),
      "m4",
      "m5",
    )!;
    expect(overallFraction({ ...base, progress: sending, source: "m4" })).toBeCloseTo(0.5);
    const reading = sourceProgressView(
      { step: "hashing", files: 1, bytes: 25, totalFiles: 4, totalBytes: 100 },
      "m4",
    );
    expect(overallFraction({ ...base, progress: reading, source: "m4" })).toBeCloseTo(0.25 / 3);
  });
});

describe("copy speed and time left", () => {
  const samples = (...points: Array<[number, number]>) =>
    points.reduce<ReadonlyArray<RateSample>>(
      (all, [at, bytes]) => addRateSample(all, { at, bytes }),
      [],
    );

  it("waits for a few seconds of readings before giving a speed", () => {
    expect(rateOf(samples([0, 0], [1_000, 10_000_000]))).toBeNull();
    expect(rateOf(samples([0, 0], [2_000, 20_000_000], [4_000, 40_000_000]))).toBe(10_000_000);
  });

  it("forgets readings older than the window and restarts when counts go back", () => {
    const steady = samples(
      [0, 0],
      [5_000, 500_000_000],
      [10_000, 550_000_000],
      [15_000, 600_000_000],
    );
    // The burst in the first 5 s left the window: the pace is the last 10 s.
    expect(rateOf(steady)).toBe(10_000_000);
    expect(addRateSample(steady, { at: 16_000, bytes: 0 })).toEqual([{ at: 16_000, bytes: 0 }]);
  });

  it("shows no speed while nothing moves", () => {
    expect(rateOf(samples([0, 100], [2_000, 100], [4_000, 100]))).toBeNull();
  });

  it("rounds the time left so it does not flicker", () => {
    const view = sourceProgressView(
      { step: "hashing", files: 1, bytes: 1_000_000_000, totalFiles: 2, totalBytes: 2_300_000_000 },
      "m4",
    );
    // 1.3 GB left at 10 MB/s: 130 s, shown as 2 min 10 s.
    expect(timeLeftText(view, 10_000_000)).toBe("About 2 min 10 s left");
    expect(timeLeftText(view, null)).toBeNull();
    const counting = sourceProgressView({ files: 1, bytes: 5 }, "m4");
    expect(timeLeftText(counting, 10)).toBeNull();
  });
});
