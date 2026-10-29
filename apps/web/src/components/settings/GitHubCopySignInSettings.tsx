import type { EnvironmentId } from "@specweave-studio/contracts";
import { useState } from "react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Switch } from "../ui/switch";

/**
 * This machine's choices for giving another machine GitHub access: offer to copy this
 * machine's sign-in first (a one-time code otherwise), and ask before each copy.
 */
export function GitHubCopySignInSettings({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const github = useEnvironmentSettings(environmentId, (settings) => settings.github);
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "save GitHub sign-in copy settings",
  });
  const [saving, setSaving] = useState(false);
  const save = async (patch: { copyHostSignIn?: boolean; confirmCopySignIn?: boolean }) => {
    setSaving(true);
    try {
      await updateSettings({ environmentId, input: { patch: { github: patch } } });
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="grid gap-3" data-slot="github-copy-sign-in-settings">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 space-y-0.5">
          <span className="text-xs font-medium text-foreground">
            When adding a machine, copy this machine's GitHub sign-in
          </span>
          <p className="text-xs text-muted-foreground">
            The token goes to that machine's secret store over the tailnet and is used by
            SpecWithCode only. Off: a one-time code is offered first.
          </p>
        </div>
        <Switch
          checked={github.copyHostSignIn}
          disabled={saving}
          aria-label="When adding a machine, copy this machine's GitHub sign-in"
          onCheckedChange={(checked) => void save({ copyHostSignIn: checked })}
        />
      </div>
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs text-muted-foreground">Ask before copying</span>
        <Switch
          checked={github.confirmCopySignIn}
          disabled={saving}
          aria-label="Ask before copying this machine's GitHub sign-in"
          onCheckedChange={(checked) => void save({ confirmCopySignIn: checked })}
        />
      </div>
    </div>
  );
}
