import { folderCopyLanGateOpen, type EnvironmentId } from "@specweave-studio/contracts";
import { useState } from "react";

import { useEnvironment } from "../../state/environments";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { useTx } from "../../i18n";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Switch } from "../ui/switch";
import { SettingsRow } from "./settingsLayout";

const TITLE = "Copy folders over your local network";
/** What turning it on means, the three accepted risks included. */
export const FOLDER_COPY_LAN_HELP = [
  "When both machines have this on and sit on the same private network, Sync and Add send file contents straight between them. Everything else, secrets included, still goes through Connect.",
  "The other machine learns this machine's private network addresses.",
  "Others on the network can see that a temporary encrypted connection exists and how much it carries.",
  "A firewall prompt or an isolated network can block the direct route. The copy then runs through Connect at Connect speed. Refusing the prompt changes no firewall rule and stops no copy.",
] as const;

/** The server reports "windows"; the gate is recorded per Node platform name. */
const gatePlatform = (os: string | undefined) => (os === "windows" ? "win32" : (os ?? ""));

export function FolderCopyLanSettingsView(props: {
  /** The review gate for that machine's operating system: closed hides the setting. */
  readonly open: boolean;
  readonly checked: boolean;
  readonly disabled?: boolean;
  readonly onChange: (on: boolean) => void;
}) {
  const tx = useTx();
  if (!props.open) return null;
  return (
    <SettingsRow
      title={tx(TITLE)}
      data-slot="folder-copy-lan-setting"
      description={
        <span className="grid gap-1">
          {FOLDER_COPY_LAN_HELP.map((line) => (
            <span key={line}>{tx(line)}</span>
          ))}
        </span>
      }
      control={
        <Switch
          aria-label={tx(TITLE)}
          checked={props.checked}
          disabled={props.disabled ?? false}
          onCheckedChange={props.onChange}
        />
      }
    />
  );
}

/** Settings > Machines: this machine's opt-in to the local-network copy path. Off by default. */
export function FolderCopyLanSettings({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const os = useEnvironment(environmentId)?.serverConfig?.environment.platform.os;
  const checked = useEnvironmentSettings(environmentId, (settings) => settings.folderCopyOverLan);
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "save the local network copy setting",
  });
  const [saving, setSaving] = useState(false);
  return (
    <FolderCopyLanSettingsView
      open={folderCopyLanGateOpen(gatePlatform(os))}
      checked={checked}
      disabled={saving}
      onChange={(folderCopyOverLan) => {
        setSaving(true);
        void updateSettings({ environmentId, input: { patch: { folderCopyOverLan } } }).finally(
          () => setSaving(false),
        );
      }}
    />
  );
}
