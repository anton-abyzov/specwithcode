import { useEffect, useState, type ReactNode } from "react";
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

export function PhoneSetupDialog(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly address: PhonePairingAddress | null;
  readonly code: PhoneSetupCode | null;
  readonly canPair: boolean;
  readonly isCreating: boolean;
  readonly error: string | null;
  readonly hasAccessControls: boolean;
  readonly onShowAccessSettings: () => void;
  /**
   * Goes to the SpecWithCode Connect card on this page. Provided only where
   * Connect is shown: the dialog then explains Connect first and keeps the
   * private QR pairing behind "Use a private QR code instead".
   */
  readonly onUseConnect?: () => void;
  readonly onGenerate: () => void;
  readonly onCopyAddress: () => void;
  readonly onCopyCode: () => void;
}) {
  const { address, code } = props;
  const [fallbackChosen, setFallbackChosen] = useState(false);
  // Reset on opening, not on closing, so the dialog keeps its content while it animates out.
  useEffect(() => {
    if (props.open) setFallbackChosen(false);
  }, [props.open]);
  if (props.onUseConnect && !fallbackChosen && code === null) {
    return (
      <Dialog open={props.open} onOpenChange={props.onOpenChange}>
        <DialogPopup className="max-w-lg">
          <ConnectFirstContent
            onUseConnect={props.onUseConnect}
            onUseFallback={() => setFallbackChosen(true)}
          />
        </DialogPopup>
      </Dialog>
    );
  }
  const showAccessSetup = props.hasAccessControls && address === null;
  const showPairing = address !== null && props.canPair;
  let instructions: ReactNode;
  if (address === null) {
    instructions = (
      <p>
        The simplest way to reach this computer from your iPhone is to sign in to SpecWithCode
        Connect in the desktop app. No Tailscale is needed. To pair with a private QR code instead,
        this computer needs a private HTTPS address: set up Tailscale on this computer and your
        iPhone, sign in to the same tailnet, then enable Tailscale HTTPS in Connections.
      </p>
    );
  } else if (address.hint === "tailnet") {
    instructions = (
      <ol className="list-decimal space-y-2 pl-5">
        <li>
          Install Tailscale on your iPhone. Sign in to the same tailnet as this computer and turn
          the VPN on.
        </li>
        <li>
          Copy the computer address below and open it in Safari on your iPhone. If it cannot load,
          check Tailscale on both devices before making a code.
        </li>
        <li>Open SpecWithCode on your iPhone, tap Pair a machine, then Scan QR code.</li>
      </ol>
    );
  } else {
    instructions = (
      <ol className="list-decimal space-y-2 pl-5">
        <li>{describePhoneNetworkHint(address.hint)}</li>
        <li>
          Open the computer address in Safari on your iPhone. Once it loads, open SpecWithCode and
          tap Pair a machine, then Scan QR code.
        </li>
      </ol>
    );
  }
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {code?.status === "ready" ? "Scan with your iPhone" : "Pair with a private QR code"}
          </DialogTitle>
          <DialogDescription>
            {code?.status === "ready"
              ? `This code works once and expires at ${code.expiresAt}. Keep this computer awake.`
              : "A fallback for when you can't use SpecWithCode Connect. Your iPhone must reach this computer directly, on the same network or over Tailscale. Prepare the connection first, then make a one-time code."}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-4">
            <div className="text-sm text-muted-foreground">{instructions}</div>
            {address !== null ? (
              <div className="rounded-lg border border-border p-3">
                <p className="text-xs font-medium text-muted-foreground">
                  Computer address · no pairing code
                </p>
                <p className="mt-1 break-all text-sm">{address.httpBaseUrl}</p>
                <Button className="mt-2" size="sm" variant="outline" onClick={props.onCopyAddress}>
                  Copy computer address
                </Button>
              </div>
            ) : null}
            {!props.canPair ? (
              <p role="alert" className="text-sm text-destructive-foreground">
                This window cannot create pairing codes. Reopen SpecWithCode with access to this
                computer.
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
                    title="Pairing code for the SpecWithCode iPhone app"
                  />
                </div>
                <p className="text-center text-xs text-muted-foreground">
                  Ready to scan. The phone has not confirmed a connection yet.
                </p>
              </div>
            ) : null}
            {code?.status === "expired" ? (
              <p role="status" className="text-sm">
                This code expired. Generate a new code when your phone is ready.
              </p>
            ) : null}
            {code?.status === "route-changed" ? (
              <p role="status" className="text-sm">
                The computer address changed. Generate a new code for this address.
              </p>
            ) : null}
            {props.error ? (
              <p role="alert" className="text-sm text-destructive-foreground">
                {props.error}
              </p>
            ) : null}
            <p className="text-xs text-muted-foreground">
              If scanning fails, check the address in Safari, the VPN connection and the code's
              expiry. A working address on this computer does not prove your phone can reach it.
            </p>
          </div>
        </DialogPanel>
        {showAccessSetup || showPairing ? (
          <DialogFooter>
            {showAccessSetup ? (
              <Button onClick={props.onShowAccessSettings}>Set up Tailscale HTTPS</Button>
            ) : null}
            {showPairing ? (
              code?.status === "ready" ? (
                <Button onClick={props.onCopyCode}>Copy pairing link</Button>
              ) : (
                <Button disabled={props.isCreating} onClick={props.onGenerate}>
                  {props.isCreating
                    ? "Creating…"
                    : code === null
                      ? "Generate pairing code"
                      : "Generate new code"}
                </Button>
              )
            ) : null}
          </DialogFooter>
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}

/**
 * What "Pair a phone" shows where Connect is available: signing in with the
 * same account is the way to add an iPhone, and every further iPhone is added
 * the same way. The private QR pairing is one click further.
 */
function ConnectFirstContent(props: {
  readonly onUseConnect: () => void;
  readonly onUseFallback: () => void;
}) {
  return (
    <>
      <DialogHeader>
        <DialogTitle>Add your iPhone with SpecWithCode Connect</DialogTitle>
        <DialogDescription>
          Sign in with the same account on this computer and on the iPhone. It works from anywhere,
          with no Tailscale, VPN or QR code.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <ol className="list-decimal space-y-2 pl-5 text-sm text-muted-foreground">
          <li>
            On this computer, check Use SpecWithCode on your phone. If it does not say this computer
            is ready for your iPhone yet, sign in there and turn it on.
          </li>
          <li>On the iPhone, open SpecWithCode and sign in with the same account.</li>
          <li>This computer appears in the iPhone's list. Tap it to start.</li>
        </ol>
        <p className="mt-4 text-sm text-muted-foreground">
          For a second iPhone, repeat the last two steps on it. Each iPhone signs in on its own;
          phones do not count toward your Connect machines.
        </p>
      </DialogPanel>
      <DialogFooter>
        <Button variant="ghost" onClick={props.onUseFallback}>
          Use a private QR code instead
        </Button>
        <Button onClick={props.onUseConnect}>Go to SpecWithCode Connect</Button>
      </DialogFooter>
    </>
  );
}
