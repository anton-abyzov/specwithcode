import { describe, expect, it } from "vite-plus/test";

import { studioConnectSidebarSignInCopy } from "./StudioConnectSidebarSignIn";

describe("studioConnectSidebarSignInCopy", () => {
  it("says a linked machine is already on Connect", () => {
    const copy = studioConnectSidebarSignInCopy(true);
    expect(copy.label).toBe("Connect linked · Sign in here");
    expect(copy.tooltip).toContain("work from your main machine reaches it without signing in");
  });

  it("asks an unlinked machine to sign in", () => {
    expect(studioConnectSidebarSignInCopy(false).label).toBe("Sign in to SpecWithCode Connect");
  });
});
