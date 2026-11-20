import { useTx } from "../../i18n";
import { NativeConnectionsPanel } from "../connections/NativeConnectionsPanel";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsSection } from "./settingsLayout";

/**
 * The MCP servers the page's machine declares. The machine comes from the
 * scope line above the tabs, so the section has no picker of its own and
 * cannot show a different machine than the line names.
 */
export function ConnectionsLibrarySettings() {
  const tx = useTx();
  const { scope } = useSettingsScope();
  const environmentId = scope.kind === "environment" ? scope.environmentId : null;
  return (
    <SettingsSection id="mcp-connections" title="MCP connections">
      <div className="px-3 py-2.5 sm:px-4">
        {scope.kind === "unavailable" ? (
          <p role="status" className="text-sm text-muted-foreground">
            {scope.message}
          </p>
        ) : environmentId ? (
          <NativeConnectionsPanel key={environmentId} environmentId={environmentId} />
        ) : (
          <p role="status" className="text-sm text-muted-foreground">
            {tx("Connect a machine to see its MCP servers.")}
          </p>
        )}
      </div>
    </SettingsSection>
  );
}
