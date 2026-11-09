/**
 * Access requests other machines sent for Away mode, on every machine this
 * window is connected to. The watcher loads them app-wide and raises a toast
 * when one arrives; Settings > Machines shows one card per machine with
 * pending requests. Approve runs on that machine's own server and applies the
 * stored grant changes there; the card describes them from that machine's own
 * data (its project titles), never from text the sender wrote. Nothing is
 * approved automatically.
 */
import {
  AuthAccessReadScope,
  AuthAccessWriteScope,
  type EnvironmentId,
} from "@specweave-studio/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";

import { useProjects } from "../../state/entities";
import { useConnectedEnvironmentIds } from "../../state/environments";
import { useEnvironmentScope, useEnvironmentsWithScope } from "../../state/session";
import { useMachineNicknames } from "../../studio/machineNickname";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { stackedThreadToast } from "../ui/toastHelpers";
import { SettingsSection } from "../settings/settingsLayout";
import {
  accessRequestToastTitle,
  approveChangeLines,
  manualStepLines,
  pendingAccessRequests,
  requestChangeSummary,
  unseenRequests,
} from "./awayAccessRequests.logic";
import {
  loadEnvironmentAccessRequests,
  markAccessRequestsAnnounced,
  useAwayAccessRequestsStore,
  useEnvironmentAccessRequests,
} from "./awayAccessRequestsStore";
import { awayRpc, runAway } from "./awayRpc";

const REFRESH_MS = 30_000;

/** Connected machines whose access requests this window may read. */
function useReadableEnvironmentIds(): readonly EnvironmentId[] {
  const connected = useConnectedEnvironmentIds();
  const environments = useMemo(
    () => connected.map((environmentId) => ({ environmentId })),
    [connected],
  );
  const readable = useEnvironmentsWithScope(environments, AuthAccessReadScope);
  return useMemo(() => connected.filter((id) => readable.has(id)), [connected, readable]);
}

/** App-wide: keeps every connected machine's requests loaded and announces new ones. */
export function AwayAccessRequestsWatcher() {
  const ids = useReadableEnvironmentIds();
  return (
    <>
      {ids.map((environmentId) => (
        <AccessRequestPoller key={environmentId} environmentId={environmentId} />
      ))}
    </>
  );
}

function AccessRequestPoller({ environmentId }: { environmentId: EnvironmentId }) {
  const name = useMachineNicknames();
  const navigate = useNavigate();
  useEffect(() => {
    let live = true;
    const poll = async () => {
      const requests = await loadEnvironmentAccessRequests(environmentId);
      if (!live || requests === null) return;
      const fresh = unseenRequests(requests, useAwayAccessRequestsStore.getState().announced);
      if (fresh.length === 0) return;
      markAccessRequestsAnnounced(fresh.map((request) => request.requestId));
      toastManager.add(
        stackedThreadToast({
          type: "info",
          title: accessRequestToastTitle(
            fresh,
            (from) => name(from, fresh.find((r) => r.fromEnvironmentId === from)?.fromLabel),
            name(environmentId),
          ),
          description: "Approve or decline it in Settings > Machines.",
          timeout: 0,
          priority: "high",
          actionProps: {
            children: "Review",
            onClick: () => void navigate({ to: "/settings/machines" }),
          },
        }),
      );
    };
    void poll();
    const timer = setInterval(() => void poll(), REFRESH_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [environmentId, name, navigate]);
  return null;
}

/** Settings > Machines: one card per connected machine with pending requests. */
export function AwayAccessRequestsAll() {
  const ids = useReadableEnvironmentIds();
  return (
    <>
      {ids.map((environmentId) => (
        <AwayAccessRequests key={environmentId} environmentId={environmentId} />
      ))}
    </>
  );
}

export function AwayAccessRequests({ environmentId }: { environmentId: EnvironmentId }) {
  const canRead = useEnvironmentScope(environmentId, AuthAccessReadScope);
  const canDecide = useEnvironmentScope(environmentId, AuthAccessWriteScope);
  const requests = useEnvironmentAccessRequests(environmentId);
  const allProjects = useProjects();
  const projects = useMemo(
    () => allProjects.filter((project) => project.environmentId === environmentId),
    [allProjects, environmentId],
  );
  const name = useMachineNicknames();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (canRead) void loadEnvironmentAccessRequests(environmentId);
  }, [canRead, environmentId]);

  const decide = (requestId: string, decision: "approve" | "decline") => {
    setBusy(requestId);
    setError(null);
    void runAway(awayRpc.decideAccess, { environmentId, input: { requestId, decision } }).then(
      (next) => {
        setBusy(null);
        if (!next.ok) setError(next.error);
        void loadEnvironmentAccessRequests(environmentId);
      },
    );
  };

  const pending = pendingAccessRequests(requests);
  if (!canRead || pending.length === 0) return null;
  const machine = name(environmentId);
  return (
    <SettingsSection
      title={`Access requests on ${machine}`}
      literal
      data-testid="away-access-requests"
      data-environment-id={environmentId}
    >
      <ul className="flex flex-col gap-3 p-4 text-sm">
        {pending.map((request) => {
          const from = name(request.fromEnvironmentId, request.fromLabel);
          const changes = approveChangeLines(request, projects);
          const steps = manualStepLines(request, projects);
          return (
            <li key={request.requestId} className="flex flex-col gap-2">
              <p className="font-medium">{`${from} asks to leave its work on ${machine}.`}</p>
              {changes.length > 0 ? (
                <ul className="flex list-disc flex-col gap-1 pl-5 text-xs">
                  {changes.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              ) : null}
              <p className="text-xs text-muted-foreground">{requestChangeSummary(request)}</p>
              {steps.length > 0 ? (
                <>
                  <p className="text-xs text-muted-foreground">Still to do by hand here:</p>
                  <ul className="flex list-disc flex-col gap-1 pl-5 text-xs text-muted-foreground">
                    {steps.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                </>
              ) : null}
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
                  {`Only ${machine}'s owner can approve it.`}
                </p>
              )}
            </li>
          );
        })}
        {error ? (
          <li role="alert" className="text-xs text-destructive-foreground">
            {error}
          </li>
        ) : null}
      </ul>
    </SettingsSection>
  );
}
