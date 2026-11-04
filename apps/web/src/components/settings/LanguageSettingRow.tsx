import { useLocalePreference, useT } from "../../i18n";
import { LanguageSelect } from "./LanguageSelect";
import { searchableSetting } from "./settingsSearch";
import { SettingResetButton, SettingsRow } from "./settingsLayout";

/** Settings > Appearance: the language row. Device-local, like the color scheme. */
export function LanguageSettingRow() {
  const t = useT();
  const [preference, setPreference] = useLocalePreference();
  return (
    <SettingsRow
      id={searchableSetting("language").id}
      title={t("settings.language.title")}
      description={t("settings.language.description")}
      resetAction={
        preference !== "system" ? (
          <SettingResetButton
            label={t("settings.language.title").toLowerCase()}
            onClick={() => setPreference("system")}
          />
        ) : null
      }
      control={<LanguageSelect />}
    />
  );
}
