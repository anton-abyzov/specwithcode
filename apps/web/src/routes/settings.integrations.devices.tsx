import { createFileRoute } from "@tanstack/react-router";

import { DevicesTab } from "../components/settings/integrations/DevicesTab";

export const Route = createFileRoute("/settings/integrations/devices")({
  component: DevicesTab,
});
