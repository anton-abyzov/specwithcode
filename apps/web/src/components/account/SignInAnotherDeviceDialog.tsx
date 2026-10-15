import { useAtomValue } from "@effect/atom-react";
import type { AdvertisedEndpoint } from "@specweave-studio/contracts";
import { useNavigate } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { CheckIcon, CopyIcon } from "lucide-react";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";

import { isElectron } from "../../env";
import { useServerConfigs } from "../../state/entities";
import { desktopNetworkAccessStateAtom } from "../../state/desktopNetworkAccess";
import { usePrimaryEnvironment } from "../../state/environments";
import {
  describeSignInDevice,
  describeWaitingDevice,
  isCompleteDeviceSignInCode,
  submitDeviceSignInCode,
} from "../../studio/deviceSignIn";
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
import { Input } from "../ui/input";
import { QRCodeSvg } from "../ui/qr-code";
import { pickSignInAddress } from "./signInAddress";

const NO_ENDPOINTS: ReadonlyArray<AdvertisedEndpoint> = [];

// The desktop bridge is fixed for the window's lifetime, so the hook choice is too.
const useDesktopAdvertisedEndpoints = isElectron
  ? () => {
      const result = useAtomValue(desktopNetworkAccessStateAtom);
      return Option.getOrNull(AsyncResult.value(result))?.advertisedEndpoints ?? NO_ENDPOINTS;
    }
  : () => NO_ENDPOINTS;

type Approval =
  | { readonly kind: "idle" }
  | { readonly kind: "looking" }
  | { readonly kind: "found"; readonly code: string; readonly device: string }
  | { readonly kind: "approving"; readonly code: string; readonly device: string }
  | { readonly kind: "approved"; readonly device: string }
  | { readonly kind: "error"; readonly message: string };

/**
 * How to use this machine from a phone or another computer: open its HTTPS
 * address, tap "Ask to sign in", and type the code it shows here. Typing the
 * code, not clicking a prompt, is the approval: a stranger who asks to sign in
 * has no way to put their code in front of you.
 */
export function SignInAnotherDeviceDialog({
  acceptsBrowsers,
  open,
  onOpenChange,
}: {
  readonly acceptsBrowsers: boolean;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const navigate = useNavigate();
  const primary = usePrimaryEnvironment();
  const configs = useServerConfigs();
  const advertised = useDesktopAdvertisedEndpoints();
  const directEndpoints = primary ? configs.get(primary.environmentId)?.directEndpoints : undefined;
  const address = useMemo(
    () =>
      pickSignInAddress({
        pageUrl: typeof window === "undefined" ? null : window.location.href,
        directEndpoints: directEndpoints ?? [],
        advertisedEndpoints: advertised,
      }),
    [advertised, directEndpoints],
  );
  const [copied, setCopied] = useState(false);
  const [code, setCode] = useState("");
  const [approval, setApproval] = useState<Approval>({ kind: "idle" });
  // Bumped on close and on each request, so a late answer never lands in a reopened dialog.
  const attempt = useRef(0);
  const machine = primary?.label ?? "this machine";
  const busy = approval.kind === "looking" || approval.kind === "approving";

  useEffect(() => {
    if (open) return;
    attempt.current += 1;
    setCode("");
    setApproval({ kind: "idle" });
  }, [open]);

  const failed = (cause: unknown) =>
    setApproval({
      kind: "error",
      message: cause instanceof Error ? cause.message : "Could not reach this machine. Try again.",
    });
  const notFound = () =>
    setApproval({
      kind: "error",
      message: "No device is waiting with that code. Check it, or ask to sign in again.",
    });

  // Step 1: look the code up, so the owner sees which device it is before it gets in.
  const lookUp = async (event: FormEvent) => {
    event.preventDefault();
    if (!primary || !isCompleteDeviceSignInCode(code) || busy) return;
    const current = ++attempt.current;
    setApproval({ kind: "looking" });
    try {
      const result = await submitDeviceSignInCode(primary.environmentId, code, false);
      if (current !== attempt.current) return;
      if (result.status === "found" && result.device)
        setApproval({ kind: "found", code, device: describeWaitingDevice(result.device) });
      else notFound();
    } catch (cause) {
      if (current === attempt.current) failed(cause);
    }
  };

  // Step 2: let that device in.
  const confirm = async () => {
    if (!primary || approval.kind !== "found") return;
    const current = ++attempt.current;
    setApproval({ ...approval, kind: "approving" });
    try {
      const result = await submitDeviceSignInCode(primary.environmentId, approval.code, true);
      if (current !== attempt.current) return;
      if (result.status === "approved" && result.device) {
        setCode("");
        setApproval({ kind: "approved", device: describeSignInDevice(result.device) });
      } else notFound();
    } catch (cause) {
      if (current === attempt.current) failed(cause);
    }
  };

  const copy = async () => {
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard needs a secure context; the address stays selectable.
    }
  };

  const openConnections = () => {
    onOpenChange(false);
    void navigate({ to: "/settings/connections" });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-md" data-testid="sign-in-another-device">
        <DialogHeader>
          <DialogTitle>Sign in on another device</DialogTitle>
          <DialogDescription>
            Use {machine} from your phone or another computer. Its projects and agents keep running
            here.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          {!acceptsBrowsers ? (
            <p className="text-sm">
              {machine} only accepts this desktop app right now. Turn on Network access or Tailscale
              HTTPS in Connections so your other devices can reach it and ask to sign in.
            </p>
          ) : address ? (
            <>
              <ol className="list-decimal space-y-1 ps-5 text-sm">
                <li>Open this address on the other device, or scan the code.</li>
                <li>Tap “Ask to sign in”.</li>
                <li>Type the code it shows below.</li>
              </ol>
              <div className="flex items-center gap-4">
                <div className="shrink-0 rounded-md bg-white p-2">
                  <QRCodeSvg value={address} size={112} title={`QR code for ${address}`} />
                </div>
                <div className="min-w-0 space-y-2">
                  <code className="block select-all break-all rounded-md border border-border/70 bg-background/55 px-2 py-1.5 text-xs">
                    {address}
                  </code>
                  <Button onClick={() => void copy()} size="xs" variant="outline">
                    {copied ? <CheckIcon /> : <CopyIcon />}
                    {copied ? "Copied" : "Copy address"}
                  </Button>
                </div>
              </div>
              <p className="text-muted-foreground text-xs">
                The other device must be on your tailnet. Nothing is reachable from the open
                internet.
              </p>
            </>
          ) : (
            <p className="text-sm">
              {machine} has no HTTPS address yet, and browsers on other devices need one. Turn on
              Tailscale HTTPS in Connections, then come back here. The desktop app can also add this
              machine over SSH without it.
            </p>
          )}
          {acceptsBrowsers ? (
            <form className="space-y-2" onSubmit={(event) => void lookUp(event)}>
              <label className="block font-medium text-sm" htmlFor="device-sign-in-code">
                Code shown on the other device
              </label>
              <div className="flex gap-2">
                <Input
                  id="device-sign-in-code"
                  autoCapitalize="characters"
                  autoComplete="off"
                  className="font-mono uppercase tracking-[0.2em]"
                  maxLength={9}
                  onChange={(event) => {
                    setCode(event.target.value);
                    if (!busy) setApproval({ kind: "idle" });
                  }}
                  placeholder="ABC-DEF"
                  spellCheck={false}
                  value={code}
                />
                <Button
                  disabled={!isCompleteDeviceSignInCode(code) || busy || approval.kind === "found"}
                  type="submit"
                  variant={approval.kind === "found" ? "outline" : "default"}
                >
                  {approval.kind === "looking" ? "Checking…" : "Continue"}
                </Button>
              </div>
              {approval.kind === "found" || approval.kind === "approving" ? (
                <div
                  className="space-y-2 rounded-md border border-border/70 px-3 py-2"
                  role="status"
                >
                  <p className="text-sm">
                    {approval.device} wants to sign in. Approve only if that is the device in your
                    hand.
                  </p>
                  <div className="flex justify-end gap-2">
                    <Button
                      disabled={approval.kind === "approving"}
                      onClick={() => setApproval({ kind: "idle" })}
                      size="sm"
                      variant="outline"
                    >
                      Cancel
                    </Button>
                    <Button
                      disabled={approval.kind === "approving"}
                      onClick={() => void confirm()}
                      size="sm"
                    >
                      {approval.kind === "approving" ? "Approving…" : "Approve"}
                    </Button>
                  </div>
                </div>
              ) : approval.kind === "approved" ? (
                <p className="text-sm" role="status">
                  {approval.device} is signed in. It can use projects, chats and terminals here, but
                  cannot approve other devices.
                </p>
              ) : approval.kind === "error" ? (
                <p className="text-destructive-foreground text-sm" role="alert">
                  {approval.message}
                </p>
              ) : (
                <p className="text-muted-foreground text-xs">
                  Only type a code you can see on a device you are holding.
                </p>
              )}
            </form>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button onClick={openConnections} variant="outline">
            Connections and devices
          </Button>
          <Button onClick={() => onOpenChange(false)}>Done</Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
