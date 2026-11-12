import { AuthAccessWriteScope, type EnvironmentId } from "@specweave-studio/contracts";
import { useState } from "react";

import { useTx } from "../../i18n";
import { usePrimaryEnvironment } from "../../state/environments";
import { useEnvironmentAcceptsBrowserSignIn, useEnvironmentScope } from "../../state/session";
import { SignInAnotherDeviceDialog } from "../account/SignInAnotherDeviceDialog";
import { Button } from "../ui/button";

/** Where the account menu's "Add a device or machine" lands in Settings > Machines. */
export const ADD_DEVICE_OR_MACHINE_ANCHOR = "machines-join-card";

/**
 * Whether Settings > Machines offers the code path for `environmentId`: only
 * for the machine this window is served from, and only when this window may
 * approve a device there.
 */
export function useCanAddDeviceWithCode(environmentId: EnvironmentId | null): boolean {
  const primary = usePrimaryEnvironment();
  const canApprove = useEnvironmentScope(primary?.environmentId ?? null, AuthAccessWriteScope);
  return canApprove && primary !== null && primary.environmentId === environmentId;
}

/**
 * "Add a device with a code" inside "Another account, or no Connect": a phone
 * or another computer opens this machine's own address, asks to sign in, and
 * the owner types its code here. It never goes through SpecWithCode Connect,
 * which is why it is the way in when Connect is off or cannot be reached.
 */
export function AddDeviceWithCodeRow() {
  const primary = usePrimaryEnvironment();
  const acceptsBrowsers = useEnvironmentAcceptsBrowserSignIn(primary?.environmentId ?? null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <AddDeviceWithCodeRowView onOpen={() => setOpen(true)} />
      <SignInAnotherDeviceDialog
        acceptsBrowsers={acceptsBrowsers}
        open={open}
        onOpenChange={setOpen}
      />
    </>
  );
}

export function AddDeviceWithCodeRowView({ onOpen }: { readonly onOpen: () => void }) {
  const tx = useTx();
  return (
    <div
      id="private-machines-device-code"
      tabIndex={-1}
      className="flex min-w-0 flex-col gap-2 border-t border-border/60 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between sm:gap-4 sm:px-4"
    >
      <span className="min-w-0">
        <span className="block text-sm">{tx("Add a device with a code")}</span>
        <span className="block text-xs text-muted-foreground">
          {tx(
            "Use this machine from a phone or another computer when SpecWithCode Connect is off or cannot be reached. With Connect, sign in on the other device with the same account instead; no code is needed.",
          )}
        </span>
      </span>
      <Button
        className="shrink-0 self-start sm:self-auto"
        size="xs"
        variant="outline"
        onClick={onOpen}
      >
        {tx("Add a device")}
      </Button>
    </div>
  );
}
