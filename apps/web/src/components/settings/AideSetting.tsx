/**
 * "Personal assistant (beta)": shows or hides Aide, the machine's personal
 * assistant, on every surface. Saved in this machine's server settings and off
 * by default. Off hides it and stops new setups; nothing is deleted.
 *
 * @module AideSetting
 */
import {
  usePrimarySettings,
  usePrimarySettingsAvailable,
  useUpdatePrimarySettings,
} from "~/hooks/useSettings";

import { Switch } from "../ui/switch";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

export function AideSetting() {
  const aideEnabled = usePrimarySettings((settings) => settings.aideEnabled);
  const available = usePrimarySettingsAvailable();
  const updateSettings = useUpdatePrimarySettings();

  return (
    <SettingsRow
      {...searchableSetting("aide-enabled")}
      description="Show Aide, a private assistant for this machine, in the sidebar and command palette. Off hides it without deleting its chats."
      control={
        <Switch
          checked={aideEnabled}
          disabled={!available}
          onCheckedChange={(checked) => void updateSettings({ aideEnabled: Boolean(checked) })}
          aria-label="Personal assistant (beta)"
        />
      }
    />
  );
}
