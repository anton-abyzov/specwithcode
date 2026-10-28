import { useState } from "react";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsRow, SettingResetButton } from "./settingsLayout";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

/** Scoped like worktree cleanup, but controls chat visibility only. */
export function InactiveThreadArchiveSetting() {
  const settings = useScopedSettings();
  const update = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed(["archiveInactiveThreadsAfterDays"]);
  const days = settings.archiveInactiveThreadsAfterDays;
  const [custom, setCustom] = useState(false);
  const mode = mixed ? "mixed" : days === null ? "never" : days === 30 && !custom ? "30" : "custom";
  return (
    <SettingsRow
      title="Archive inactive chats"
      description="Archive completed chats after 30 days without activity. Running, stopped, pinned, scheduled chats and saved drafts stay protected. History stays available. Worktree cleanup is a separate policy and preserves dirty or unpushed work."
      serverScoped
      settingKeys={["archiveInactiveThreadsAfterDays"]}
      resetAction={
        mixed || days !== 30 ? (
          <SettingResetButton
            label="inactive chat archiving"
            onClick={() => {
              setCustom(false);
              update({ archiveInactiveThreadsAfterDays: 30 });
            }}
          />
        ) : null
      }
      control={
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={mode}
            onValueChange={(value) => {
              if (value === "never") {
                setCustom(false);
                update({ archiveInactiveThreadsAfterDays: null });
              }
              if (value === "30") {
                setCustom(false);
                update({ archiveInactiveThreadsAfterDays: 30 });
              }
              if (value === "custom") {
                setCustom(true);
                if (days === null || mixed) update({ archiveInactiveThreadsAfterDays: 30 });
              }
            }}
          >
            <SelectTrigger aria-label="Archive inactive chats">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              {mixed ? <SelectItem value="mixed">Mixed</SelectItem> : null}
              <SelectItem value="30">After 30 days</SelectItem>
              <SelectItem value="custom">Custom</SelectItem>
              <SelectItem value="never">Never</SelectItem>
            </SelectPopup>
          </Select>
          {mode === "custom" ? (
            <label className="flex items-center gap-2 text-xs">
              <Input
                key={days}
                aria-label="Archive after days"
                type="number"
                min={1}
                max={3650}
                step={1}
                defaultValue={days ?? 30}
                className="w-20"
                onBlur={(event) => {
                  const value = Number(event.target.value);
                  if (Number.isInteger(value) && value >= 1 && value <= 3650)
                    update({ archiveInactiveThreadsAfterDays: value });
                  else event.target.value = String(days ?? 30);
                }}
              />{" "}
              days
            </label>
          ) : null}
        </div>
      }
    />
  );
}
