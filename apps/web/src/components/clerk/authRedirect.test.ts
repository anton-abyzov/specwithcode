import { describe, expect, it } from "vite-plus/test";

import { resolveClerkSignInProps, resolveClerkSignOutRedirectUrl } from "./authRedirect";

describe("resolveClerkSignInProps", () => {
  it("returns to the current browser URL on the web", () => {
    const href = "https://app.studio.invalid/connect?state=state-1#details";
    expect(resolveClerkSignInProps(href, false)).toEqual({
      forceRedirectUrl: href,
      signUpForceRedirectUrl: href,
    });
  });

  it("removes a Clerk virtual pathname and callback params while preserving the desktop route", () => {
    expect(
      resolveClerkSignInProps(
        "studio://app/CLERK-ROUTER/VIRTUAL/sign-up?__clerk_status=complete#/settings/connections",
        true,
      ),
    ).toEqual({
      forceRedirectUrl: "studio://app/#/settings/connections",
      signUpForceRedirectUrl: "studio://app/#/settings/connections",
    });
  });

  it("preserves a clean development desktop route", () => {
    expect(resolveClerkSignInProps("studio-dev://app/#/settings/general", true)).toEqual({
      forceRedirectUrl: "studio-dev://app/#/settings/general",
      signUpForceRedirectUrl: "studio-dev://app/#/settings/general",
    });
  });
});

describe("resolveClerkSignOutRedirectUrl", () => {
  it("stays on the current page on the web", () => {
    const href = "https://app.studio.invalid/usage";
    expect(resolveClerkSignOutRedirectUrl(href, false)).toBe(href);
  });

  it("keeps the desktop route and drops a Clerk virtual pathname", () => {
    expect(resolveClerkSignOutRedirectUrl("studio://app/sign-in?x=1#/usage", true)).toBe(
      "studio://app/#/usage",
    );
  });
});
