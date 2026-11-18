import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../WorkspaceBreadcrumb";
import { INTEGRATIONS_PATH, isIntegrationsPath } from "./integrations/integrationsTabs";
import { SETTINGS_SECTION_LABELS } from "./settingsSearch";
import { useTx } from "../../i18n";

const SETTINGS_BREADCRUMB_LABELS: Readonly<Record<string, string>> = {
  ...SETTINGS_SECTION_LABELS,
  "/settings/diagnostics": "Diagnostics",
  "/settings/open-source-licenses": "Open source licenses",
};

export function settingsBreadcrumbLabel(pathname: string): string | null {
  const normalizedPathname = pathname.replace(/\/+$/, "") || "/";
  // A tab of Integrations is still the Integrations page.
  const section = isIntegrationsPath(normalizedPathname) ? INTEGRATIONS_PATH : normalizedPathname;
  return SETTINGS_BREADCRUMB_LABELS[section] ?? null;
}

/**
 * `Settings / Section`. The scope a change applies to lives at the top of the
 * page content, see `SettingsScopeSentence`.
 */
export function SettingsBreadcrumb({ pathname }: { pathname: string }) {
  const tx = useTx();
  const englishLabel = settingsBreadcrumbLabel(pathname);
  const sectionLabel = englishLabel === null ? null : tx(englishLabel);

  return (
    <WorkspaceBreadcrumb ariaLabel={tx("Settings breadcrumb")}>
      {sectionLabel ? (
        <>
          <WorkspaceBreadcrumbItem>{tx("Settings")}</WorkspaceBreadcrumbItem>
          <WorkspaceBreadcrumbSeparator />
        </>
      ) : null}
      <WorkspaceBreadcrumbItem current className="truncate">
        {sectionLabel ?? tx("Settings")}
      </WorkspaceBreadcrumbItem>
    </WorkspaceBreadcrumb>
  );
}
