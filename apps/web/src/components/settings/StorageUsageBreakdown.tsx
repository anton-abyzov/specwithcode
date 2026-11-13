import { renderRich } from "../../i18n/rich";
import { useTx } from "../../i18n";
import { formatStorageFreeSpace, type StorageHomeUsage } from "@specweave-studio/contracts";

import { formatRelativeTimeLabel } from "../../timestampFormat";
import { useCleanOldAppVersions } from "../../lib/oldAppVersions";
import { homeUsagePartLabel, oldAppVersionsBytesOf } from "../LowDiskSpaceBanner.logic";
import { Button } from "../ui/button";
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
  const tx = useTx();
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
      <SelectTrigger size="sm" aria-label={tx("Warn when the app folder is large")}>
        <SelectValue>{mixed ? tx("Mixed") : label(value)}</SelectValue>
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false}>
        <SelectItem value="off">{tx("Off")}</SelectItem>
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
  const tx = useTx();
  const { connectedEnvironments } = useSettingsScope();
  const oldAppVersions = useCleanOldAppVersions();
  const measured = connectedEnvironments.flatMap((environment) => {
    const usage = environment.serverConfig?.storage?.homeUsage;
    const canClean =
      environment.serverConfig?.environment.capabilities.cleanOldAppVersions === true;
    return usage === undefined
      ? []
      : [
          {
            environmentId: environment.environmentId,
            label: environment.label,
            usage,
            oldAppVersionsBytes: canClean ? oldAppVersionsBytesOf(usage) : undefined,
          },
        ];
  });
  if (measured.length === 0)
    return (
      <SettingsRow
        title="App folder size"
        description="Measured a few minutes after the app starts, then every six hours."
      />
    );
  return measured.map(({ environmentId, label, usage, oldAppVersionsBytes }) => (
    <SettingsRow
      key={`${label}:${usage.path}`}
      control={
        oldAppVersionsBytes === undefined ? undefined : (
          <Button
            size="sm"
            variant="outline"
            disabled={oldAppVersions.isPending(environmentId)}
            onClick={() => void oldAppVersions.clean(environmentId)}
            data-clean-old-app-versions=""
          >
            {oldAppVersions.isPending(environmentId)
              ? "Removing…"
              : `Remove old app versions (${formatStorageFreeSpace(oldAppVersionsBytes)})`}
          </Button>
        )
      }
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
            {renderRich(
              tx(
                "{path}, checked {value}{value2}. Copies that share disk space (APFS clones) count in full here, so the disk may use less.",
              ),
              {
                path: usage.path,
                value: formatRelativeTimeLabel(usage.checkedAt),
                value2: usage.complete
                  ? ""
                  : ". The check stopped early, so these sizes are a lower bound",
              },
            )}
          </span>
        </>
      }
    />
  ));
}

/** Shell steps that move the app folder to a roomier volume and leave a link behind. */
export function roomierVolumeMoveSteps(input: {
  readonly homePath: string;
  readonly volumePath: string;
}): string {
  const target = `${input.volumePath.replace(/\/$/, "")}/specwithcode`;
  return [
    "systemctl --user stop studio.service   # quit the desktop app first",
    `sudo install -d -o "$USER" -g "$USER" ${target}`,
    `rsync -a ${input.homePath}/ ${target}/`,
    `mv ${input.homePath} ${input.homePath}.old && ln -s ${target} ${input.homePath}`,
    "systemctl --user start studio.service",
    `# once it works: rm -rf ${input.homePath}.old`,
  ].join("\n");
}

/**
 * A machine whose disk is low while a much larger local volume sits beside it
 * (Linux: /srv, /data, a second disk) gets the steps to keep the app folder there.
 */
export function RoomierVolumeAdvice() {
  const { connectedEnvironments } = useSettingsScope();
  const advised = connectedEnvironments.flatMap((environment) => {
    const storage = environment.serverConfig?.storage;
    const roomier = storage?.roomierVolume;
    return roomier === undefined
      ? []
      : [
          {
            label: environment.label,
            roomier,
            homePath: storage?.homeUsage?.path ?? "~/.specwithcode",
          },
        ];
  });
  return advised.map(({ label, roomier, homePath }) => (
    <SettingsRow
      key={`${label}:${roomier.path}`}
      title={`${label}: ${roomier.path} has ${formatStorageFreeSpace(roomier.freeBytes)} free`}
      status="Bigger drive available"
      description={
        <>
          <span className="block">
            {`This disk is almost full, but ${roomier.path} (${roomier.fileSystem}) has far more room. Keep the app folder there so worktrees, builds and app versions have space.${
              roomier.clones
                ? ` ${roomier.fileSystem} copies files without duplicating them, so worktree copies cost almost nothing.`
                : ""
            }`}
          </span>
          <pre
            className="mt-2 overflow-x-auto rounded-md bg-muted p-2 text-xs"
            data-roomier-steps=""
          >
            {roomierVolumeMoveSteps({ homePath, volumePath: roomier.path })}
          </pre>
        </>
      }
    />
  ));
}
