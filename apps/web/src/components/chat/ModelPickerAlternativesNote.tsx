import { renderRich } from "../../i18n/rich";
import { useTx } from "../../i18n";
import type { ProviderInstanceId } from "@specweave-studio/contracts";

import type { ProviderQuickSetup } from "~/hooks/useProviderQuickSetup";
import type { ProviderInstanceEntry } from "../../providerInstances";
import { InlineButton } from "../ui/button";
import { getProviderStatusMessage } from "./ProviderStatusBanner";

/** Why the chosen provider can't run on this machine, in one plain sentence. */
export function unavailableReason(
  entry: ProviderInstanceEntry,
  machine: string,
  installable: boolean,
): string {
  if (installable) return `${entry.displayName} isn't installed on ${machine} yet.`;
  if (entry.snapshot.auth.status === "unauthenticated")
    return `${entry.displayName} is installed on ${machine} but not signed in.`;
  return getProviderStatusMessage(entry.snapshot);
}

/**
 * Over the list when the chosen provider can't run here: why, how to fix it
 * here in one click, where it already runs, and that the list below is a
 * different provider. Picking one of those is an explicit switch, never a
 * silent one.
 */
export function ModelPickerAlternativesNote(props: {
  readonly entry: ProviderInstanceEntry;
  readonly hasReady: boolean;
  readonly quickSetup?: ProviderQuickSetup | undefined;
  readonly onRequestClose?: (() => void) | undefined;
  readonly onOpenProviderSetup?: ((instanceId: ProviderInstanceId) => void) | undefined;
}) {
  const tx = useTx();
  const { entry, quickSetup } = props;
  const machine = quickSetup?.machineLabel ?? "this machine";
  const installable = quickSetup?.installable.has(entry.instanceId) === true;
  const installing = quickSetup?.pending.has(entry.instanceId) === true;
  const error = quickSetup?.errors.get(entry.instanceId);
  const readyOn = quickSetup?.readyOn?.(entry) ?? [];
  const openSetup = props.onOpenProviderSetup
    ? () => {
        props.onRequestClose?.();
        props.onOpenProviderSetup?.(entry.instanceId);
      }
    : undefined;
  return (
    <div
      className="shrink-0 border-b border-border/70 px-3 py-2 text-xs leading-snug"
      role="note"
      data-model-picker-alternatives={entry.instanceId}
    >
      <p className="text-foreground" data-model-picker-unavailable-reason="">
        {unavailableReason(entry, machine, installable)}
      </p>
      {readyOn.length > 0 ? (
        <p className="mt-0.5 text-muted-foreground" data-model-picker-ready-on="">
          {renderRich(tx("Ready on {value}. Accounts and sign-ins are per machine."), {
            value: readyOn.join(", "),
          })}
        </p>
      ) : null}
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
        {installable && quickSetup ? (
          <InlineButton
            data-model-picker-install={entry.instanceId}
            disabled={installing || !quickSetup.canManage}
            onClick={() => quickSetup.install(entry.instanceId)}
          >
            {installing
              ? `Installing on ${machine}…`
              : error
                ? tx("Retry install")
                : `Install ${entry.displayName} on ${machine}`}
          </InlineButton>
        ) : null}
        {openSetup ? (
          <InlineButton data-model-picker-open-setup={entry.instanceId} onClick={openSetup}>
            {installable ? tx("Provider setup") : `Set up ${entry.displayName}`}
          </InlineButton>
        ) : null}
      </div>
      {installable && quickSetup && !quickSetup.canManage ? (
        <p className="mt-1 text-muted-foreground">
          {renderRich(tx("Only the owner of {machine} can install providers there."), {
            machine: machine,
          })}
        </p>
      ) : null}
      {error ? (
        <p role="status" className="mt-1 text-destructive-foreground">
          {error}
        </p>
      ) : null}
      <p
        className="mt-2 text-2xs font-medium text-muted-foreground"
        data-model-picker-ready-heading=""
      >
        {props.hasReady
          ? tx("Ready now instead. Picking one switches this chat to that provider.")
          : tx("No other provider is ready here.")}
      </p>
    </div>
  );
}
