import { createFileRoute, redirect } from "@tanstack/react-router";

import { DESIGN_FEATURES } from "../components/design/designFeatures";
import { DesignSystemsSettings } from "../components/settings/DesignSystemsSettings";

/** Not reachable until design systems ship (designFeatures.ts); the URL opens General instead. */
export const designSystemsRouteGuard = (features: { readonly designSystems: boolean }) => {
  if (!features.designSystems) throw redirect({ to: "/settings/general", replace: true });
};

export const Route = createFileRoute("/settings/design-systems")({
  beforeLoad: () => designSystemsRouteGuard(DESIGN_FEATURES),
  component: DesignSystemsSettings,
});
