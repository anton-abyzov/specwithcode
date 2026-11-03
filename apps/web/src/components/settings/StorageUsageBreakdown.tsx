import { formatStorageFreeSpace, type StorageHomeUsage } from "@specweave-studio/contracts";

import { formatRelativeTimeLabel } from "../../timestampFormat";
import { homeUsagePartLabel } from "../LowDiskSpaceBanner.logic";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsRow } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";

const WARNING_SIZES_GB = [25, 50, 100, 200, 500] as const;

/** The size picker for the app folder warning: off or a size in GB. */
export function AppFolderSizeWarningControl({
  value,
  mixed,
  onChange,
}: {
  value: number | null;
  mixed: boolean;
  onChange: (value: number | null) => void;
}) {
  const sizes: ReadonlyArray<number> =
    value === null || WARNING_SIZES_GB.includes(value as (typeof WARNING_SIZES_GB)[number])
      ? WARNING_SIZES_GB
      : [...WARNING_SIZES_GB, value].toSorted((left, right) => left - right);
  const label = (size: number | null) => (size === null ? "Off" : `${size} GB`);
  return (
    <Select
      value={mixed ? null : value === null ? "off" : String(value)}
      onValueChange={(next) => {
        if (next === "off") onChange(null);
        else if (typeof next === "string" && Number.isInteger(Number(next))) onChange(Number(next));
      }}
    >
      <SelectTrigger size="sm" aria-label="Warn when the app folder is large">
        <SelectValue>{mixed ? "Mixed" : label(value)}</SelectValue>
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false}>
        <SelectItem value="off">Off</SelectItem>
        {sizes.map((size) => (
          <SelectItem key={size} value={String(size)}>
            {label(size)}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

/** "worktrees 102 GB · database 23 GB · ..." with abnormal growth called out. */
export function homeUsageBreakdown(usage: StorageHomeUsage): string {
  return usage.parts
    .map((part) => {
      const grew =
        part.grewBytes === undefined ? "" : ` (+${formatStorageFreeSpace(part.grewBytes)})`;
      const count = part.key === "worktrees" ? `, ${usage.worktreeCount} checkouts` : "";
      return `${homeUsagePartLabel(part.key)} ${formatStorageFreeSpace(part.bytes)}${count}${grew}`;
    })
    .join(" · ");
}

/**
 * The latest app folder measurement of each selected machine: total, parts
 * and worktree count, so a regression in any cleanup shows here first.
 */
export function AppFolderUsage() {
  const { connectedEnvironments } = useSettingsScope();
  const measured = connectedEnvironments.flatMap((environment) => {
    const usage = environment.serverConfig?.storage?.homeUsage;
    return usage === undefined ? [] : [{ label: environment.label, usage }];
  });
  if (measured.length === 0)
    return (
      <SettingsRow
        title="App folder size"
        description="Measured a few minutes after the app starts, then every six hours."
      />
    );
  return measured.map(({ label, usage }) => (
    <SettingsRow
      key={`${label}:${usage.path}`}
      title={
        measured.length > 1
          ? `${label}: ${formatStorageFreeSpace(usage.totalBytes)}`
          : `App folder size: ${formatStorageFreeSpace(usage.totalBytes)}`
      }
      status={
        usage.level === "large"
          ? "Over the warning size"
          : usage.level === "growing"
            ? "Growing fast"
            : undefined
      }
      description={
        <>
          <span className="block">{homeUsageBreakdown(usage)}</span>
          <span className="block text-muted-foreground">
            {usage.path}, checked {formatRelativeTimeLabel(usage.checkedAt)}
            {usage.complete ? "" : ". The check stopped early, so these sizes are a lower bound"}.
            Copies that share disk space (APFS clones) count in full here, so the disk may use less.
          </span>
        </>
      }
    />
  ));
}
