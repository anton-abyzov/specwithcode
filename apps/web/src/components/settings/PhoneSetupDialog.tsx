import { useTx } from "../../i18n";
import type { ReactNode } from "react";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { QRCodeSvg } from "../ui/qr-code";
import { describePhoneNetworkHint, type PhonePairingAddress } from "./PairPhone.logic";

export type PhoneSetupCode =
  | { readonly status: "ready"; readonly url: string; readonly expiresAt: string }
  | { readonly status: "expired" | "route-changed" };

/**
 * Pairing a phone over the person's own network, for when SpecWithCode Connect
 * cannot be used. It opens straight at the steps: what the phone needs to
 * reach this computer, then a one-time code. While this computer has no
 * address a phone can reach, it names what to turn on and offers the button.
 */
export function PhoneSetupDialog(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly address: PhonePairingAddress | null;
  readonly code: PhoneSetupCode | null;
  readonly canPair: boolean;
  readonly isCreating: boolean;
  readonly error: string | null;
  /** This window shows the Network access and Tailscale HTTPS switches (the desktop app). */
  readonly hasAccessControls: boolean;
  /** Goes to the Network access and Tailscale HTTPS switches. */
  readonly onShowAccessSettings: () => void;
  /** Turns Network access on from here. Without it the dialog only shows where the switch is. */
  readonly onTurnOnNetworkAccess?: (() => void) | undefined;
  readonly onGenerate: () => void;
  readonly onCopyAddress: () => void;
  readonly onCopyCode: () => void;
}) {
  const tx = useTx();
  const { address, code } = props;
  const showAccessSetup = props.hasAccessControls && address === null;
  const showPairing = address !== null && props.canPair;
  let instructions: ReactNode;
  if (address === null) {
    instructions = props.hasAccessControls ? (
      <>
        <p>{tx("Your phone needs an address for this computer. Turn on one of these first:")}</p>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          <li>{tx("Network access, for a phone on the same Wi-Fi or network.")}</li>
          <li>{tx("Tailscale HTTPS, for a phone on your Tailscale network, anywhere.")}</li>
        </ul>
      </>
    ) : (
      <p>
        {tx(
          "This window cannot change how this computer is reached. Open SpecWithCode on this computer and turn on Network access or Tailscale HTTPS there, or sign in to SpecWithCode Connect, which needs neither.",
        )}
      </p>
    );
  } else if (address.hint === "tailnet") {
    instructions = (
      <ol className="list-decimal space-y-2 pl-5">
        <li>
          {tx(
            "Install Tailscale on your phone. Sign in to the same Tailscale network as this computer and turn the VPN on.",
          )}
        </li>
        <li>
          {tx(
            "Copy the computer address below and open it in the phone's browser. If it does not load, check Tailscale on both devices before making a code.",
          )}
        </li>
        <li>{tx("Open SpecWithCode on your phone, choose Pair a machine, then Scan QR code.")}</li>
      </ol>
    );
  } else {
    instructions = (
      <ol className="list-decimal space-y-2 pl-5">
        <li>{tx(describePhoneNetworkHint(address.hint))}</li>
        <li>
          {tx(
            "Open the computer address in the phone's browser. Once it loads, open SpecWithCode and choose Pair a machine, then Scan QR code.",
          )}
        </li>
      </ol>
    );
  }
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {code?.status === "ready"
              ? tx("Scan with your phone")
              : tx("Pair over your own network")}
          </DialogTitle>
          <DialogDescription>
            {code?.status === "ready"
              ? `This code works once and expires at ${code.expiresAt}. Keep this computer awake.`
              : tx(
                  "For when you cannot use SpecWithCode Connect. Your phone must reach this computer directly, on the same network or over Tailscale. Prepare the connection first, then make a one-time code.",
                )}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-4">
            <div className="text-sm text-muted-foreground">{instructions}</div>
            {address !== null ? (
              <div className="rounded-lg border border-border p-3">
                <p className="text-xs font-medium text-muted-foreground">
                  {tx("Computer address · no pairing code")}
                </p>
                <p className="mt-1 break-all text-sm">{address.httpBaseUrl}</p>
                <Button className="mt-2" size="sm" variant="outline" onClick={props.onCopyAddress}>
                  {tx("Copy computer address")}
                </Button>
              </div>
            ) : null}
            {!props.canPair ? (
              <p role="alert" className="text-sm text-destructive-foreground">
                {tx(
                  "This window cannot create pairing codes. Reopen SpecWithCode with access to this computer.",
                )}
              </p>
            ) : null}
            {props.canPair && code?.status === "ready" ? (
              <div className="flex flex-col items-center gap-2">
                <div className="w-fit rounded-xl bg-white p-3">
                  <QRCodeSvg
                    value={code.url}
                    size={208}
                    level="M"
                    marginSize={1}
                    title={tx("Pairing code for the SpecWithCode phone app")}
                  />
                </div>
                <p className="text-center text-xs text-muted-foreground">
                  {tx("Ready to scan. The phone has not confirmed a connection yet.")}
                </p>
              </div>
            ) : null}
            {code?.status === "expired" ? (
              <p role="status" className="text-sm">
                {tx("This code expired. Generate a new code when your phone is ready.")}
              </p>
            ) : null}
            {code?.status === "route-changed" ? (
              <p role="status" className="text-sm">
                {tx("The computer address changed. Generate a new code for this address.")}
              </p>
            ) : null}
            {props.error ? (
              <p role="alert" className="text-sm text-destructive-foreground">
                {props.error}
              </p>
            ) : null}
            <p className="text-xs text-muted-foreground">
              {tx(
                "If scanning fails, check the address in the phone's browser, the VPN connection and the code's expiry. A working address on this computer does not prove your phone can reach it.",
              )}
            </p>
          </div>
        </DialogPanel>
        {showAccessSetup || showPairing ? (
          <DialogFooter>
            {showAccessSetup ? (
              <>
                <Button variant="outline" onClick={props.onShowAccessSettings}>
                  {props.onTurnOnNetworkAccess
                    ? tx("Set up Tailscale HTTPS")
                    : tx("Show Network access and Tailscale HTTPS")}
                </Button>
                {props.onTurnOnNetworkAccess ? (
                  <Button onClick={props.onTurnOnNetworkAccess}>
                    {tx("Turn on Network access")}
                  </Button>
                ) : null}
              </>
            ) : null}
            {showPairing ? (
              code?.status === "ready" ? (
                <Button onClick={props.onCopyCode}>{tx("Copy pairing link")}</Button>
              ) : (
                <Button disabled={props.isCreating} onClick={props.onGenerate}>
                  {props.isCreating
                    ? tx("Creating…")
                    : code === null
                      ? tx("Generate pairing code")
                      : tx("Generate new code")}
                </Button>
              )
            ) : null}
          </DialogFooter>
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}
