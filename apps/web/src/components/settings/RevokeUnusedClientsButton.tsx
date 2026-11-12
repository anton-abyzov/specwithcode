import type { AuthSessionId } from "@specweave-studio/contracts";
import { useEffect, useRef, useState } from "react";

import { revokeServerClientSession } from "~/environments/primary";
import { useTx } from "../../i18n";
import { ensureLocalApi } from "../../localApi";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  revokeUnusedClients,
  unusedClientSessions,
  type UnusedClientCandidate,
} from "./ConnectionsSettings.logic";

/** A settings page left open still counts what has gone unused since. */
const COUNT_REFRESH_MS = 60_000;

/**
 * Authorized clients > Revoke unused: ends the computer sign-ins a person
 * paired by link or code that have had no connection for a day, and nothing
 * else (see `unusedClientSessions`). Shown only while there is one. Revoke
 * others, beside it, ends every client but this app, the fleet's machines
 * included.
 */
export function RevokeUnusedClientsButton(props: {
  /** Null while the list is unknown: nothing can be called unused then. */
  readonly clientSessions: ReadonlyArray<UnusedClientCandidate<AuthSessionId>> | null;
  readonly disabled?: boolean;
}) {
  const tx = useTx();
  const { clientSessions } = props;
  // The count follows the clock by the minute; the click reads the clock again.
  const [countedAt, setCountedAt] = useState(() => Date.now());
  // `asking` covers the question, `revoking` the requests after a yes.
  const [asking, setAsking] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const latest = useRef(clientSessions);
  useEffect(() => {
    latest.current = clientSessions;
  }, [clientSessions]);
  useEffect(() => {
    const timer = setInterval(() => setCountedAt(Date.now()), COUNT_REFRESH_MS);
    return () => clearInterval(timer);
  }, []);
  if (clientSessions === null) return null;
  const count = unusedClientSessions(clientSessions, countedAt).length;
  if (count === 0 && !asking) return null;

  const revokeUnused = async () => {
    setAsking(true);
    try {
      const result = await revokeUnusedClients({
        sessions: () => latest.current,
        now: () => Date.now(),
        confirm: async (asked) => {
          const confirmed = await ensureLocalApi().dialogs.confirm(
            tx(
              "Revoke {count} computer sign-ins that have had no connection for 24 hours? A computer that was only switched off for a day is among them and will need a new pairing link or code. This app, connected clients, phones, your other machines and their keys are kept.",
              { count: asked },
            ),
            { variant: "destructive" },
          );
          if (confirmed) setRevoking(true);
          return confirmed;
        },
        revoke: revokeServerClientSession,
      });
      if (result === null) return;
      if (result.revoked > 0)
        toastManager.add({
          type: "success",
          title: tx("Revoked {count} unused sign-ins", { count: result.revoked }),
        });
      if (result.failed > 0)
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: tx("Could not revoke {count} sign-ins", { count: result.failed }),
            ...(result.error === null ? {} : { description: result.error }),
          }),
        );
    } finally {
      setAsking(false);
      setRevoking(false);
    }
  };

  return (
    <Button
      size="xs"
      variant="outline"
      disabled={asking || props.disabled === true}
      title={tx("Computer sign-ins paired by link or code with no connection for 24 hours")}
      onClick={() => void revokeUnused()}
    >
      {revoking ? tx("Revoking…") : tx("Revoke {count} unused", { count })}
    </Button>
  );
}
