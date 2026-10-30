import type { ProviderInstanceId } from "@specweave-studio/contracts";
import type { ReactNode } from "react";
import type { ProviderQuickSetup } from "~/hooks/useProviderQuickSetup";
import { turnOnOutcome } from "~/providerQuickSetup";
import type { ProviderInstanceEntry } from "../../providerInstances";
import { Button, InlineButton } from "../ui/button";
import { ComboboxEmpty } from "../ui/combobox";
import { Kbd } from "../ui/kbd";
import { machineLabelFor, TurnedOnRow, turnOnStepLabel } from "./ModelPickerTurnedOnRow";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import { getProviderStatusMessage } from "./ProviderStatusBanner";

type QuickSetupElsewhere = ProviderQuickSetup["elsewhere"][number];
type QuickSetupTurnedOn = NonNullable<ProviderQuickSetup["turnedOn"]>[number];

/**
 * Below the list: setup for a provider that can't run here, or "No models found",
 * then providers that are ready on the user's other machines.
 */
export function ModelPickerSetupFooter(props: {
  readonly providerSetupEntries: ReadonlyArray<ProviderInstanceEntry>;
  readonly quickSetup: ProviderQuickSetup | undefined;
  readonly turnedOnProviders: ReadonlyArray<QuickSetupTurnedOn>;
  readonly otherMachineProviders: ReadonlyArray<QuickSetupElsewhere>;
  readonly entryByInstanceId: ReadonlyMap<ProviderInstanceId, ProviderInstanceEntry>;
  readonly onRequestClose: (() => void) | undefined;
  readonly onOpenProviderSetup: ((instanceId: ProviderInstanceId) => void) | undefined;
}) {
  const { providerSetupEntries, quickSetup, turnedOnProviders, otherMachineProviders } = props;
  return (
    <>
      {providerSetupEntries.length > 0 ? (
        <div className="max-h-44 shrink-0 overflow-y-auto border-t border-border/70 p-2">
          {providerSetupEntries.map((entry) => {
            const installing = quickSetup?.pending.has(entry.instanceId) === true;
            const installError = quickSetup?.errors.get(entry.instanceId);
            return (
              <div key={entry.instanceId} className="px-1 py-1.5 text-xs leading-snug">
                <p className="line-clamp-3 text-muted-foreground">
                  {quickSetup?.installable.has(entry.instanceId)
                    ? `${entry.displayName} is not installed on this machine yet.`
                    : getProviderStatusMessage(entry.snapshot)}
                </p>
                {quickSetup?.installable.has(entry.instanceId) ? (
                  <InlineButton
                    className="mt-1"
                    data-model-picker-install={entry.instanceId}
                    disabled={installing || !quickSetup.canManage}
                    onClick={() => quickSetup.install(entry.instanceId)}
                  >
                    {installing ? "Installing…" : `Install ${entry.displayName}`}
                  </InlineButton>
                ) : (
                  <InlineButton
                    className="mt-1"
                    onClick={() => {
                      props.onRequestClose?.();
                      props.onOpenProviderSetup?.(entry.instanceId);
                    }}
                  >
                    {providerSetupEntries.length > 1
                      ? `Set up ${entry.displayName}`
                      : "Open provider setup"}
                  </InlineButton>
                )}
                {installError ? (
                  <p role="status" className="mt-1 text-destructive-foreground">
                    {installError}
                  </p>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : (
        <ComboboxEmpty className="empty:h-0">No models found</ComboboxEmpty>
      )}
      {quickSetup && (otherMachineProviders.length > 0 || turnedOnProviders.length > 0) ? (
        <div
          className="max-h-48 shrink-0 overflow-y-auto border-t border-border/70 p-2"
          data-model-picker-elsewhere="true"
        >
          {turnedOnProviders.length > 0 ? (
            <>
              <p className="px-1 pb-1 text-2xs font-medium text-muted-foreground">
                Turned on {machineLabelFor(quickSetup)}
              </p>
              {turnedOnProviders.map(({ provider, instanceId }) => (
                <TurnedOnRow
                  key={provider.identity}
                  provider={provider}
                  quickSetup={quickSetup}
                  outcome={turnOnOutcome(
                    props.entryByInstanceId.get(instanceId)?.snapshot,
                    quickSetup.machineLabel ?? "this machine",
                    { identity: provider.identity, remote: quickSetup.remote === true },
                  )}
                  onOpenSetup={
                    props.onOpenProviderSetup
                      ? () => {
                          props.onRequestClose?.();
                          props.onOpenProviderSetup?.(instanceId);
                        }
                      : undefined
                  }
                />
              ))}
            </>
          ) : null}
          {otherMachineProviders.length > 0 ? (
            <p className="px-1 pb-1 text-2xs font-medium text-muted-foreground">
              On your other machines
            </p>
          ) : null}
          {otherMachineProviders.map((provider) => {
            const enabling = quickSetup.pending.has(provider.identity);
            const enableError = quickSetup.errors.get(provider.identity);
            return (
              <div key={provider.identity} className="px-1 py-1 text-xs leading-snug">
                <div className="flex items-center gap-2">
                  <ProviderInstanceIcon
                    driverKind={provider.driverKind}
                    displayName={provider.displayName}
                    acpRegistryAgentId={provider.entry.acpRegistryAgentId}
                    acpRegistryIconUrl={provider.entry.acpRegistryIconUrl}
                    className="size-4 shrink-0"
                    iconClassName="size-4"
                  />
                  <span
                    className="min-w-0 flex-1 truncate"
                    title={`Ready on ${provider.machineLabels.join(", ")}. Turn on here installs it ${machineLabelFor(quickSetup)} if needed; sign-ins are not copied.`}
                  >
                    {provider.displayName}
                    <span className="text-muted-foreground">
                      {" "}
                      · ready on {provider.machineLabels.join(", ")}
                    </span>
                  </span>
                  <InlineButton
                    data-model-picker-enable-here={provider.identity}
                    disabled={enabling || !quickSetup.canManage}
                    onClick={() => quickSetup.enableHere(provider)}
                  >
                    {enabling
                      ? turnOnStepLabel(quickSetup.steps?.get(provider.identity))
                      : enableError
                        ? "Retry"
                        : "Turn on here"}
                  </InlineButton>
                </div>
                {enableError ? (
                  <p role="status" className="mt-1 text-destructive-foreground">
                    {enableError}
                  </p>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
    </>
  );
}

/** The picker's last row: provider management, the host's second view, the fallback order. */
export function ModelPickerActions(props: {
  readonly onRequestClose: (() => void) | undefined;
  readonly onManageProviders: (() => void) | undefined;
  readonly secondaryAction: { readonly label: string; readonly onOpen: () => void } | undefined;
  readonly onEditFallbackOrder: (() => void) | undefined;
  /** Key hints for the list; shown on wide pickers only. */
  readonly hints?: ReactNode;
}) {
  const { onManageProviders, secondaryAction, onEditFallbackOrder } = props;
  if (!onManageProviders && !secondaryAction && !onEditFallbackOrder) return null;
  return (
    <div
      className="flex shrink-0 flex-wrap items-center gap-x-1 gap-y-0.5 border-t border-border/70 px-2 py-1.5"
      data-model-picker-actions=""
    >
      {onManageProviders ? (
        <Button
          variant="ghost"
          size="sm"
          className="justify-start"
          onClick={() => {
            props.onRequestClose?.();
            onManageProviders();
          }}
        >
          Add or manage providers
        </Button>
      ) : null}
      {secondaryAction ? (
        <Button
          variant="ghost"
          size="sm"
          className="justify-start"
          data-model-picker-secondary-action=""
          onClick={secondaryAction.onOpen}
        >
          {secondaryAction.label}
        </Button>
      ) : null}
      {onEditFallbackOrder ? (
        <Button
          variant="ghost"
          size="sm"
          className="justify-start"
          data-model-picker-fallback-order=""
          onClick={() => {
            props.onRequestClose?.();
            onEditFallbackOrder();
          }}
        >
          Fallback order
        </Button>
      ) : null}
      {props.hints ? (
        <span className="ms-auto hidden items-center gap-1 text-2xs text-muted-foreground sm:flex">
          {props.hints}
        </span>
      ) : null}
    </div>
  );
}

/** What the list's keys do, in the actions row. */
export function ModelPickerKeyHints(props: { readonly effort: boolean }) {
  return (
    <>
      <Kbd>↑↓</Kbd>
      {props.effort ? <Kbd>←→</Kbd> : null}
      <Kbd>↵</Kbd>
    </>
  );
}
