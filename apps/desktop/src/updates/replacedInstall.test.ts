import { describe, expect, it } from "@effect/vitest";

import { relaunchIntoReplacedInstall, runningInstallReplaced } from "./replacedInstall.ts";

const EXE = "/opt/SpecWithCode/specweave-studio-desktop";

const run = (executableLink: string | null, exists = true) => {
  let relaunches = 0;
  const relaunched = relaunchIntoReplacedInstall({
    executableLink,
    execPath: EXE,
    fileExists: () => exists,
    relaunch: () => {
      relaunches += 1;
    },
  });
  return { relaunched, relaunches };
};

describe("runningInstallReplaced", () => {
  it("needs a replaced binary and an install to relaunch into", () => {
    expect(runningInstallReplaced(`${EXE} (deleted)`, EXE, () => true)).toBe(true);
    expect(runningInstallReplaced(`${EXE} (deleted)`, EXE, () => false)).toBe(false);
    expect(runningInstallReplaced(EXE, EXE, () => true)).toBe(false);
    expect(runningInstallReplaced(null, EXE, () => true)).toBe(false);
  });
});

describe("relaunchIntoReplacedInstall", () => {
  it("relaunches when the running binary was replaced on disk", () => {
    expect(run(`${EXE} (deleted)`)).toEqual({ relaunched: true, relaunches: 1 });
  });

  it("leaves the install to the updater when nothing is there to relaunch into", () => {
    expect(run(`${EXE} (deleted)`, false)).toEqual({ relaunched: false, relaunches: 0 });
  });

  it.each([[EXE], [null]])(
    "leaves a binary still in place to the updater (%s)",
    (link: string | null) => {
      expect(run(link)).toEqual({ relaunched: false, relaunches: 0 });
    },
  );
});
