import { lazy, Suspense } from "react";

import { hasCloudPublicConfig } from "../../../cloud/publicConfig";
import { RenderErrorBoundary } from "../../RenderErrorBoundary";

// Clerk's hooks need its provider, which only builds with Connect mount.
const ConnectSignedOutBanner = lazy(() => import("../../clerk/ConnectSignedOutBanner"));

/** The signed-out banner (1417); nothing in a build without SpecWithCode Connect. */
export function SignedOutBanner() {
  if (!hasCloudPublicConfig()) return null;
  return (
    <RenderErrorBoundary fallback={null}>
      <Suspense fallback={null}>
        <ConnectSignedOutBanner />
      </Suspense>
    </RenderErrorBoundary>
  );
}
