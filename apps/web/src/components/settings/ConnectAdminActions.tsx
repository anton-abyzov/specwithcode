import type {
  RelayAdminAccount,
  RelayAdminAction,
  RelayAdminMachine,
  RelayAdminPhone,
} from "@specweave-studio/contracts/relayAdmin";
import { useEffect, useRef, useState } from "react";

import { type ConnectAdminFailure, readConnectAdmin } from "~/cloud/connectAdminState";
import { useTx } from "../../i18n";
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
import { Input } from "../ui/input";
import { Radio, RadioGroup } from "../ui/radio-group";
import {
  accountTitle,
  actionOutcome,
  actionText,
  changeFailureCopy,
  formatAdminTime,
  MACHINE_LIMIT_MAX,
  type MachineLimitDraft,
  machineLimitDraftOf,
  machineLimitSettingOf,
  machineLimitText,
} from "./ConnectAdminSettings.logic";

const MUTED = "text-xs leading-normal text-muted-foreground";

/** One change an owner is about to confirm, with the account it is for. */
export type ConnectAdminChange =
  | { readonly kind: "limit"; readonly account: RelayAdminAccount }
  | {
      readonly kind: "unlink";
      readonly account: RelayAdminAccount;
      readonly machine: RelayAdminMachine;
    }
  | {
      readonly kind: "remove-phone";
      readonly account: RelayAdminAccount;
      readonly phone: RelayAdminPhone;
    };

function changeKey(change: ConnectAdminChange): string {
  const target =
    change.kind === "unlink"
      ? change.machine.environmentId
      : change.kind === "remove-phone"
        ? change.phone.deviceId
        : "";
  return `${change.kind}:${change.account.userId}:${target}`;
}

function ChangeForm({
  change,
  sending,
  onSendingChange,
  onSettled,
  onClose,
}: {
  readonly change: ConnectAdminChange;
  readonly sending: boolean;
  readonly onSendingChange: (sending: boolean) => void;
  readonly onSettled: (change: ConnectAdminChange) => void;
  readonly onClose: () => void;
}) {
  const tx = useTx();
  const [draft, setDraft] = useState<MachineLimitDraft>(() =>
    machineLimitDraftOf(change.account.limit),
  );
  const [failure, setFailure] = useState<ConnectAdminFailure | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const account = accountTitle(change.account);
  const userId = change.account.userId;
  const setting = change.kind === "limit" ? machineLimitSettingOf(draft) : null;
  const ready = change.kind !== "limit" || setting !== null;

  const send = () => {
    if (sending || !ready) return;
    onSendingChange(true);
    setFailure(null);
    void readConnectAdmin<unknown>((client, clerkToken) => {
      if (change.kind === "unlink") {
        return client.unlinkMachine({
          clerkToken,
          userId,
          environmentId: change.machine.environmentId,
        });
      }
      if (change.kind === "remove-phone") {
        return client.removePhone({ clerkToken, userId, deviceId: change.phone.deviceId });
      }
      return client.setMachineLimit({ clerkToken, userId, limit: setting ?? { kind: "default" } });
    }).then((result) => {
      onSendingChange(false);
      // Whatever the answer, the page reads the account and the record again.
      onSettled(change);
      if (!mounted.current) return;
      if (result.ok) onClose();
      else setFailure(result.failure);
    });
  };

  const title =
    change.kind === "limit"
      ? tx("Machine limit for {account}", { account })
      : change.kind === "unlink"
        ? tx("Unlink “{machine}” from {account}?", { machine: change.machine.label, account })
        : tx("Remove “{phone}” from {account}?", { phone: change.phone.label, account });
  const description =
    change.kind === "limit"
      ? tx("It applies to the account's next link. Machines already linked stay linked.")
      : change.kind === "unlink"
        ? tx(
            "The machine loses its Connect link, its credentials and its tunnel. The account can link it again from that machine.",
          )
        : tx(
            "The phone is signed out of SpecWithCode Connect, and the account's machines stop accepting its keys.",
          );
  const confirm =
    change.kind === "limit"
      ? sending
        ? tx("Saving…")
        : tx("Save")
      : change.kind === "unlink"
        ? sending
          ? tx("Unlinking…")
          : tx("Unlink machine")
        : sending
          ? tx("Removing…")
          : tx("Remove phone");
  const copy = failure === null ? null : changeFailureCopy(failure);

  return (
    <>
      <AlertDialogHeader>
        <AlertDialogTitle>{title}</AlertDialogTitle>
        <AlertDialogDescription>{description}</AlertDialogDescription>
        <p className={`${MUTED} break-all`}>{tx("Account id: {id}", { id: userId })}</p>
        {change.kind === "limit" ? (
          <div className="space-y-3 pt-1">
            <p className={MUTED}>
              {tx("Now: {limit}", { limit: machineLimitText(tx, change.account.limit) })}
            </p>
            <RadioGroup
              aria-label={tx("Machine limit")}
              value={draft.choice}
              disabled={sending}
              onValueChange={(choice) =>
                setDraft((current) => ({
                  ...current,
                  choice: choice as MachineLimitDraft["choice"],
                }))
              }
            >
              <label className="flex items-center gap-2 text-sm">
                <Radio value="default" />
                {tx("Plan default")}
              </label>
              <label className="flex items-center gap-2 text-sm">
                <Radio value="unlimited" />
                {tx("No limit")}
              </label>
              <label className="flex items-center gap-2 text-sm">
                <Radio value="limited" />
                {tx("This many machines")}
              </label>
            </RadioGroup>
            {draft.choice === "limited" ? (
              <div className="space-y-1">
                <Input
                  className="w-28"
                  size="sm"
                  inputMode="numeric"
                  autoComplete="off"
                  aria-label={tx("Number of machines")}
                  aria-invalid={setting === null}
                  disabled={sending}
                  value={draft.count}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, count: event.target.value }))
                  }
                />
                {setting === null ? (
                  <p className={MUTED}>
                    {tx("Enter a whole number from 0 to {max}.", { max: MACHINE_LIMIT_MAX })}
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
        <p className={MUTED}>{tx("The change is recorded with your account id.")}</p>
        {copy !== null && failure !== null ? (
          <div className="space-y-1" role="alert">
            <p className="text-sm font-medium text-destructive-foreground">{tx(copy.title)}</p>
            <p className={MUTED}>{tx(copy.description)}</p>
            {failure.status !== null || failure.traceId !== null ? (
              <p className={`${MUTED} font-mono break-all`}>
                {[
                  failure.status !== null ? `HTTP ${failure.status}` : null,
                  failure.traceId !== null ? `trace ${failure.traceId}` : null,
                ]
                  .filter((part) => part !== null)
                  .join(" · ")}
              </p>
            ) : null}
          </div>
        ) : null}
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogClose disabled={sending} render={<Button variant="outline" />}>
          {tx("Cancel")}
        </AlertDialogClose>
        <Button
          variant={change.kind === "limit" ? "default" : "destructive"}
          disabled={sending || !ready}
          onClick={send}
        >
          {confirm}
        </Button>
      </AlertDialogFooter>
    </>
  );
}

/**
 * The confirmation for one owner change. It names the account and the machine
 * or phone, sends the change only on the confirm button, and stays open with
 * the reason when the change fails.
 */
export function ConnectAdminChangeDialog({
  change,
  onClose,
  onSettled,
}: {
  readonly change: ConnectAdminChange | null;
  readonly onClose: () => void;
  /** Called after every answer, failed or not: what is on screen may be stale. */
  readonly onSettled: (change: ConnectAdminChange) => void;
}) {
  const [sending, setSending] = useState(false);
  return (
    <AlertDialog
      open={change !== null}
      onOpenChange={(open) => {
        if (!open && !sending) onClose();
      }}
    >
      <AlertDialogPopup>
        {change !== null ? (
          <ChangeForm
            key={changeKey(change)}
            change={change}
            sending={sending}
            onSendingChange={setSending}
            onSettled={onSettled}
            onClose={onClose}
          />
        ) : null}
      </AlertDialogPopup>
    </AlertDialog>
  );
}

/** The recorded owner changes, newest first: what, to which account, by whom, how it ended. */
export function ConnectAdminRecentChanges({
  actions,
  locale,
}: {
  readonly actions: ReadonlyArray<RelayAdminAction>;
  readonly locale: string | undefined;
}) {
  const tx = useTx();
  return (
    <ul className="divide-y divide-border/50 px-3 sm:px-4">
      {actions.map((action) => {
        const outcome = actionOutcome(action);
        return (
          <li key={action.id} className="space-y-1 py-2.5" data-testid="connect-admin-change">
            <div className="flex flex-wrap items-center gap-2">
              <span className="min-w-0 text-sm break-words text-foreground">
                {actionText(tx, action)}
              </span>
              <Badge variant={outcome.tone} size="sm">
                {tx(outcome.phrase)}
              </Badge>
            </div>
            <p className={`${MUTED} break-all`}>
              {[
                formatAdminTime(action.createdAt, locale),
                tx("Account {id}", { id: action.targetUserId }),
                tx("By {id}", { id: action.ownerUserId }),
              ].join(" · ")}
            </p>
          </li>
        );
      })}
    </ul>
  );
}
