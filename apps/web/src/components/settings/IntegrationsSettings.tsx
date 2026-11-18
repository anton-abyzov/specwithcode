import { ConnectionsLibrarySettings } from "./ConnectionsLibrarySettings";
/**
 * Integrations settings - preferences for surfaces SpecWithCode embeds rather than
 * owns. Browser is the first section: the defaults a preview tab opens at,
 * applied to both hand-opened tabs and agent `preview_open` calls that don't
 * state their own size.
 *
 * @module IntegrationsSettings
 */
import { SettingsPageContainer } from "./settingsLayout";
import { ProjectDefaultsSettings } from "./ProjectDefaultsSettings";
import { DeviceIntegrationSettings } from "./integrations/DevicesTab";
import { PreviewRecordingSettings } from "./integrations/PreviewRecordingTab";

export {
  browserProfileRemovalAvailable,
  clearBrowserProfileData,
  importFailureReason,
  type ServerProfileData,
} from "./integrations/BrowserProfilesSetting";
export { DeviceIntegrationControls } from "./integrations/DevicesTab";

export function IntegrationsSettingsPanel() {
  return (
    <SettingsPageContainer>
      {/* Server-authoritative agent access is scoped by the header selection;
          the preview defaults below are device-local and ignore it. */}
      <ProjectDefaultsSettings category="integrations" />
      <ConnectionsLibrarySettings />
      <PreviewRecordingSettings />
      <DeviceIntegrationSettings />
    </SettingsPageContainer>
  );
}
