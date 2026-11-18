import { AuthFilesystemWriteScope } from "@specweave-studio/contracts";

import { ConnectionsLibrarySettings } from "../ConnectionsLibrarySettings";
import { IntegrationsMachineState, IntegrationsTabPanel } from "./IntegrationsTabStrip";

/** The MCP servers the selected machine's AI tools declare. */
export function McpServersTab() {
  return (
    <IntegrationsTabPanel tab="mcp">
      {/* Servers are entries in the tools' own files, so changing them takes
          the right to write files; the panel turns its own controls off and
          keeps each server's details open to read. */}
      <IntegrationsMachineState changeScope={AuthFilesystemWriteScope} disableRows={false}>
        <ConnectionsLibrarySettings />
      </IntegrationsMachineState>
    </IntegrationsTabPanel>
  );
}
