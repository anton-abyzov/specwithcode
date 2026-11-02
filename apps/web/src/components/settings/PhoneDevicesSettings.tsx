import { findErrorTraceId } from "@specweave-studio/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@specweave-studio/client-runtime/state/runtime";
import type { RelayPhoneRecord } from "@specweave-studio/contracts/relay";
import { useEffect, useState } from "react";

import { removeManagedRelayPhoneCommand, useManagedRelayPhones } from "~/cloud/managedRelayState";
import { useAtomCommand } from "~/state/use-atom-command";
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
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import {
  phoneDetail,
  phoneTitle,
  removedPhoneToast,
  removePhoneDialogCopy,
  visiblePhones,
} from "./PhoneDevices.logic";
import { SettingsRow } from "./settingsLayout";

/**
 * The phones signed in to this SpecWithCode Connect account, each removable.
 * A removed phone is signed out and stays cut off until it signs in again.
 * Rows inside "Your phones", shown only while this window is signed in to Connect.
 */
export function PhoneDevicesSettings() {
  const phonesState = useManagedRelayPhones();
  const removePhone = useAtomCommand(removeManagedRelayPhoneCommand, { reportFailure: false });
  const [confirming, setConfirming] = useState<RelayPhoneRecord | null>(null);
  const [removingDeviceId, setRemovingDeviceId] = useState<string | null>(null);
  const [removed, setRemoved] = useState<{
    readonly accountId: string | null;
    readonly deviceIds: ReadonlySet<string>;
  }>({ accountId: null, deviceIds: new Set() });
  // "Last seen" labels move on while the page stays open.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  if (!phonesState.accountId) return null;
  const accountId = phonesState.accountId;
  const removedDeviceIds = removed.accountId === accountId ? removed.deviceIds : new Set<string>();
  const phones = visiblePhones(phonesState.data ?? [], removedDeviceIds);

  const handleRemove = async (phone: RelayPhoneRecord) => {
    if (removingDeviceId !== null) return;
    setRemovingDeviceId(phone.deviceId);
    const result = await removePhone({ accountId, deviceId: phone.deviceId });
    setRemovingDeviceId(null);

    if (result._tag === "Success") {
      setConfirming(null);
      setRemoved((current) => ({
        accountId,
        deviceIds: new Set([
          ...(current.accountId === accountId ? current.deviceIds : []),
          phone.deviceId,
        ]),
      }));
      phonesState.refresh();
      toastManager.add({ type: "success", ...removedPhoneToast(phone, result.value) });
      return;
    }
    if (isAtomCommandInterrupted(result)) return;

    const cause = squashAtomCommandFailure(result);
    const message = cause instanceof Error ? cause.message : "Could not remove the phone.";
    const traceId = findErrorTraceId(cause);
    console.error("[studio-connect] Could not remove phone", {
      deviceId: phone.deviceId,
      message,
      traceId,
    });
    toastManager.add({
      type: "error",
      title: "Could not remove phone",
      description: message,
      data: traceId
        ? {
            secondaryActionProps: {
              children: "Copy trace ID",
              onClick: () => void navigator.clipboard?.writeText(traceId),
            },
          }
        : undefined,
    });
  };

  const rows = (() => {
    if (phonesState.data === null) {
      return phonesState.error ? (
        <SettingsRow
          title="Could not load your phones"
          description="Try again in a moment."
          status={phonesState.error}
          control={
            <Button size="sm" variant="outline" onClick={phonesState.refresh}>
              Try again
            </Button>
          }
        />
      ) : (
        <SettingsRow title="Loading your phones" description="One moment." />
      );
    }
    if (phones.length === 0) {
      return (
        <SettingsRow
          title="No phones yet"
          description="Sign in on the iPhone app with this account and it shows here."
        />
      );
    }
    return phones.map((phone) => (
      <SettingsRow
        key={phone.deviceId}
        title={
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate">{phoneTitle(phone)}</span>
            {phone.current ? (
              <Badge variant="secondary" size="sm">
                This phone
              </Badge>
            ) : null}
          </span>
        }
        description={phoneDetail(phone, nowMs)}
        control={
          <Button
            size="sm"
            variant="outline"
            disabled={removingDeviceId !== null}
            onClick={() => setConfirming(phone)}
          >
            Remove
          </Button>
        }
      />
    ));
  })();

  const dialogCopy = confirming ? removePhoneDialogCopy(confirming) : null;
  const pending = confirming !== null && removingDeviceId === confirming.deviceId;

  return (
    <>
      {rows}
      <AlertDialog
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open && !pending) setConfirming(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>{dialogCopy?.title}</AlertDialogTitle>
            <AlertDialogDescription>{dialogCopy?.description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose disabled={pending} render={<Button variant="outline" />}>
              Cancel
            </AlertDialogClose>
            <Button
              variant="destructive"
              disabled={pending}
              onClick={() => {
                if (confirming) void handleRemove(confirming);
              }}
            >
              {pending ? <Spinner size="sm" /> : null}
              {pending ? "Removing…" : "Remove phone"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
