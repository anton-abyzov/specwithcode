import { Alert, AlertDescription } from "../ui/alert";
import type { AuthSessionState } from "@specweave-studio/contracts";
import { squashAtomCommandFailure } from "@specweave-studio/client-runtime/state/runtime";
import React, { startTransition, useEffect, useRef, useState, useCallback } from "react";

import { APP_DISPLAY_NAME } from "../../branding";
import { connectPairing } from "../../connection/onboarding";
import {
  peekPairingTokenFromUrl,
  stripPairingTokenFromUrl,
  submitServerAuthCredential,
} from "../../environments/primary";
import { readHostedPairingRequest } from "../../hostedPairing";
import { PHONE_APP_URL } from "../settings/PhoneConnect.logic";
import { DeviceSignInRequestPanel } from "./DeviceSignInRequestPanel";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { StandalonePage, StandalonePageHeader } from "../ui/standalone-page";
import { useAtomCommand } from "../../state/use-atom-command";

export function PairingPendingSurface() {
  return (
    <StandalonePage tone="pairing">
      <StandalonePageHeader
        eyebrow={APP_DISPLAY_NAME}
        title="Pairing with this computer"
        description="Checking the pairing link."
      />
    </StandalonePage>
  );
}

export function PairingRouteSurface({
  auth,
  initialErrorMessage,
  onAuthenticated,
}: {
  auth: AuthSessionState["auth"];
  initialErrorMessage?: string;
  onAuthenticated: () => void;
}) {
  const autoPairTokenRef = useRef<string | null>(peekPairingTokenFromUrl());
  const [credential, setCredential] = useState(() => autoPairTokenRef.current ?? "");
  const [errorMessage, setErrorMessage] = useState(initialErrorMessage ?? "");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const autoSubmitAttemptedRef = useRef(false);
  const canAskToSignIn = auth.bootstrapMethods.includes("one-time-token");
  // The code field is the quiet way in. It starts open when it is the only way,
  // when a link brought a code, and when there is an error to read.
  const [codeOpen, setCodeOpen] = useState(
    () => !canAskToSignIn || peekPairingTokenFromUrl() !== null || Boolean(initialErrorMessage),
  );

  const submitCredential = useCallback(
    async (nextCredential: string) => {
      setIsSubmitting(true);
      setErrorMessage("");

      const submitError = await submitServerAuthCredential(nextCredential).then(
        () => null,
        (error) => errorMessageFromUnknown(error),
      );

      setIsSubmitting(false);

      if (submitError) {
        setErrorMessage(submitError);
        setCodeOpen(true);
        return;
      }

      startTransition(() => {
        onAuthenticated();
      });
    },
    [onAuthenticated],
  );

  const handleSubmit = useCallback(
    async (event?: React.SubmitEvent<HTMLFormElement>) => {
      event?.preventDefault();
      await submitCredential(credential);
    },
    [submitCredential, credential],
  );

  useEffect(() => {
    const token = autoPairTokenRef.current;
    if (!token || autoSubmitAttemptedRef.current) {
      return;
    }

    autoSubmitAttemptedRef.current = true;
    stripPairingTokenFromUrl();
    void submitCredential(token);
  }, [submitCredential]);

  return (
    <StandalonePage tone="pairing">
      <StandalonePageHeader
        eyebrow={APP_DISPLAY_NAME}
        title="Open this computer"
        description={
          canAskToSignIn
            ? "Use the phone app, or sign this browser in."
            : "Use the phone app, or open this computer from its desktop app."
        }
      />

      <section
        aria-labelledby="pair-phone-app-heading"
        className="mt-6 space-y-3 rounded-lg border border-primary/40 bg-background/55 px-4 py-4"
        data-testid="pair-phone-app"
      >
        <h2 id="pair-phone-app-heading" className="font-medium text-sm">
          Get the phone app
        </h2>
        <p className="text-muted-foreground text-sm">
          On a phone, the app is the easy way in. Install it, then sign in to SpecWithCode Connect
          in the app with the same account as this computer. The computer shows up there once
          Connect is on for it.
        </p>
        <Button
          size="sm"
          render={<a href={PHONE_APP_URL} target="_blank" rel="noreferrer noopener" />}
        >
          Get the phone app
        </Button>
      </section>

      {canAskToSignIn ? <DeviceSignInRequestPanel onAuthenticated={onAuthenticated} /> : null}

      <details
        className="mt-6 rounded-lg border border-border/70 bg-background/55 px-4 py-3"
        data-testid="pair-code"
        open={codeOpen}
        onToggle={(event) => setCodeOpen(event.currentTarget.open)}
      >
        <summary className="cursor-default font-medium text-sm">I have a pairing code</summary>
        <form className="mt-4 space-y-4" onSubmit={(event) => void handleSubmit(event)}>
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="pairing-token">
              Pairing code
            </label>
            <Input
              id="pairing-token"
              autoCapitalize="none"
              autoComplete="off"
              autoCorrect="off"
              disabled={isSubmitting}
              nativeInput
              onChange={(event) => setCredential(event.currentTarget.value)}
              placeholder="Paste the code"
              spellCheck={false}
              value={credential}
            />
            <p className="text-muted-foreground text-xs leading-relaxed">
              {describeCodeField(auth.bootstrapMethods)}
            </p>
          </div>

          {errorMessage ? (
            <Alert variant="error">
              <AlertDescription>{errorMessage}</AlertDescription>
            </Alert>
          ) : null}

          <div className="flex flex-wrap gap-2">
            <Button
              disabled={isSubmitting}
              size="sm"
              type="submit"
              variant={canAskToSignIn ? "outline" : "default"}
            >
              {isSubmitting ? "Pairing…" : "Continue"}
            </Button>
            <Button
              disabled={isSubmitting}
              onClick={() => window.location.reload()}
              size="sm"
              variant="ghost"
            >
              Reload
            </Button>
          </div>
        </form>
      </details>
    </StandalonePage>
  );
}

export function HostedPairingRouteSurface() {
  const connectPairingEnvironment = useAtomCommand(connectPairing, {
    reportFailure: false,
  });
  const hostedPairingRequestRef = useRef(readHostedPairingRequest());
  const [status, setStatus] = useState<"pairing" | "paired" | "error">(() =>
    hostedPairingRequestRef.current ? "pairing" : "error",
  );
  const [message, setMessage] = useState(() =>
    hostedPairingRequestRef.current
      ? "Connecting to this computer."
      : "This pairing link is missing the computer's address or its code.",
  );
  const [canRetry, setCanRetry] = useState(false);
  const submitAttemptedRef = useRef(false);
  const tokenSubmittedRef = useRef(false);

  const submitHostedPairingRequest = useCallback(async () => {
    const request = hostedPairingRequestRef.current;

    if (!request) {
      setStatus("error");
      setMessage("This pairing link is missing the computer's address or its code.");
      setCanRetry(false);
      return;
    }

    if (tokenSubmittedRef.current) {
      setStatus("error");
      setMessage("This pairing code was already used. Ask for a new pairing link.");
      setCanRetry(false);
      return;
    }

    setStatus("pairing");
    setMessage("Connecting to this computer.");
    setCanRetry(false);
    tokenSubmittedRef.current = true;

    const result = await connectPairingEnvironment({
      host: request.host,
      pairingCode: request.token,
    });
    if (result._tag === "Success") {
      setStatus("paired");
      setMessage(`${request.label || "The computer"} is saved in this browser.`);
      return;
    }

    tokenSubmittedRef.current = false;
    setStatus("error");
    setCanRetry(true);
    setMessage(
      `${errorMessageFromUnknown(squashAtomCommandFailure(result))} If the computer already took this code, ask for a new pairing link before you try again.`,
    );
  }, [connectPairingEnvironment]);

  useEffect(() => {
    if (submitAttemptedRef.current) {
      return;
    }
    submitAttemptedRef.current = true;

    stripPairingTokenFromUrl();
    void submitHostedPairingRequest();
  }, [submitHostedPairingRequest]);

  const request = hostedPairingRequestRef.current;

  return (
    <StandalonePage tone="pairing">
      <StandalonePageHeader
        eyebrow={APP_DISPLAY_NAME}
        title={
          status === "paired"
            ? "Computer paired"
            : status === "error"
              ? "Pairing failed"
              : "Pairing with this computer"
        }
        description={message}
      />

      {request ? (
        <div className="mt-5 rounded-lg border border-border/70 bg-background/55 px-3 py-3 text-xs leading-relaxed text-muted-foreground">
          Address: <span className="font-mono text-foreground/80">{request.host}</span>
        </div>
      ) : null}

      {status === "error" ? (
        <Alert variant="error" className="mt-5">
          <AlertDescription>
            Check that this browser can reach the computer at that address, that the computer allows
            this site, and that its address is HTTPS when this page is.
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="mt-6 flex flex-wrap gap-2">
        {status === "pairing" ? (
          <Button disabled size="sm">
            Pairing…
          </Button>
        ) : canRetry ? (
          <Button size="sm" onClick={() => void submitHostedPairingRequest()}>
            Try again
          </Button>
        ) : null}
        {status === "paired" ? (
          <Button size="sm" variant="outline" onClick={() => (window.location.href = "/")}>
            Open app
          </Button>
        ) : null}
      </div>
    </StandalonePage>
  );
}

function errorMessageFromUnknown(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  if (typeof error === "string" && error.trim().length > 0) {
    return error;
  }

  return "Authentication failed.";
}

/** One line under the code field: where a code comes from on this computer. */
function describeCodeField(bootstrapMethods: ReadonlyArray<string>): string {
  if (!bootstrapMethods.includes("one-time-token")) {
    return "This computer is opened from its desktop app. Paste a code here only if you were given one.";
  }
  return "A pairing link opens this page and fills the code in. You can also paste the code here.";
}
