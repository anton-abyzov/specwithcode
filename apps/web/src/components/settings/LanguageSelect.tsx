import { LanguagesIcon } from "lucide-react";

import {
  isLocalePreference,
  LOCALE_NATIVE_NAMES,
  resolveSystemLocale,
  SUPPORTED_LOCALES,
  useLocalePreference,
  useT,
  type LocalePreference,
} from "../../i18n";
import { cn } from "../../lib/utils";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";

const PREFERENCES: ReadonlyArray<LocalePreference> = ["system", ...SUPPORTED_LOCALES];

/**
 * The interface language for this device. Each language is listed in its own
 * name, and "System" follows the browser or OS language.
 */
export function LanguageSelect({
  className,
  showIcon = false,
}: {
  readonly className?: string;
  readonly showIcon?: boolean;
}) {
  const t = useT();
  // What "System" switches to here, not the language showing now.
  const systemLocale = resolveSystemLocale(
    typeof navigator === "undefined" ? [] : navigator.languages,
  );
  const [preference, setPreference] = useLocalePreference();
  const label = (value: LocalePreference) =>
    value === "system"
      ? t("settings.language.system", { language: LOCALE_NATIVE_NAMES[systemLocale] })
      : LOCALE_NATIVE_NAMES[value];
  return (
    <Select
      value={preference}
      onValueChange={(value) => {
        if (isLocalePreference(value)) setPreference(value);
      }}
    >
      <SelectTrigger
        size="sm"
        className={cn("w-full sm:w-52", className)}
        aria-label={t("settings.language.title")}
      >
        {showIcon ? <LanguagesIcon aria-hidden className="size-3.5 text-muted-foreground" /> : null}
        <SelectValue>
          {(value: string | null) => (isLocalePreference(value) ? label(value) : null)}
        </SelectValue>
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false}>
        {PREFERENCES.map((value) => (
          <SelectItem key={value} value={value} lang={value === "system" ? undefined : value}>
            {label(value)}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}
