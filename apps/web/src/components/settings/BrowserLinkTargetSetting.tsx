/**
 * "Open links in": the OS default browser, the in-app browser, or (desktop)
 * a specific installed browser profile, e.g. the Chrome profile signed in to
 * a Google Ads account.
 *
 * @module BrowserLinkTargetSetting
 */
import { DEFAULT_BROWSER_LINK_TARGET } from "@specweave-studio/contracts";

import { buildLinkTargetOptions } from "~/browser/externalBrowserOptions";
import { canUseExternalBrowsers, useExternalBrowsers } from "~/browser/externalBrowsers";
import { useClientSettings, useUpdatePrimarySettings } from "~/hooks/useSettings";

import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

export function BrowserLinkTargetSetting({ disabled }: { readonly disabled: boolean }) {
  const linkTarget = useClientSettings((settings) => settings.browserLinkTarget);
  const externalTarget = useClientSettings((settings) => settings.browserExternalTarget);
  const updateSettings = useUpdatePrimarySettings();
  // Re-read on open so a browser profile created since launch shows up.
  const browsers = useExternalBrowsers({ enabled: !disabled, refreshKey: "settings" });
  const loading = browsers === null && canUseExternalBrowsers();
  const { options, selected } = buildLinkTargetOptions({
    browsers,
    linkTarget,
    externalTarget,
    loading,
  });
  const isDefault = linkTarget === DEFAULT_BROWSER_LINK_TARGET && externalTarget === null;

  return (
    <SettingsRow
      {...searchableSetting("browser-link-target")}
      description="Where chat and terminal links open. ⌘/Ctrl-click skips the in-app browser."
      resetAction={
        !disabled && !isDefault ? (
          <SettingResetButton
            label="link target"
            onClick={() =>
              updateSettings({
                browserLinkTarget: DEFAULT_BROWSER_LINK_TARGET,
                browserExternalTarget: null,
              })
            }
          />
        ) : null
      }
      control={
        <Select
          disabled={disabled}
          value={selected.value}
          onValueChange={(value) => {
            const option = options.find((candidate) => candidate.value === value);
            if (!option) return;
            updateSettings({
              browserLinkTarget: option.linkTarget,
              browserExternalTarget: option.externalTarget,
            });
          }}
        >
          <SelectTrigger size="sm" className="w-full sm:w-56" aria-label="Open links in">
            <SelectValue>
              <span className="block truncate">{selected.label}</span>
            </SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {options.map((option) => (
              <SelectItem hideIndicator key={option.value} value={option.value}>
                <span className="flex min-w-0 flex-col">
                  <span className="truncate">{option.label}</span>
                  {option.detail ? (
                    <span className="truncate text-xs text-muted-foreground">{option.detail}</span>
                  ) : null}
                </span>
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}
