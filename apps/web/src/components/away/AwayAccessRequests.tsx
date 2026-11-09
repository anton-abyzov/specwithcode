/**
 * Settings > Machines on the machine work is left on: access requests other
 * machines sent for Away mode. Approve applies the listed grant changes
 * (routines, projects) to that machine's grant here; the other items are
 * steps to take by hand. Nothing is approved automatically.
 */
import {
  AuthAccessReadScope,
  AuthAccessWriteScope,
  type AwayAccessRequestRecord,
  type EnvironmentId,
} from "@specweave-studio/contracts";
import { useCallback, useEffect, useState } from "react";

import { useEnvironmentScope } from "../../state/session";
import { Button } from "../ui/button";
import { SettingsSection } from "../settings/settingsLayout";
import { pendingAccessRequests, requestChangeSummary } from "./awayAccessRequests.logic";
import { awayRpc, runAway } from "./awayRpc";

const REFRESH_MS = 30_000;

export function AwayAccessRequests({ environmentId }: { environmentId: EnvironmentId }) {
  const canRead = useEnvironmentScope(environmentId, AuthAccessReadScope);
  const canDecide = useEnvironmentScope(environmentId, AuthAccessWriteScope);
  const [requests, setRequests] = useState<readonly AwayAccessRequestRecord[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const next = await runAway(awayRpc.accessRequests, { environmentId, input: {} });
    if (next.ok) setRequests(next.value.requests);
  }, [environmentId]);

  useEffect(() => {
    if (!canRead) return;
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [canRead, load]);

  const decide = (requestId: string, decision: "approve" | "decline") => {
    setBusy(requestId);
    setError(null);
    void runAway(awayRpc.decideAccess, { environmentId, input: { requestId, decision } }).then(
      (next) => {
        setBusy(null);
        if (!next.ok) setError(next.error);
        void load();
      },
    );
  };

  const pending = pendingAccessRequests(requests);
  if (pending.length === 0) return null;
  return (
    <SettingsSection title="Access requests" data-testid="away-access-requests">
      <ul className="flex flex-col gap-3 p-4 text-sm">
        {pending.map((request) => (
          <li key={request.requestId} className="flex flex-col gap-2">
            <p className="font-medium">
              {`${request.fromLabel} asks to leave its work here while it is away.`}
            </p>
            <ul className="flex flex-col gap-1 pl-4 text-xs text-muted-foreground">
              {request.missing.map((item) => (
                <li key={`${item.kind}:${item.projectId ?? ""}:${item.detail}`}>
                  {item.machineEnvironmentId === request.fromEnvironmentId
                    ? `On ${request.fromLabel}: ${item.fix}`
                    : item.fix}
                </li>
              ))}
            </ul>
            <p className="text-xs text-muted-foreground">{requestChangeSummary(request)}</p>
            {canDecide ? (
              <div className="flex gap-2">
                <Button
                  type="button"
                  size="sm"
                  disabled={busy !== null}
                  onClick={() => decide(request.requestId, "approve")}
                >
                  Approve
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={busy !== null}
                  onClick={() => decide(request.requestId, "decline")}
                >
                  Decline
                </Button>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                Only this machine's owner can approve it.
              </p>
            )}
          </li>
        ))}
        {error ? (
          <li role="alert" className="text-xs text-destructive-foreground">
            {error}
          </li>
        ) : null}
      </ul>
    </SettingsSection>
  );
}
