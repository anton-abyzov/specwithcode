import type { ModEntry, ModPermission, ModStatus } from "@specweave-studio/contracts";
import { AuthSettingsWriteScope } from "@specweave-studio/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@specweave-studio/client-runtime/state/runtime";
import { PuzzleIcon } from "lucide-react";
import { useState } from "react";

import { useModsList, useModsSupport } from "../../mods/ModsHost";
import { useModsStore } from "../../mods/modsStore";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
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
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";

const PERMISSION_COPY: Record<ModPermission, string> = {
  "threads:read": "See session titles, project names and status on this host (never messages)",
  "threads:open": "Open a session, only right after you use the mod",
  "specweave:read":
    "See SpecWeave increment titles, acceptance criteria, task titles and progress in this host's projects (never files, paths or who claimed a task)",
};

const STATUS_COPY: Record<
  ModStatus,
  { label: string; variant: "success" | "warning" | "info" | "error" | "secondary" }
> = {
  approved: { label: "Running", variant: "success" },
  pending: { label: "Needs review", variant: "info" },
  changed: { label: "Changed, paused", variant: "warning" },
  disabled: { label: "Off", variant: "secondary" },
  invalid: { label: "Cannot load", variant: "error" },
};

function ModRow({
  mod,
  canWrite,
  busy,
  onReview,
  onDisable,
}: {
  mod: ModEntry;
  canWrite: boolean;
  busy: boolean;
  onReview: () => void;
  onDisable: () => void;
}) {
  const status = STATUS_COPY[mod.status];
  const runtimeError = useModsStore((state) => state.errors[mod.name]);
  return (
    <div className="flex flex-col gap-2 px-3 py-3 sm:px-4" id={`mod-${mod.name}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate font-medium text-sm">{mod.name}</span>
          {mod.version ? (
            <span className="text-muted-foreground text-xs">{mod.version}</span>
          ) : null}
          <Badge variant={status.variant}>{status.label}</Badge>
        </div>
        {canWrite ? (
          <div className="flex items-center gap-2">
            {mod.status === "pending" || mod.status === "changed" || mod.status === "disabled" ? (
              <Button size="compact" disabled={busy} onClick={onReview}>
                {mod.status === "disabled" ? "Turn on" : "Review and approve"}
              </Button>
            ) : null}
            {mod.status === "approved" ? (
              <Button size="compact" variant="outline" disabled={busy} onClick={onDisable}>
                Turn off
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
      {mod.description ? <p className="text-muted-foreground text-sm">{mod.description}</p> : null}
      {mod.permissions.length > 0 ? (
        <ul className="list-disc pl-5 text-muted-foreground text-xs">
          {mod.permissions.map((permission) => (
            <li key={permission}>{PERMISSION_COPY[permission]}</li>
          ))}
        </ul>
      ) : (
        <p className="text-muted-foreground text-xs">Draws its own commands and panes only.</p>
      )}
      {mod.problems.map((problem) => (
        <p key={problem} className="text-destructive-foreground text-xs">
          {problem}
        </p>
      ))}
      {runtimeError && mod.status === "approved" ? (
        <p className="text-destructive-foreground text-xs">Stopped with an error: {runtimeError}</p>
      ) : null}
    </div>
  );
}

export function ModsSettingsPanel() {
  const environmentId = usePrimaryEnvironmentId();
  const canWrite = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const { data, error, isPending, refresh } = useModsList(environmentId);
  const { support, serverVersion } = useModsSupport(environmentId);
  const approveMod = useAtomCommand(serverEnvironment.approveMod, { reportFailure: false });
  const disableMod = useAtomCommand(serverEnvironment.disableMod, { reportFailure: false });
  const [reviewing, setReviewing] = useState<ModEntry | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const run = async (name: string, action: () => ReturnType<typeof approveMod>) => {
    setBusy(name);
    try {
      const result = await action();
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const failure = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: `Could not update ${name}`,
          description: failure instanceof Error ? failure.message : "The host refused the change.",
        });
      }
    } finally {
      setBusy(null);
      refresh();
    }
  };

  const mods = data?.mods ?? [];
  return (
    <SettingsPageContainer>
      <SettingsSection title="Mods" icon={<PuzzleIcon className="size-4" />} id="mods">
        <div className="flex flex-col gap-1 px-3 py-3 text-muted-foreground text-sm sm:px-4">
          <p>
            Mods add commands, panes and status to the workbench. Each runs in a sandbox with no
            network, files or credentials, and only after you approve its exact contents. Any edit
            pauses it until you approve again.
          </p>
          {data ? (
            <p className="text-xs">
              Folder on this host: <span className="font-mono">{data.modsDir}</span>. Check a mod
              with <span className="font-mono">specweave-studio mods validate &lt;folder&gt;</span>.
            </p>
          ) : null}
        </div>
        {support === "unsupported" ? (
          <p className="px-3 py-3 text-muted-foreground text-sm sm:px-4">
            The SpecWithCode service this app is connected to
            {serverVersion ? ` (version ${serverVersion})` : ""} is older than Mods, so it has no
            mods to show. Update that service to list, approve and run mods.
          </p>
        ) : null}
        {error ? (
          <p className="px-3 py-3 text-destructive-foreground text-sm sm:px-4">{error}</p>
        ) : null}
        {!error && !isPending && data && mods.length === 0 ? (
          <p className="px-3 py-3 text-muted-foreground text-sm sm:px-4">
            No mods on this host yet.
          </p>
        ) : null}
        {mods.map((mod) => (
          <ModRow
            key={mod.name}
            mod={mod}
            canWrite={canWrite && environmentId !== null}
            busy={busy === mod.name}
            onReview={() => setReviewing(mod)}
            onDisable={() => {
              if (environmentId === null) return;
              void run(mod.name, () => disableMod({ environmentId, input: { name: mod.name } }));
            }}
          />
        ))}
      </SettingsSection>
      <AlertDialog
        open={reviewing !== null}
        onOpenChange={(open) => {
          if (!open) setReviewing(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Approve {reviewing?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Read the files in {data?.modsDir ?? "the mods folder"}/{reviewing?.name} first. This
              approves exactly the contents with this fingerprint; the CLI&apos;s validate command
              prints the same one.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="flex flex-col gap-2 px-6 text-sm">
            <span className="break-all font-mono text-xs">{reviewing?.sha256}</span>
            {reviewing && reviewing.permissions.length > 0 ? (
              <ul className="list-disc pl-5">
                {reviewing.permissions.map((permission) => (
                  <li key={permission}>{PERMISSION_COPY[permission]}</li>
                ))}
              </ul>
            ) : (
              <span>It asks for no permissions beyond drawing its own UI.</span>
            )}
            <span className="text-muted-foreground text-xs">
              A mod can never answer approvals, grant folders, choose accounts or start a turn.
            </span>
          </div>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              onClick={() => {
                const mod = reviewing;
                setReviewing(null);
                if (mod === null || environmentId === null || mod.sha256 === undefined) return;
                const sha256 = mod.sha256;
                void run(mod.name, () =>
                  approveMod({ environmentId, input: { name: mod.name, sha256 } }),
                );
              }}
            >
              Approve
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </SettingsPageContainer>
  );
}
