/**
 * Dictation language and mode, beside the voice switch. One value for the
 * whole app: every project's coordinator and every thread composer use it.
 * The shortcut itself lives in Keybindings.
 *
 * @module DictationSettings
 */
import { useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import type { DictationMode } from "@specweave-studio/contracts";

import { useTx } from "../../i18n";
import { useClientSettings, useUpdateClientSettings } from "../../hooks/useSettings";
import { shortcutLabelForCommand } from "../../keybindings";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

/** Languages both engines handle well; anything else can still be detected from the speech. */
export const DICTATION_LANGUAGES: ReadonlyArray<{
  readonly value: string;
  readonly label: string;
}> = [
  { value: "", label: "System" },
  { value: "en-US", label: "English (US)" },
  { value: "en-GB", label: "English (UK)" },
  { value: "ru-RU", label: "Russian" },
  { value: "uk-UA", label: "Ukrainian" },
  { value: "de-DE", label: "German" },
  { value: "fr-FR", label: "French" },
  { value: "es-ES", label: "Spanish" },
  { value: "it-IT", label: "Italian" },
  { value: "pt-BR", label: "Portuguese (Brazil)" },
  { value: "pl-PL", label: "Polish" },
  { value: "nl-NL", label: "Dutch" },
  { value: "tr-TR", label: "Turkish" },
  { value: "ja-JP", label: "Japanese" },
  { value: "ko-KR", label: "Korean" },
  { value: "zh-CN", label: "Chinese (Simplified)" },
];

const MODE_LABELS: Record<DictationMode, string> = {
  toggle: "Press to start and stop",
  hold: "Hold to talk",
};

/** Select values cannot be empty, so System travels as this. */
const SYSTEM = "system";

export function dictationLanguageLabel(value: string): string {
  return DICTATION_LANGUAGES.find((language) => language.value === value)?.label ?? value;
}

export function DictationSettings() {
  const tx = useTx();
  const language = useClientSettings((settings) => settings.dictationLanguage);
  const mode = useClientSettings((settings) => settings.dictationMode);
  const updateSettings = useUpdateClientSettings();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const shortcut = shortcutLabelForCommand(keybindings, "composer.dictation.toggle");

  return (
    <>
      <SettingsRow
        {...searchableSetting("dictation-language")}
        description="The language dictation listens for, in every project and thread. System follows the Mac's language; on Linux it detects the language from your speech."
        resetAction={
          language !== "" ? (
            <SettingResetButton
              label={tx("dictation language")}
              onClick={() => updateSettings({ dictationLanguage: "" })}
            />
          ) : null
        }
        control={
          <Select
            value={language === "" ? SYSTEM : language}
            onValueChange={(value) => {
              if (typeof value !== "string") return;
              updateSettings({ dictationLanguage: value === SYSTEM ? "" : value });
            }}
          >
            <SelectTrigger
              size="sm"
              className="w-full sm:w-48"
              aria-label={tx("Dictation language")}
            >
              <SelectValue>{dictationLanguageLabel(language)}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {DICTATION_LANGUAGES.map((option) => (
                <SelectItem hideIndicator key={option.value} value={option.value || SYSTEM}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        {...searchableSetting("dictation-mode")}
        description={
          <>
            {shortcut
              ? `${shortcut} dictates into the message box you are in, the coordinator's or a thread's. `
              : "No dictation shortcut is set. "}
            <Link to="/settings/keybindings" className="underline underline-offset-2">
              {tx("Change it in Keybindings")}
            </Link>
          </>
        }
        resetAction={
          mode !== "toggle" ? (
            <SettingResetButton
              label={tx("dictation mode")}
              onClick={() => updateSettings({ dictationMode: "toggle" })}
            />
          ) : null
        }
        control={
          <Select
            value={mode}
            onValueChange={(value) => {
              if (value === "toggle" || value === "hold") updateSettings({ dictationMode: value });
            }}
          >
            <SelectTrigger
              size="sm"
              className="w-full sm:w-48"
              aria-label={tx("Dictation shortcut")}
            >
              <SelectValue>{MODE_LABELS[mode]}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectItem hideIndicator value="toggle">
                {MODE_LABELS.toggle}
              </SelectItem>
              <SelectItem hideIndicator value="hold">
                {MODE_LABELS.hold}
              </SelectItem>
            </SelectPopup>
          </Select>
        }
      />
    </>
  );
}
