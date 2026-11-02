import { describe, expect, it } from "vite-plus/test";

import {
  diagnoseInstallAttempt,
  installerErrorFromLog,
  investigateInstallAttempt,
  parseInstallAttempt,
  parseInstallFailure,
  versionReached,
} from "./installAttempt.ts";
import { updaterFailureReason } from "./desktopUpdateErrors.ts";

const attempt = { targetVersion: "1.0.149", fromVersion: "1.0.76", at: "2026-11-02T06:40:54.000Z" };
const JOURNAL = [
  "Install on explicit quitAndInstall",
  "dpkg-deb: error: '/home/a/.cache/studio-updater/pending/SpecWithCode-1.0.149-x86_64.AppImage' is not a Debian format archive",
  "Command pkexec exited with code 1",
  "dpkg installation failed, trying to fix broken dependencies with apt-get",
].join("\n");

describe("the install attempt review", () => {
  it("reports the installer's own error when the old version came back", () => {
    expect(
      diagnoseInstallAttempt({
        attempt,
        runningVersion: "1.0.76",
        installerError: installerErrorFromLog(JOURNAL),
      }),
    ).toEqual({
      targetVersion: "1.0.149",
      at: attempt.at,
      reason:
        "1.0.149 did not install, this app still runs 1.0.76. dpkg-deb: error: '/home/a/.cache/studio-updater/pending/SpecWithCode-1.0.149-x86_64.AppImage' is not a Debian format archive",
    });
  });

  it("says nothing when the attempted version runs", () => {
    expect(
      diagnoseInstallAttempt({ attempt, runningVersion: "1.0.149", installerError: null }),
    ).toBeNull();
  });

  it("says plainly when the machine left no error", () => {
    expect(
      diagnoseInstallAttempt({ attempt, runningVersion: "1.0.76", installerError: null })?.reason,
    ).toBe(
      "1.0.149 did not install, this app still runs 1.0.76. The installer ended without installing it and left no error on this machine.",
    );
  });

  it("ignores unrelated journal lines and reads only the attempt's window", async () => {
    const windows: Array<[number, number]> = [];
    const reason = await investigateInstallAttempt(attempt, "linux", async (since, until) => {
      windows.push([since, until]);
      return "polkitd started\nerror in another app\n";
    });
    expect(reason).toBeNull();
    expect(windows).toEqual([[1793601654, 1793601834]]);
  });

  it("does not look in a Linux journal elsewhere", async () => {
    expect(await investigateInstallAttempt(attempt, "darwin", async () => JOURNAL)).toBeNull();
  });

  it("rejects a damaged record", () => {
    expect(parseInstallAttempt("{")).toBeNull();
    expect(parseInstallAttempt('{"targetVersion":"1.0.149"}')).toBeNull();
    expect(parseInstallFailure('{"reason":""}')).toBeNull();
    expect(parseInstallAttempt(JSON.stringify(attempt))).toEqual(attempt);
  });

  it("drops an old failure once that version is reached", () => {
    expect(versionReached("1.0.149", "1.0.149")).toBe(true);
    expect(versionReached("1.0.150", "1.0.149")).toBe(true);
    expect(versionReached("1.0.76", "1.0.149")).toBe(false);
  });

  it("orders nightly builds and scrubs what the journal says", () => {
    expect(versionReached("1.1.0-nightly.20261101.4", "1.1.0-nightly.20261102.5")).toBe(false);
    expect(
      diagnoseInstallAttempt({ attempt, runningVersion: "1.0.150", installerError: null }),
    ).toBeNull();
    expect(
      installerErrorFromLog("E: Failed to fetch https://user:ghp_abcdef@apt.example.com/x"),
    ).toBe("E: Failed to fetch https://[credentials]@apt.example.com/x");
    expect(installerErrorFromLog("E: Failed to fetch https://apt.x/y?token=abc123&a=1")).toBe(
      "E: Failed to fetch https://apt.x/y?token=[removed]&a=1",
    );
  });

  it("names the updater's first line", () => {
    expect(updaterFailureReason(new Error("\nCommand pkexec exited with code 1\nstack"))).toBe(
      "Command pkexec exited with code 1",
    );
    expect(updaterFailureReason(new Error("Command pkexec exited with code 127"))).toMatch(
      /^Command pkexec exited with code 127\. If no password prompt appeared, quit SpecWithCode completely, reopen it/,
    );
    expect(updaterFailureReason(new Error("401 for Bearer ghp_abc123 at token gho_x"))).toBe(
      "401 for Bearer [token] at token [token]",
    );
    expect(updaterFailureReason({})).toBeNull();
  });
});
