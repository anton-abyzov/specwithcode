import { assert, describe, it } from "@effect/vitest";

import {
  DesktopBackendPortUnavailableError,
  DesktopDevelopmentBackendPortRequiredError,
  DesktopInstalledServiceNotStartedError,
  DesktopLocalServiceUnresponsiveError,
} from "./DesktopApp.ts";

describe("DesktopApp errors", () => {
  it("preserves unavailable backend port context", () => {
    const error = new DesktopBackendPortUnavailableError({
      startPort: 8_319,
      maxPort: 65_535,
      hosts: ["127.0.0.1", "0.0.0.0", "::"],
    });

    assert.equal(error.startPort, 8_319);
    assert.equal(error.maxPort, 65_535);
    assert.deepEqual(error.hosts, ["127.0.0.1", "0.0.0.0", "::"]);
    assert.equal(
      error.message,
      "No desktop backend port is available on hosts 127.0.0.1, 0.0.0.0, :: between 8319 and 65535.",
    );
  });

  it("names a nearly full disk as the likely reason the service does not answer", () => {
    const owner = { pid: 4_242, origin: "http://127.0.0.1:8319", stateDir: "/Users/a/userdata" };
    const lowDisk = (onMac: boolean) =>
      new DesktopLocalServiceUnresponsiveError({
        ...owner,
        lowDisk: { freeBytes: 412_000_000, onMac },
      }).message;

    assert.equal(
      lowDisk(true),
      "This Mac is almost out of disk space (412 MB free), which is the likely reason SpecWithCode does not respond. Another SpecWithCode process (pid 4242) owns /Users/a/userdata but does not answer at http://127.0.0.1:8319. Free some space, then open the app again. Starting a second server on the same data could damage it.",
    );
    assert.isTrue(lowDisk(false).startsWith("This computer is almost out of disk space"));
    assert.equal(
      new DesktopLocalServiceUnresponsiveError(owner).message,
      "Another SpecWithCode process (pid 4242) owns /Users/a/userdata but does not answer at http://127.0.0.1:8319. Wait for it to finish starting or stop it, then open the app again. Starting a second server on the same data could damage it.",
    );
  });

  it("says the projects live in a service that has not started", () => {
    assert.equal(
      new DesktopInstalledServiceNotStartedError({
        stateDir: "/Users/a/.specwithcode/m4/userdata",
        waitedMinutes: 20,
      }).message,
      "The SpecWithCode service that holds your projects (/Users/a/.specwithcode/m4/userdata) is installed but has not started after 20 minutes. The app did not open an empty store in its place. Check it with `specweave-studio triage` or restart the service, then open the app again.",
    );
  });

  it("reports the required development port", () => {
    const error = new DesktopDevelopmentBackendPortRequiredError();

    assert.equal(error.message, "STUDIO_PORT is required in desktop development.");
  });
});
