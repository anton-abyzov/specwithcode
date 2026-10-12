/**
 * The Google OAuth client shipped with Studio, so connecting Gmail, Calendar
 * and Drive is one click instead of a trip through Google Cloud Console.
 *
 * It is a "Desktop app" client. Google treats an installed app's client secret
 * as public: anyone can read it out of the app, and the authorization code is
 * protected by PKCE and the loopback redirect instead. The values are injected
 * at build time from `STUDIO_GOOGLE_OAUTH_CLIENT_ID` and
 * `STUDIO_GOOGLE_OAUTH_CLIENT_SECRET` (the repo `.env` or the build
 * environment); the same variables at runtime override them. A build without
 * them has no Studio client and the person saves their own.
 *
 * @module googleBuiltInClient
 */
import {
  GOOGLE_CLIENT_ID_PATTERN,
  GOOGLE_CLIENT_SECRET_PATTERN,
} from "@specweave-studio/contracts";
import * as Context from "effect/Context";
import * as Redacted from "effect/Redacted";

declare const __STUDIO_BUILD_GOOGLE_OAUTH_CLIENT_ID__: string | undefined;
declare const __STUDIO_BUILD_GOOGLE_OAUTH_CLIENT_SECRET__: string | undefined;

export interface GoogleOAuthClient {
  readonly clientId: string;
  readonly clientSecret: Redacted.Redacted<string>;
}

const buildTime = {
  clientId:
    typeof __STUDIO_BUILD_GOOGLE_OAUTH_CLIENT_ID__ === "undefined"
      ? ""
      : __STUDIO_BUILD_GOOGLE_OAUTH_CLIENT_ID__,
  clientSecret:
    typeof __STUDIO_BUILD_GOOGLE_OAUTH_CLIENT_SECRET__ === "undefined"
      ? ""
      : __STUDIO_BUILD_GOOGLE_OAUTH_CLIENT_SECRET__,
};

/** A runtime pair wins over the build-time pair; a half or malformed pair counts as none. */
export function resolveBuiltInGoogleClient(
  env: Readonly<Record<string, string | undefined>>,
  build: { readonly clientId: string; readonly clientSecret: string } = buildTime,
): GoogleOAuthClient | null {
  const runtimeId = env.STUDIO_GOOGLE_OAUTH_CLIENT_ID?.trim() ?? "";
  const runtimeSecret = env.STUDIO_GOOGLE_OAUTH_CLIENT_SECRET?.trim() ?? "";
  const useRuntime = runtimeId !== "" || runtimeSecret !== "";
  const clientId = useRuntime ? runtimeId : build.clientId.trim();
  const clientSecret = useRuntime ? runtimeSecret : build.clientSecret.trim();
  if (
    !GOOGLE_CLIENT_ID_PATTERN.test(clientId) ||
    !GOOGLE_CLIENT_SECRET_PATTERN.test(clientSecret)
  ) {
    return null;
  }
  return { clientId, clientSecret: Redacted.make(clientSecret) };
}

export const BuiltInGoogleClient = Context.Reference<GoogleOAuthClient | null>(
  "studio/integrations/BuiltInGoogleClient",
  { defaultValue: () => resolveBuiltInGoogleClient(process.env) },
);
