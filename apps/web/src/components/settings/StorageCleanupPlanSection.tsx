import {
  AuthSettingsWriteScope,
  formatStorageFreeSpace,
  type EnvironmentId,
  type StorageCleanupPlanItem,
} from "@specweave-studio/contracts";
import { useState } from "react";

import { useTx } from "../../i18n";
import {
  describeStorageCleanupReason,
  describeStorageCleanupRun,
  describeStorageCleanupTotal,
  groupStorageCleanupPlan,
  storageCleanupFolderLabel,
  storageCleanupPlanFailure,
  useStorageCleanupPlan,
} from "../../lib/storageCleanupPlan";
import { useEnvironmentScope } from "../../state/session";
import { Button } from "../ui/button";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";

/** Rows shown per group before "Show all": a machine can hold dozens of worktrees. */
export const STORAGE_CLEANUP_ROWS_SHOWN = 20;

/**
 * Settings > Storage, machine scope: what the storage cleanup would remove and
 * what it keeps, with the reason for each folder, and "Clean up now". Only
 * machines whose server answers the plan get a row, so an older server never
 * sees a request it cannot answer.
 */
export function StorageCleanupPlanSection() {
  const tx = useTx();
  const { connectedEnvironments } = useSettingsScope();
  const machines = connectedEnvironments.filter(
    (environment) => environment.serverConfig?.environment.capabilities.storageCleanupPlan === true,
  );
  if (machines.length === 0) return null;
  return (
    <SettingsSection id="storage-cleanup-plan" title={tx("What cleanup would remove")}>
      {machines.map((environment) => (
        <StorageCleanupPlanMachine
          key={environment.environmentId}
          environmentId={environment.environmentId}
          label={machines.length > 1 ? environment.label : null}
        />
      ))}
    </SettingsSection>
  );
}

function StorageCleanupPlanMachine({
  environmentId,
  label,
}: {
  environmentId: EnvironmentId;
  /** The machine's name when several are selected; null names nothing. */
  label: string | null;
}) {
  const tx = useTx();
  const { state, check, cleanUp } = useStorageCleanupPlan(environmentId);
  const canWrite = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const plan = "plan" in state ? state.plan : null;
  const groups = plan === null ? null : groupStorageCleanupPlan(plan);
  const failure = plan === null ? null : storageCleanupPlanFailure(plan);
  const checking = state.status === "checking";
  const cleaning = state.status === "cleaning";
  const busy = checking || cleaning;
  const removable = groups?.remove.length ?? 0;

  return (
    <SettingsRow
      title={label ?? "Chat worktrees and leftover downloads"}
      literal={label !== null}
      description="Shows what the cleanup would remove and what it keeps, and why. The check asks the Git host about each finished folder, so it runs only when you press Check."
      serverScoped
      data-storage-cleanup-plan={environmentId}
      control={
        <>
          <Button
            size="sm"
            variant="outline"
            disabled={!canWrite || busy}
            onClick={() => void check()}
            data-storage-cleanup-check=""
          >
            {checking ? tx("Checking…") : plan === null ? tx("Check") : tx("Check again")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!canWrite || busy || removable === 0}
            onClick={() => void cleanUp()}
            data-storage-cleanup-run=""
          >
            {cleaning ? tx("Cleaning up…") : tx("Clean up now")}
          </Button>
        </>
      }
    >
      <div className="space-y-3 pb-3 text-xs">
        {state.status === "cleaned" ? (
          <p role="status" className="text-success-foreground">
            {describeStorageCleanupRun(state.result, tx)}
          </p>
        ) : null}
        {state.status === "error" ? (
          <p role="alert" className="text-destructive-foreground">
            {state.message}
          </p>
        ) : null}
        {checking ? <p className="text-muted-foreground">{tx("Checking…")}</p> : null}
        {plan !== null && groups !== null ? (
          <>
            <div className="space-y-0.5">
              {failure === null ? (
                <p className="font-medium text-foreground">
                  {removable === 0
                    ? tx("Nothing to remove right now.")
                    : describeStorageCleanupTotal(plan, tx)}
                </p>
              ) : (
                // Never "Nothing to remove": a check that could not finish knows nothing.
                <p role="alert" className="font-medium text-destructive-foreground">
                  {tx("The check could not finish.")}
                  {failure.reason === null ? null : <> {failure.reason}</>}
                </p>
              )}
              {failure !== null && plan.items.length === 0 ? null : (
                <p className="text-muted-foreground">
                  {tx(
                    "Dependency folders are left out: their files are shared with the package store.",
                  )}
                  {plan.complete ? null : (
                    <> {tx("Some folders could not be fully checked or measured.")}</>
                  )}
                </p>
              )}
            </div>
            <StorageCleanupPlanGroup title={tx("Would be removed")} items={groups.remove} />
            <StorageCleanupPlanGroup title={tx("Kept")} items={groups.keep} />
          </>
        ) : null}
      </div>
    </SettingsRow>
  );
}

function StorageCleanupPlanGroup({
  title,
  items,
}: {
  title: string;
  items: ReadonlyArray<StorageCleanupPlanItem>;
}) {
  const tx = useTx();
  const [showAll, setShowAll] = useState(false);
  if (items.length === 0) return null;
  const shown = showAll ? items : items.slice(0, STORAGE_CLEANUP_ROWS_SHOWN);
  return (
    <section aria-label={title} className="space-y-1">
      <h4 className="font-medium text-foreground">
        {title} ({items.length})
      </h4>
      <ul className="divide-y divide-border rounded-md border border-border">
        {shown.map((item) => (
          <StorageCleanupPlanRow key={`${item.kind}:${item.path}`} item={item} />
        ))}
      </ul>
      {items.length > shown.length ? (
        <Button size="xs" variant="outline" onClick={() => setShowAll(true)}>
          {tx("Show all")} ({items.length})
        </Button>
      ) : null}
    </section>
  );
}

function StorageCleanupPlanRow({ item }: { item: StorageCleanupPlanItem }) {
  const tx = useTx();
  const downloads = item.kind === "interrupted-downloads";
  const name = downloads
    ? tx("Leftover files of stopped downloads")
    : storageCleanupFolderLabel(item.path);
  // A removed download row already says what it is in its name.
  const reason =
    downloads && item.reason === "interrupted-downloads"
      ? item.detail
      : describeStorageCleanupReason(item, tx);
  return (
    <li
      className="flex min-w-0 items-start justify-between gap-3 px-2.5 py-1.5"
      data-path={item.path}
    >
      <div className="min-w-0 space-y-0.5">
        <p className="min-w-0 truncate text-foreground">
          {name}
          {downloads ? (
            <span className="text-muted-foreground"> {storageCleanupFolderLabel(item.path)}</span>
          ) : null}
        </p>
        {item.threadTitle === null ? null : (
          <p className="min-w-0 truncate text-muted-foreground">{item.threadTitle}</p>
        )}
        {reason === null ? null : (
          <p className="text-muted-foreground" data-reason={item.reason}>
            {reason}
          </p>
        )}
      </div>
      {item.bytes === null ? null : (
        <span className="shrink-0 text-muted-foreground tabular-nums">
          {formatStorageFreeSpace(item.bytes)}
        </span>
      )}
    </li>
  );
}
