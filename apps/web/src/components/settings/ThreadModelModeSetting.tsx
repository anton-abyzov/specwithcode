import type { ThreadModelMode } from "@specweave-studio/contracts";

import { useTx } from "../../i18n";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

const MODES: ReadonlyArray<ThreadModelMode> = ["tracks", "model"];

/**
 * What a project's new threads start on when nobody names a model: the track
 * for the task, or the one model the project saved.
 */
export function ThreadModelModeSetting() {
  const tx = useTx();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed(["threadModelMode"]);
  const label = (mode: ThreadModelMode) => (mode === "tracks" ? tx("Tracks") : tx("One model"));
  return (
    <SettingsRow
      serverScoped
      settingKeys={["threadModelMode"]}
      mixed={mixed}
      id="thread-model-mode"
      title={tx("New threads use")}
      description={
        mixed
          ? tx(
              "The selected projects disagree. Tracks and One model are the only choices, and picking one writes it for every project in this view.",
            )
          : settings.threadModelMode === "tracks"
            ? tx(
                "A thread started without a named model takes the first available model of the Complex track for hard work, else the Daily track.",
              )
            : tx("A thread started without a named model takes the model below.")
      }
      resetAction={
        settings.threadModelMode !== "model" ? (
          <SettingResetButton
            label={tx("new thread model choice")}
            onClick={() => updateSettings({ threadModelMode: "model" })}
          />
        ) : null
      }
      control={
        <Select
          value={mixed ? null : settings.threadModelMode}
          onValueChange={(value) => {
            if (value === "tracks" || value === "model") updateSettings({ threadModelMode: value });
          }}
        >
          <SelectTrigger size="sm" aria-label={tx("New threads use")}>
            <SelectValue>
              {(value: string | null) =>
                value === "tracks" || value === "model" ? label(value) : tx("Mixed")
              }
            </SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {MODES.map((mode) => (
              <SelectItem key={mode} value={mode}>
                {label(mode)}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}
