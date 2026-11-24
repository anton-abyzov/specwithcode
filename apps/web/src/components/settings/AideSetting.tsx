/**
 * "Personal assistant": shows or hides Percy, the personal assistant, on
 * every surface of this machine. Saved in this machine's server settings and on
 * by default. Off hides it and stops new setups; nothing is deleted.
 *
 * @module AideSetting
 */
import { useTx } from "../../i18n";
import {
  usePrimarySettings,
  usePrimarySettingsAvailable,
  useUpdatePrimarySettings,
} from "~/hooks/useSettings";

import { Switch } from "../ui/switch";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

export function AideSetting() {
  const tx = useTx();
  const aideEnabled = usePrimarySettings((settings) => settings.aideEnabled);
  const available = usePrimarySettingsAvailable();
  const updateSettings = useUpdatePrimarySettings();

  return (
    <SettingsRow
      {...searchableSetting("aide-enabled")}
      description="Show Percy, your personal assistant, in the sidebar and command palette. Off hides it without deleting its chats."
      control={
        <Switch
          checked={aideEnabled}
          disabled={!available}
          onCheckedChange={(checked) => void updateSettings({ aideEnabled: Boolean(checked) })}
          aria-label={tx("Personal assistant")}
        />
      }
    />
  );
}
