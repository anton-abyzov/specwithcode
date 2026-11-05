import { renderRich } from "../../i18n/rich";
import { useTx } from "../../i18n";
import { DEFAULT_KEEP_ACTIVE_THREADS_PER_PROJECT } from "@specweave-studio/contracts";
import { useState } from "react";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsRow, SettingResetButton } from "./settingsLayout";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

const DEFAULT_CAP = DEFAULT_KEEP_ACTIVE_THREADS_PER_PROJECT;
const MIN_CAP = 20;
const MAX_CAP = 5000;

/** Project-scoped: a project page writes an override, the environment page sets the default. */
export function ActiveThreadCapSetting() {
  const tx = useTx();
  const settings = useScopedSettings();
  const update = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed(["keepActiveThreadsPerProject"]);
  const cap = settings.keepActiveThreadsPerProject;
  const [custom, setCustom] = useState(false);
  const mode = mixed
    ? "mixed"
    : cap === null
      ? "none"
      : cap === DEFAULT_CAP && !custom
        ? "default"
        : "custom";
  return (
    <SettingsRow
      title={tx("Keep active chats per project")}
      description="When a project has more chats than this, the oldest finished ones are archived. History stays available, and Unarchive brings a chat back. Running, waiting, pinned or recently active chats are never archived."
      serverScoped
      settingKeys={["keepActiveThreadsPerProject"]}
      resetAction={
        mixed || cap !== DEFAULT_CAP ? (
          <SettingResetButton
            label={tx("active chat limit")}
            onClick={() => {
              setCustom(false);
              update({ keepActiveThreadsPerProject: DEFAULT_CAP });
            }}
          />
        ) : null
      }
      control={
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={mode}
            onValueChange={(value) => {
              if (value === "none") {
                setCustom(false);
                update({ keepActiveThreadsPerProject: null });
              }
              if (value === "default") {
                setCustom(false);
                update({ keepActiveThreadsPerProject: DEFAULT_CAP });
              }
              if (value === "custom") {
                setCustom(true);
                if (cap === null || mixed) update({ keepActiveThreadsPerProject: DEFAULT_CAP });
              }
            }}
          >
            <SelectTrigger aria-label={tx("Keep active chats per project")}>
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              {mixed ? <SelectItem value="mixed">{tx("Mixed")}</SelectItem> : null}
              <SelectItem value="default">
                {renderRich(tx("{DEFAULT_CAP} chats"), { DEFAULT_CAP: DEFAULT_CAP })}
              </SelectItem>
              <SelectItem value="custom">{tx("Custom")}</SelectItem>
              <SelectItem value="none">{tx("No limit")}</SelectItem>
            </SelectPopup>
          </Select>
          {mode === "custom" ? (
            <label className="flex items-center gap-2 text-xs">
              {renderRich(tx("{input} chats"), {
                input: (
                  <Input
                    key={cap}
                    aria-label={tx("Active chats to keep")}
                    type="number"
                    min={MIN_CAP}
                    max={MAX_CAP}
                    step={1}
                    defaultValue={cap ?? DEFAULT_CAP}
                    className="w-20"
                    onBlur={(event) => {
                      const value = Number(event.target.value);
                      if (Number.isInteger(value) && value >= MIN_CAP && value <= MAX_CAP)
                        update({ keepActiveThreadsPerProject: value });
                      else event.target.value = String(cap ?? DEFAULT_CAP);
                    }}
                  />
                ),
              })}
            </label>
          ) : null}
        </div>
      }
    />
  );
}
