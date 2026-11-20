import { createFileRoute } from "@tanstack/react-router";

import { McpServersTab } from "../components/settings/integrations/McpServersTab";

export const Route = createFileRoute("/settings/integrations/mcp")({
  component: McpServersTab,
});
