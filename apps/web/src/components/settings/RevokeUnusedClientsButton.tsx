import { useState } from "react";

import type { AuthSessionId } from "@specweave-studio/contracts";

import { revokeServerClientSession } from "~/environments/primary";
import { useTx } from "../../i18n";
import { ensureLocalApi } from "../../localApi";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  revokeClientSessions,
  unusedClientSessions,
  type UnusedClientCandidate,
} from "./ConnectionsSettings.logic";

/**
 * Authorized clients > Revoke unused: ends the sign-ins a person paired by link
 * or code that have not connected for a day, and nothing else (see
 * `unusedClientSessions`). Shown only while there is one. Revoke others, beside
 * it, ends every client but this app, the fleet's machines included.
 */
export function RevokeUnusedClientsButton(props: {
  /** Null while the list is unknown: nothing can be called unused then. */
  readonly clientSessions: ReadonlyArray<UnusedClientCandidate<AuthSessionId>> | null;
  readonly disabled?: boolean;
}) {
  const tx = useTx();
  // Read once: the count is a snapshot, and the click reads the clock again.
  const [openedAt] = useState(() => Date.now());
  const [revoking, setRevoking] = useState(false);
  const { clientSessions } = props;
  if (clientSessions === null) return null;
  const count = unusedClientSessions(clientSessions, openedAt).length;
  if (count === 0 && !revoking) return null;

  const revokeUnused = async () => {
    const unused = unusedClientSessions(clientSessions, Date.now());
    if (unused.length === 0) return;
    const confirmed = await ensureLocalApi().dialogs.confirm(
      tx(
        "Revoke {count} sign-ins that have not connected for 24 hours? This app, phones, your other machines and their keys are kept. A device among the revoked ones needs a new pairing link or code.",
        { count: unused.length },
      ),
      { variant: "destructive" },
    );
    if (!confirmed) return;
    setRevoking(true);
    try {
      const result = await revokeClientSessions(
        unused.map((session) => session.sessionId),
        revokeServerClientSession,
      );
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
      setRevoking(false);
    }
  };

  return (
    <Button
      size="xs"
      variant="outline"
      disabled={revoking || props.disabled === true}
      title={tx("Sign-ins paired by link or code that have not connected for 24 hours")}
      onClick={() => void revokeUnused()}
    >
      {revoking ? tx("Revoking…") : tx("Revoke {count} unused", { count })}
    </Button>
  );
}
