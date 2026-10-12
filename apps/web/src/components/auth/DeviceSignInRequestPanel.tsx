import type { DeviceSignInStartResult } from "@specweave-studio/contracts/deviceSignIn";
import { useCallback, useEffect, useRef, useState } from "react";

import { submitServerAuthCredential } from "../../environments/primary";
import {
  formatDeviceSignInCode,
  pollDeviceSignIn,
  startDeviceSignIn,
} from "../../studio/deviceSignIn";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";

type Phase =
  | { readonly kind: "idle" }
  | { readonly kind: "starting" }
  | { readonly kind: "waiting"; readonly request: DeviceSignInStartResult }
  | { readonly kind: "signing-in" };

function startErrorMessage(error: unknown): string {
  const message =
    typeof error === "object" && error !== null && "message" in error ? String(error.message) : "";
  return message.startsWith("Too many")
    ? message
    : "Could not ask to sign in. Reload the page and try again.";
}

/**
 * The asking side of approve-a-device sign-in: shows a code and waits until
 * someone types it on a device that is already signed in, then signs this
 * browser in with the one-time credential the approval produced.
 */
export function DeviceSignInRequestPanel({
  onAuthenticated,
}: {
  readonly onAuthenticated: () => void;
}) {
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [message, setMessage] = useState<string | null>(null);
  const generation = useRef(0);
  // The latest callback, so a re-render does not restart the polling loop.
  const authenticated = useRef(onAuthenticated);
  authenticated.current = onAuthenticated;

  useEffect(
    () => () => {
      generation.current += 1;
    },
    [],
  );

  const ask = useCallback(async () => {
    const current = ++generation.current;
    setMessage(null);
    setPhase({ kind: "starting" });
    try {
      const request = await startDeviceSignIn();
      if (current === generation.current) setPhase({ kind: "waiting", request });
    } catch (error) {
      if (current !== generation.current) return;
      setPhase({ kind: "idle" });
      setMessage(startErrorMessage(error));
    }
  }, []);

  const cancel = () => {
    generation.current += 1;
    setPhase({ kind: "idle" });
  };

  const waiting = phase.kind === "waiting" ? phase.request : null;
  useEffect(() => {
    if (!waiting) return;
    const current = generation.current;
    let timer: number | undefined;
    // Cancel and unmount bump the generation. Leaving "waiting" for "signing
    // in" must not stop the loop that is finishing the sign-in.
    const live = () => current === generation.current;
    const tick = async () => {
      let status: Awaited<ReturnType<typeof pollDeviceSignIn>> | null = null;
      try {
        status = await pollDeviceSignIn(waiting);
      } catch {
        // A restart or a dropped connection: keep asking until the request expires.
      }
      if (!live()) return;
      if (status?.status === "approved" && status.credential) {
        setPhase({ kind: "signing-in" });
        try {
          await submitServerAuthCredential(status.credential);
          if (live()) authenticated.current();
        } catch {
          if (!live()) return;
          setPhase({ kind: "idle" });
          setMessage("Approved, but signing in failed. Ask again.");
        }
        return;
      }
      if (status?.status === "expired" || Date.parse(waiting.expiresAt) <= Date.now()) {
        setPhase({ kind: "idle" });
        setMessage("The request expired. Ask again.");
        return;
      }
      timer = window.setTimeout(() => void tick(), waiting.pollIntervalMs);
    };
    timer = window.setTimeout(() => void tick(), waiting.pollIntervalMs);
    return () => window.clearTimeout(timer);
  }, [waiting]);

  return (
    <section
      aria-labelledby="device-sign-in-heading"
      className="mt-6 space-y-3 rounded-lg border border-border/70 bg-background/55 px-4 py-4"
      data-testid="device-sign-in-request"
    >
      <h2 id="device-sign-in-heading" className="font-medium text-sm">
        Sign in from a device you already use
      </h2>
      {waiting ? (
        <>
          <p className="text-muted-foreground text-sm">
            On a computer or phone already signed in to this machine, open the account menu, choose
            Sign in on another device, and type this code.
          </p>
          <div
            aria-label="Sign-in code"
            aria-live="polite"
            className="rounded-md border border-border/70 bg-background py-3 text-center font-mono text-3xl tracking-[0.2em]"
          >
            {formatDeviceSignInCode(waiting.code)}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground text-xs">Waiting for approval…</span>
            <Button className="ms-auto" onClick={cancel} size="sm" variant="ghost">
              Cancel
            </Button>
          </div>
        </>
      ) : (
        <>
          <p className="text-muted-foreground text-sm">
            No token needed: this page shows a code, and you type it on a device that is already
            signed in.
          </p>
          <Button
            disabled={phase.kind === "starting" || phase.kind === "signing-in"}
            onClick={() => void ask()}
            size="sm"
          >
            {phase.kind === "signing-in"
              ? "Signing in…"
              : phase.kind === "starting"
                ? "Asking…"
                : "Ask to sign in"}
          </Button>
        </>
      )}
      {message ? (
        <Alert variant="info">
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      ) : null}
    </section>
  );
}
