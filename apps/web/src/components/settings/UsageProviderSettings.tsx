import type { EnvironmentId, LocalUsageHub, UnifiedSettings } from "@specweave-studio/contracts";
import { useAtomValue } from "@effect/atom-react";
import { PlusIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { AddUsageLimitSourceDialog } from "./AddUsageLimitSourceDialog";
import { searchableSetting } from "./settingsSearch";
import { SettingsRow, SettingsSection } from "./settingsLayout";

/** Hub management follows the selected device and access rules of provider settings. */
export function UsageProviderSettings({
  environmentId,
  environmentLabel,
  sources,
  cursorKeychainUsageEnabled,
  readOnly,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly sources: UnifiedSettings["usageLimitSources"];
  readonly cursorKeychainUsageEnabled: boolean;
  readonly readOnly: boolean;
}) {
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const updateCursorSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "update Cursor account usage",
  });
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const platform = useAtomValue(serverEnvironment.configValueAtom(environmentId))?.environment
    .platform;
  const detectHubs = useAtomCommand(serverEnvironment.detectLocalUsageHubs, {
    reportFailure: false,
  });
  const adoptHub = useAtomCommand(serverEnvironment.adoptLocalUsageHub, {
    label: "add the CLI Proxy on this machine",
  });
  const [adding, setAdding] = useState<false | { readonly url: string }>(false);
  const [localHubs, setLocalHubs] = useState<ReadonlyArray<LocalUsageHub>>([]);
  const [adopting, setAdopting] = useState(false);
  const sourceIds = Object.keys(sources).join("\n");
  // Looked for again whenever the hub list changes, so a removed hub is offered back.
  useEffect(() => {
    if (readOnly) return;
    let current = true;
    void detectHubs({ environmentId, input: {} }).then((result) => {
      if (current && result._tag === "Success") setLocalHubs(result.value.hubs);
    });
    return () => {
      current = false;
    };
  }, [detectHubs, environmentId, readOnly, sourceIds]);
  const offered = readOnly
    ? []
    : localHubs.filter((hub) => !(hub.sourceId && hub.sourceId in sources));
  const stopped = new Set(
    localHubs.flatMap((hub) => (hub.sourceId && !hub.running ? [hub.sourceId as string] : [])),
  );
  const adopt = async (hub: LocalUsageHub) => {
    setAdopting(true);
    try {
      const result = await adoptHub({ environmentId, input: { id: hub.id } });
      if (result._tag === "Success") setLocalHubs(result.value.hubs);
    } finally {
      setAdopting(false);
    }
  };
  const [updatingCursor, setUpdatingCursor] = useState(false);
  const entries = Object.entries(sources);

  const setCursorUsageEnabled = async (enabled: boolean) => {
    setUpdatingCursor(true);
    try {
      const result = await updateCursorSettings({
        environmentId,
        input: { patch: { cursorKeychainUsageEnabled: enabled } },
      });
      if (result._tag === "Success") {
        await refreshProviders({ environmentId, input: {} });
      }
    } finally {
      setUpdatingCursor(false);
    }
  };

  return (
    <>
      <SettingsSection
        {...searchableSetting("usage-providers")}
        headerAction={
          !readOnly ? (
            <Button size="xs" variant="outline" onClick={() => setAdding({ url: "" })}>
              <PlusIcon className="size-3" aria-hidden />
              Add hub
            </Button>
          ) : null
        }
      >
        {platform?.os === "darwin" ? (
          <SettingsRow
            id="cursor-keychain-usage"
            title="Cursor account usage"
            description="Read your existing Cursor CLI login from macOS Keychain to show account history and monthly limits. macOS may ask you to allow access."
            control={
              <Switch
                aria-label="Cursor account usage"
                checked={cursorKeychainUsageEnabled}
                disabled={readOnly || updatingCursor}
                onCheckedChange={(enabled) => void setCursorUsageEnabled(enabled)}
              />
            }
          />
        ) : null}
        {offered.map((hub) => (
          <SettingsRow
            key={hub.id}
            id={`local-usage-hub-${hub.id}`}
            title={`CLI Proxy found on ${environmentLabel}`}
            description={
              <span className="break-all">
                {hub.url} · {hub.running ? "Running" : "Not running"} · {hub.configPath}
                {hub.keyAvailable
                  ? ". Adding it reads the management key on that machine; the key never reaches this browser."
                  : ". Its management key is not stored beside it, so paste the key to add it."}
              </span>
            }
            control={
              hub.keyAvailable ? (
                <Button size="xs" disabled={adopting} onClick={() => void adopt(hub)}>
                  Add this hub
                </Button>
              ) : (
                <Button size="xs" variant="outline" onClick={() => setAdding({ url: hub.url })}>
                  Add with key
                </Button>
              )
            }
          />
        ))}
        {entries.length === 0 ? (
          offered.length === 0 ? (
            <SettingsRow title="No hubs configured." />
          ) : null
        ) : (
          entries.map(([id, source]) => {
            const label = source.label?.trim() || source.url;
            return (
              <SettingsRow
                key={id}
                title={label}
                description={
                  <span className="break-all">
                    CLI Proxy{source.enabled ? "" : " · Disabled"}
                    {stopped.has(id) ? " · Not running" : ""}
                    {label !== source.url ? ` · ${source.url}` : ""}
                  </span>
                }
                control={
                  !readOnly ? (
                    <RemoveUsageProviderButton
                      label={label}
                      onConfirm={() => updateSettings({ usageLimitSources: { [id]: null } })}
                    />
                  ) : null
                }
              />
            );
          })
        )}
      </SettingsSection>
      {adding && !readOnly ? (
        <AddUsageLimitSourceDialog
          open
          onOpenChange={(open) => setAdding(open ? adding : false)}
          environmentId={environmentId}
          environmentLabel={environmentLabel}
          initialUrl={adding.url}
        />
      ) : null}
    </>
  );
}

/** Removing a hub deletes its stored management key, so it requires confirmation. */
function RemoveUsageProviderButton({
  label,
  onConfirm,
}: {
  readonly label: string;
  readonly onConfirm: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="xs" variant="ghost" onClick={() => setOpen(true)}>
        Remove
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {label}?</AlertDialogTitle>
            <AlertDialogDescription>
              The hub's management key is deleted from this server. Its accounts leave the Limits
              view; the hub itself is untouched. Add it again with the URL and key to bring them
              back.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                setOpen(false);
                onConfirm();
              }}
            >
              Remove hub
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
