import { lazy, memo, Suspense } from "react";

import { hasCloudPublicConfig } from "../../cloud/publicConfig";
import { RenderErrorBoundary } from "../RenderErrorBoundary";
import { AccountMenu } from "./AccountMenu";

// Clerk's hooks need its provider, which only builds with Connect mount.
const ConnectSidebarAccountMenu = lazy(() => import("../clerk/ConnectSidebarAccountMenu"));

export const SidebarAccountMenu = memo(function SidebarAccountMenu({
  compact = false,
}: {
  readonly compact?: boolean;
}) {
  const local = <AccountMenu compact={compact} connect={null} />;
  if (!hasCloudPublicConfig()) return local;
  return (
    // If the Connect chunk still cannot load, keep the local menu, not the root error page.
    <RenderErrorBoundary fallback={local}>
      <Suspense fallback={local}>
        <ConnectSidebarAccountMenu compact={compact} />
      </Suspense>
    </RenderErrorBoundary>
  );
});
