import { createFileRoute } from "@tanstack/react-router";

import { AgentAccessTab } from "../components/settings/integrations/AgentAccessTab";

export const Route = createFileRoute("/settings/integrations/access")({
  component: AgentAccessTab,
});
