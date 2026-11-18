import { describe, expect, it } from "vite-plus/test";

import { accountMenuPresentation } from "./accountMenuModel";

const MACHINE = "Anton's MacBook";

describe("accountMenuPresentation", () => {
  it("shows only the machine when the build has no Connect", () => {
    expect(accountMenuPresentation({ status: "unavailable" }, MACHINE)).toEqual({
      name: MACHINE,
      header: MACHINE,
      signIn: null,
    });
  });

  it("says it is checking while Clerk starts", () => {
    expect(accountMenuPresentation({ status: "loading" }, MACHINE)).toEqual({
      name: MACHINE,
      header: `${MACHINE} · Checking sign-in`,
      signIn: null,
    });
  });

  it("says so and offers a reload when Clerk did not start", () => {
    const view = accountMenuPresentation({ status: "notLoaded", linked: true }, MACHINE);
    expect(view.name).toBe("Sign-in did not load");
    expect(view.header).toBe(`${MACHINE} · Sign-in did not load`);
    expect(view.signIn?.label).toBe("Reload to sign in");
    expect(view.signIn?.hint).toContain("This machine is still linked");
    expect(
      accountMenuPresentation({ status: "notLoaded", linked: false }, MACHINE).signIn?.hint,
    ).not.toContain("still linked");
  });

  it("offers an optional sign-in on a machine with no account", () => {
    const view = accountMenuPresentation({ status: "signedOut", linked: false }, MACHINE);
    expect(view.name).toBe("Not signed in");
    expect(view.header).toBe(`${MACHINE} · Not signed in`);
    expect(view.signIn?.label).toBe("Sign in to SpecWithCode Connect");
    expect(view.signIn?.hint).toContain("Work from your main machine does not need it");
  });

  it("says a linked machine is already on Connect", () => {
    const view = accountMenuPresentation({ status: "signedOut", linked: true }, MACHINE);
    expect(view.name).toBe("Not signed in");
    expect(view.header).toBe(`${MACHINE} · Linked to Connect`);
    expect(view.signIn?.label).toBe("Sign in here");
    expect(view.signIn?.hint).toContain(
      "work from your main machine reaches it without signing in",
    );
  });

  it("names the Connect account when signed in", () => {
    const view = accountMenuPresentation(
      { status: "signedIn", name: "Ada Lovelace", email: "ada@example.com" },
      MACHINE,
    );
    expect(view).toEqual({
      name: "Ada Lovelace",
      header: `ada@example.com · ${MACHINE}`,
      signIn: null,
    });
  });

  it("falls back to the email, then to a plain label", () => {
    expect(
      accountMenuPresentation({ status: "signedIn", name: null, email: "ada@example.com" }, MACHINE)
        .name,
    ).toBe("ada@example.com");
    expect(
      accountMenuPresentation({ status: "signedIn", name: null, email: null }, MACHINE),
    ).toEqual({ name: "SpecWithCode account", header: MACHINE, signIn: null });
  });

  it("says Signed out, as a warning, while being signed out cuts this window off a machine", () => {
    const view = accountMenuPresentation(
      { status: "signedOut", linked: true, cutsOff: true },
      MACHINE,
    );
    expect(view.name).toBe("Signed out");
    expect(view.tone).toBe("warning");
    expect(view.header).toBe(`${MACHINE} · Signed out of SpecWithCode Connect`);
    expect(view.signIn?.label).toBe("Sign in");
  });

  it("keeps the quiet Not signed in when nothing depends on the sign-in", () => {
    const view = accountMenuPresentation({ status: "signedOut", linked: true }, MACHINE);
    expect(view.name).toBe("Not signed in");
    expect(view.tone).toBeUndefined();
  });

  it("warns before Clerk ends the sign-in and offers a new one (1417, AC-11)", () => {
    const view = accountMenuPresentation(
      { status: "signedIn", name: "Ada Lovelace", email: "ada@example.com", sessionEndsIn: "1h 40m" },
      MACHINE,
    );
    expect(view.name).toBe("Sign-in ends in 1h 40m");
    expect(view.header).toBe(`ada@example.com · ${MACHINE}`);
    expect(view.tone).toBe("warning");
    expect(view.signIn?.label).toBe("Sign in again now");
  });
});
