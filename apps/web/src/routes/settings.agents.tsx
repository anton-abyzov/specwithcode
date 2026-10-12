import { createFileRoute } from "@tanstack/react-router";

import { AgentInstructionsSettings } from "../components/settings/AgentInstructionsSettings";

export const Route = createFileRoute("/settings/agents")({
  component: AgentInstructionsSettings,
});
