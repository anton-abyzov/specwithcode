import { useEffect, useRef, useState } from "react";

import type { ConnectAtSignIn } from "./connectOnboarding";

/**
 * Turns SpecWithCode Connect on once for a sign-in that completed in this
 * session. `request` names the account; the decision is re-read as the
 * session, Team rules and link state settle, and one decision ends the request,
 * so a later render never turns it on a second time.
 */
export function useConnectOnAtSignIn(options: {
  readonly decide: (account: string) => ConnectAtSignIn;
  /** Another change to the link is in flight. */
  readonly busy: boolean;
  /** Applies the link; resolves false after reporting its own failure. */
  readonly turnOn: () => Promise<boolean>;
  readonly onTurnedOn: (account: string) => void;
}): {
  readonly request: (account: string) => void;
  readonly cancel: () => void;
  readonly applying: boolean;
} {
  const [account, setAccount] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const running = useRef(false);
  // Counts requests and cancels, so a result that arrives after a sign-out or
  // an account switch is not reported for the account that left.
  const generation = useRef(0);
  const decision = account === null ? "skip" : options.decide(account);

  // `applying` is a dependency so a request made while a turn-on was running is
  // decided when that one ends.
  useEffect(() => {
    if (account === null || running.current || options.busy || decision === "wait") return;
    setAccount(null);
    if (decision !== "turn-on") return;
    const started = generation.current;
    running.current = true;
    setApplying(true);
    void options
      .turnOn()
      .catch(() => false)
      .then((ok) => {
        running.current = false;
        setApplying(false);
        if (ok && generation.current === started) options.onTurnedOn(account);
      });
  }, [account, applying, decision, options.busy]);

  return {
    request: (next) => {
      generation.current += 1;
      setAccount(next);
    },
    cancel: () => {
      generation.current += 1;
      setAccount(null);
    },
    applying,
  };
}
