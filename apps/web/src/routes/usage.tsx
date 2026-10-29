import { createFileRoute } from "@tanstack/react-router";

import { UsagePage } from "../components/usage/UsagePage";
import { useNavigateToMainApp } from "../components/sidebar/mainAppLocation";
import { SidebarInset } from "../components/ui/sidebar";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { isElectron } from "../env";

/** Usage opens the way Settings does: a sheet over the dimmed app, closed back to it. */
function UsageRoute() {
  const navigateToMainApp = useNavigateToMainApp();
  return (
    <>
      <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
        <WorkspacePageHeader electron={isElectron}>{null}</WorkspacePageHeader>
      </SidebarInset>
      <UsagePage variant="sheet" onClose={() => void navigateToMainApp()} />
    </>
  );
}

export const Route = createFileRoute("/usage")({
  component: UsageRoute,
});
