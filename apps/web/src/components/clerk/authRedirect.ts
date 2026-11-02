export interface ClerkSignInProps {
  forceRedirectUrl?: string;
  signUpForceRedirectUrl?: string;
}

/** Where to land after signing out: this same page, as after signing in. */
export function resolveClerkSignOutRedirectUrl(href: string, isElectron: boolean): string {
  return resolveClerkSignInProps(href, isElectron).forceRedirectUrl ?? href;
}

export function resolveClerkSignInProps(href: string, isElectron: boolean): ClerkSignInProps {
  if (isElectron) {
    // Electron routes through the hash, so reset any Clerk virtual pathname without losing the Studio page.
    const redirectUrl = new URL(href);
    redirectUrl.pathname = "/";
    redirectUrl.search = "";

    return {
      forceRedirectUrl: redirectUrl.toString(),
      signUpForceRedirectUrl: redirectUrl.toString(),
    };
  }
  // The sign-in modal can switch to sign-up, which follows its own redirect
  // target; without one Clerk falls back to the URL the modal was opened from.
  return { forceRedirectUrl: href, signUpForceRedirectUrl: href };
}
