/**
 * Settings > About: "Ask for a GitHub star". On until the person turns it off or answers the
 * card. Off ends the asking on every machine; On after Off starts a fresh three-ask budget.
 * After a star or the last ask it stays On and asks nothing more (1489).
 */
import { useTx } from "../../i18n";
import {
  usePrimarySettings,
  usePrimarySettingsAvailable,
  useUpdatePrimarySettings,
} from "../../hooks/useSettings";
import { SettingsRow } from "../settings/settingsLayout";
import { searchableSetting } from "../settings/settingsSearch";
import { Switch } from "../ui/switch";
import { setStarPromptEnabled } from "./githubStarPrompt.logic";

export function GitHubStarPromptSetting() {
  const tx = useTx();
  const status = usePrimarySettings((settings) => settings.githubStarPrompt.status);
  const available = usePrimarySettingsAvailable();
  const updateSettings = useUpdatePrimarySettings();
  return (
    <SettingsRow
      {...searchableSetting("github-star-prompt")}
      description="After you have used the app for a few days, ask up to three times whether you would star it. It stops for good once you star it or answer Already starred."
      control={
        <Switch
          checked={status !== "off"}
          disabled={!available}
          onCheckedChange={(checked) =>
            void updateSettings({ githubStarPrompt: setStarPromptEnabled(Boolean(checked)) })
          }
          aria-label={tx("Ask for a GitHub star")}
        />
      }
    />
  );
}
