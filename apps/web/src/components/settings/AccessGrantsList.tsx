/**
 * The "Always on this machine" grants of one kind (apps or devices), listed
 * under the setting that lets agents use them, each with a Remove button.
 *
 * @module AccessGrantsList
 */
import type { AccessGrant, EnvironmentId } from "@specweave-studio/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@specweave-studio/client-runtime/state/runtime";
import { useEffect, useState } from "react";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { Button } from "../ui/button";

export type AccessGrantsKind = "app" | "device";

const COPY = {
  app: {
    title: "Apps allowed on this machine",
    loadFailed: "Could not load the apps allowed on this machine.",
    empty:
      "No apps allowed on this machine yet. When an agent asks to use an app, choose Always on this machine to stop it asking again.",
  },
  device: {
    title: "Devices allowed on this machine",
    loadFailed: "Could not load the devices allowed on this machine.",
    empty:
      "No devices allowed on this machine yet. When an agent asks to use a device, choose Always on this machine to stop it asking again.",
  },
} as const satisfies Record<AccessGrantsKind, { title: string; loadFailed: string; empty: string }>;

function failureMessage(result: AtomCommandResult<unknown, unknown>, fallback: string): string {
  if (result._tag !== "Failure") return fallback;
  const error = squashAtomCommandFailure(result);
  return error instanceof Error && error.message ? error.message : fallback;
}

export function allowedLabel(grantedAt: string): string {
  const relative = formatRelativeTimeLabel(grantedAt);
  return relative ? `Allowed ${relative}` : "Allowed";
}

export function AccessGrantsList({
  kind,
  environmentId,
}: {
  readonly kind: AccessGrantsKind;
  readonly environmentId: EnvironmentId;
}) {
  const listGrants = useAtomCommand(serverEnvironment.listAccessGrants, { reportFailure: false });
  const revokeGrant = useAtomCommand(serverEnvironment.revokeAccessGrant, {
    reportFailure: false,
  });
  const [grants, setGrants] = useState<ReadonlyArray<AccessGrant> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [removingKey, setRemovingKey] = useState<string | null>(null);
  const copy = COPY[kind];

  useEffect(() => {
    let cancelled = false;
    void listGrants({ environmentId, input: {} }).then((result) => {
      if (cancelled || isAtomCommandInterrupted(result)) return;
      if (result._tag === "Success") {
        setGrants(result.value.grants);
        setError(null);
      } else {
        setError(copy.loadFailed);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [copy, environmentId, listGrants]);

  const remove = async (grant: AccessGrant) => {
    if (removingKey !== null) return;
    setRemovingKey(grant.key);
    setError(null);
    const result = await revokeGrant({ environmentId, input: { key: grant.key } });
    setRemovingKey(null);
    if (result._tag === "Success") {
      setGrants(result.value.grants);
      return;
    }
    if (isAtomCommandInterrupted(result)) return;
    setError(failureMessage(result, `Could not remove ${grant.label}.`));
  };

  const shown = grants?.filter((grant) => grant.kind === kind) ?? null;

  return (
    <div className="mt-3 mb-2 space-y-2" data-testid={`access-grants-${kind}`}>
      <p className="text-xs font-medium text-foreground">{copy.title}</p>
      {shown === null ? (
        error === null ? (
          <p className="text-xs text-muted-foreground">Loading…</p>
        ) : null
      ) : shown.length === 0 ? (
        <p className="text-xs text-muted-foreground">{copy.empty}</p>
      ) : (
        <ul className="divide-y divide-border/50 rounded-md border border-border/60">
          {shown.map((grant) => (
            <li key={grant.key} className="flex min-w-0 items-center gap-3 px-3 py-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-foreground">{grant.label}</p>
                <p className="text-xs text-muted-foreground">{allowedLabel(grant.grantedAt)}</p>
              </div>
              <Button
                size="xs"
                variant="outline"
                aria-label={`Remove ${grant.label}`}
                disabled={removingKey !== null}
                onClick={() => void remove(grant)}
              >
                {removingKey === grant.key ? "Removing…" : "Remove"}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {error !== null ? (
        <p role="alert" className="text-xs text-destructive-foreground">
          {error}
        </p>
      ) : null}
    </div>
  );
}
