/**
 * "Personal assistant": shows or hides the machine's personal assistant
 * (default name Percy), on every surface. Saved in this machine's server settings and on
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

import { useMachineAssistantName } from "../../studio/useMachineAssistantName";
import { Switch } from "../ui/switch";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

export function AideSetting() {
  const tx = useTx();
  const aideEnabled = usePrimarySettings((settings) => settings.aideEnabled);
  const available = usePrimarySettingsAvailable();
  const updateSettings = useUpdatePrimarySettings();
  const name = useMachineAssistantName();

  return (
    <SettingsRow
      {...searchableSetting("aide-enabled")}
      description={tx(
        "Show {name}, a private assistant for this machine, in the sidebar and command palette. Off hides it without deleting its chats.",
        { name },
      )}
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
