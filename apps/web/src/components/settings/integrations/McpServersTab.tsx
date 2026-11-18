import { AuthFilesystemWriteScope, AuthTerminalOperateScope } from "@specweave-studio/contracts";

import { ConnectionsLibrarySettings } from "../ConnectionsLibrarySettings";
import { IntegrationsMachineState, IntegrationsTabPanel } from "./IntegrationsTabStrip";

/** The MCP servers the selected machine's AI tools declare. */
export function McpServersTab() {
  return (
    <IntegrationsTabPanel tab="mcp">
      {/* Servers are entries in the tools' own files, and the panel changes
          them only for a sign-in that may both write files and operate the
          terminal. It turns its own controls off and keeps each server's
          details open to read. */}
      <IntegrationsMachineState
        changeScope={AuthFilesystemWriteScope}
        alsoScope={AuthTerminalOperateScope}
        disableRows={false}
      >
        <ConnectionsLibrarySettings />
      </IntegrationsMachineState>
    </IntegrationsTabPanel>
  );
}
