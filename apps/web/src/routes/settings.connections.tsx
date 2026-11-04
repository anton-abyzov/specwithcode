import { createFileRoute } from "@tanstack/react-router";

import { MachinesSettingsPanel } from "../components/settings/MachinesSettings";

export const Route = createFileRoute("/settings/connections")({
  component: MachinesSettingsPanel,
});
