import {
  AuthSettingsWriteScope,
  ProviderDriverKind,
  type EnvironmentId,
  type UsageProviderKind,
} from "@specweave-studio/contracts";
import { useState } from "react";

import { useTx } from "../../i18n";
import { serverEnvironment } from "../../state/server";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button, InlineButton } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { PROVIDER_PRESENTATION } from "./usageProviders";

const CURSOR_USAGE_COPY = "Reads your Cursor sign-in on this machine.";

/**
 * The one warning shown wherever Cursor account usage is turned on. Cursor has
 * no public usage API, and its staff say reading the sign-in to call its
 * private endpoints breaks its terms, so the person decides each time it goes on.
 */
export function CursorUsageWarningDialog({
  open,
  onOpenChange,
  onConfirm,
  pending = false,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onConfirm: () => void;
  readonly pending?: boolean;
}) {
  const tx = useTx();
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>{tx("Turn on Cursor account usage?")}</AlertDialogTitle>
          <AlertDialogDescription>
            {tx(
              "Cursor has no public usage API. The app reads your Cursor sign-in and calls Cursor's private endpoints, which Cursor says breaks its terms and can get your account banned.",
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" />}>{tx("Cancel")}</AlertDialogClose>
          <Button
            disabled={pending}
            onClick={() => {
              onOpenChange(false);
              onConfirm();
            }}
          >
            {tx("Turn on")}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}

function CursorEnableButton({
  environmentId,
  label,
  onEnabled,
  tooltip,
  buttonText = "Enable",
}: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly onEnabled: () => void;
  readonly tooltip: boolean;
  readonly buttonText?: string;
}) {
  const canEnable = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "enable Cursor account usage",
  });
  const [pending, setPending] = useState(false);
  const [warning, setWarning] = useState(false);
  const enable = async () => {
    if (!readEnvironmentScope(environmentId, AuthSettingsWriteScope)) return;
    setPending(true);
    try {
      const result = await updateSettings({
        environmentId,
        input: { patch: { cursorKeychainUsageEnabled: true } },
      });
      if (result._tag === "Success") onEnabled();
    } finally {
      setPending(false);
    }
  };
  if (!canEnable) return null;
  const button = tooltip ? (
    <InlineButton
      disabled={pending}
      aria-busy={pending}
      aria-label={`Enable Cursor usage from ${label}`}
      onClick={() => setWarning(true)}
    >
      {buttonText}
    </InlineButton>
  ) : (
    <Button
      size="sm"
      variant="outline"
      disabled={pending}
      aria-busy={pending}
      aria-label={`Enable Cursor usage from ${label}`}
      onClick={() => setWarning(true)}
    >
      {buttonText}
    </Button>
  );
  return (
    <>
      {tooltip ? (
        <Tooltip>
          <TooltipTrigger render={button} />
          <TooltipPopup>{CURSOR_USAGE_COPY}</TooltipPopup>
        </Tooltip>
      ) : (
        button
      )}
      <CursorUsageWarningDialog
        open={warning}
        onOpenChange={setWarning}
        onConfirm={() => void enable()}
        pending={pending}
      />
    </>
  );
}

export function CursorEnableRow({
  environmentId,
  label,
  showEnvironment,
  onEnabled,
}: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly showEnvironment: boolean;
  readonly onEnabled: () => void;
}) {
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-4 text-sm">
      <span className="flex min-w-0 items-center gap-2 text-sm text-foreground">
        <span
          aria-hidden
          className="size-2 shrink-0 rounded-full"
          style={{ backgroundColor: PROVIDER_PRESENTATION.cursor.color }}
        />
        <ProviderMark provider="cursor" className="size-4" />
        <span className="truncate">Cursor{showEnvironment ? ` · ${label}` : ""}</span>
      </span>
      <CursorEnableButton
        environmentId={environmentId}
        label={label}
        onEnabled={onEnabled}
        tooltip
      />
    </div>
  );
}

export function CursorEnableLimits({
  environments,
  onEnabled,
}: {
  readonly environments: readonly {
    readonly environmentId: EnvironmentId;
    readonly label: string;
  }[];
  readonly onEnabled: () => void;
}) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="flex items-center gap-2 text-sm font-medium text-foreground">
        <ProviderInstanceIcon
          driverKind={ProviderDriverKind.make("cursor")}
          displayName="Cursor"
          indicatorBackground="var(--background)"
          className="size-5"
          iconClassName="size-4 text-foreground/80"
        />
        Cursor
      </h2>
      <div className="flex flex-col items-start gap-3 rounded-lg border border-border/60 p-4">
        <p className="text-xs text-muted-foreground">{CURSOR_USAGE_COPY}</p>
        <div className="flex flex-wrap gap-2">
          {environments.map((environment) => (
            <CursorEnableButton
              key={environment.environmentId}
              environmentId={environment.environmentId}
              label={environment.label}
              buttonText={environments.length > 1 ? `Enable on ${environment.label}` : "Enable"}
              onEnabled={onEnabled}
              tooltip={false}
            />
          ))}
        </div>
      </div>
    </section>
  );
}

/** Brand mark for the harness a row belongs to. */
export function ProviderMark({
  provider,
  className,
}: {
  readonly provider: UsageProviderKind;
  readonly className: string;
}) {
  const presentation = PROVIDER_PRESENTATION[provider];
  return (
    <ProviderInstanceIcon
      driverKind={presentation.driverKind}
      displayName={presentation.label}
      iconClassName={className}
    />
  );
}
