import type { GoogleService, ProjectId } from "@specweave-studio/contracts";
import {
  AuthOrchestrationReadScope,
  AuthSettingsWriteScope,
  GOOGLE_CLIENT_ID_PATTERN,
  GOOGLE_CLIENT_SECRET_PATTERN,
  GOOGLE_SERVICES,
} from "@specweave-studio/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@specweave-studio/client-runtime/state/runtime";
import { Link, useLocation } from "@tanstack/react-router";
import { MailIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { useProjects, useServerConfigs } from "../../state/entities";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { ArchivedDisclosure } from "./ArchivedDisclosure";
import {
  bulkServiceChanges,
  enableAllChanges,
  partitionGoogleProjects,
} from "./googleAccountSettings.logic";
import { MORNING_BRIEFING_TEMPLATE } from "./scheduledTasksSettings.logic";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";

const SERVICE_LABELS: Record<GoogleService, string> = {
  gmail: "Gmail",
  calendar: "Calendar",
  drive: "Drive",
};

const listServices = (services: ReadonlyArray<GoogleService>) =>
  services.map((service) => SERVICE_LABELS[service]).join(", ");

export function GoogleAccountSettingsPanel() {
  const returnTo = useLocation({ select: (location) => location.href });
  const environmentId = usePrimaryEnvironmentId();
  const canRead = useEnvironmentScope(environmentId, AuthOrchestrationReadScope);
  const canWrite = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const configs = useServerConfigs();
  const config = environmentId === null ? undefined : configs.get(environmentId);
  const supported = config?.environment.capabilities.googleAccount === true;
  const query = useEnvironmentQuery(
    environmentId === null || !canRead || !supported
      ? null
      : serverEnvironment.googleAccountStatus({ environmentId, input: {} }),
  );
  const status = query.data ?? null;
  const configureClient = useAtomCommand(serverEnvironment.configureGoogleClient, {
    reportFailure: false,
  });
  const startSignIn = useAtomCommand(serverEnvironment.startGoogleSignIn, { reportFailure: false });
  const completeSignIn = useAtomCommand(serverEnvironment.completeGoogleSignIn, {
    reportFailure: false,
  });
  const setProjectAccess = useAtomCommand(serverEnvironment.setGoogleProjectAccess, {
    reportFailure: false,
  });
  const disconnect = useAtomCommand(serverEnvironment.disconnectGoogleAccount, {
    reportFailure: false,
  });
  const remove = useAtomCommand(serverEnvironment.removeGoogleAccount, { reportFailure: false });

  const allProjects = useProjects();
  const scratchRoot = config?.scratchWorkspaceRoot ?? null;
  const { active: projects, archived: archivedProjects } = useMemo(
    () =>
      partitionGoogleProjects(
        allProjects.filter((project) => project.environmentId === environmentId),
        () => scratchRoot,
      ),
    [allProjects, environmentId, scratchRoot],
  );

  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [replacingClient, setReplacingClient] = useState(false);
  const [wanted, setWanted] = useState<ReadonlySet<GoogleService>>(() => new Set(GOOGLE_SERVICES));
  const [pasted, setPasted] = useState("");
  const [busy, setBusy] = useState(false);

  // While Google's consent screen is open in another tab, re-read so the result shows up here.
  const signingIn = status?.signIn != null;
  const { refresh } = query;
  useEffect(() => {
    if (!signingIn) return;
    const timer = window.setInterval(refresh, 3_000);
    return () => window.clearInterval(timer);
  }, [signingIn, refresh]);

  // Access starts off; right after an account connects, offer every active project in one click.
  const connected = status?.connected;
  const [seenConnected, setSeenConnected] = useState(connected);
  const [offerEnableAll, setOfferEnableAll] = useState(false);
  if (connected !== undefined && connected !== seenConnected) {
    setSeenConnected(connected);
    setOfferEnableAll(seenConnected === false && connected);
  }

  const run = async <A,>(
    title: string,
    action: () => Promise<AtomCommandResult<A, unknown>>,
  ): Promise<AtomCommandResult<A, unknown> | null> => {
    setBusy(true);
    try {
      const result = await action();
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const failure = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title,
          description: failure instanceof Error ? failure.message : "The host refused the change.",
        });
        return null;
      }
      return result;
    } finally {
      setBusy(false);
      refresh();
    }
  };

  const trimmedId = clientId.trim();
  const trimmedSecret = clientSecret.trim();
  const clientLooksValid =
    GOOGLE_CLIENT_ID_PATTERN.test(trimmedId) && GOOGLE_CLIENT_SECRET_PATTERN.test(trimmedSecret);
  const showClientForm = status !== null && (!status.clientConfigured || replacingClient);
  // Services that predate Studio's own client report none; any client there is the person's.
  const clientSource = status?.clientSource ?? (status?.clientConfigured ? "own" : null);
  const usesOwnClient = clientSource === "own";

  const saveClient = () => {
    if (environmentId === null) return;
    void run("Could not save the OAuth client", () =>
      configureClient({
        environmentId,
        input: { clientId: trimmedId, clientSecret: trimmedSecret },
      }),
    ).then((result) => {
      if (result === null) return;
      setClientId("");
      setClientSecret("");
      setReplacingClient(false);
    });
  };

  const beginSignIn = () => {
    if (environmentId === null) return;
    // Opened inside the click so the browser allows it; pointed at Google once the host answers.
    const tab = window.open("about:blank", "_blank");
    void run("Could not start Google sign-in", () =>
      startSignIn({ environmentId, input: { services: [...wanted] } }),
    ).then((result) => {
      const url = result?._tag === "Success" ? result.value.signIn?.authorizationUrl : undefined;
      if (url && tab) tab.location.href = url;
      else tab?.close();
    });
  };

  const finishFromPaste = () => {
    if (environmentId === null) return;
    void run("Could not finish Google sign-in", () =>
      completeSignIn({ environmentId, input: { callbackUrl: pasted.trim() } }),
    ).then((result) => {
      if (result !== null) setPasted("");
    });
  };

  const toggleService = (projectId: ProjectId, service: GoogleService, on: boolean) => {
    if (environmentId === null || status === null) return;
    const current = status.projects.find((entry) => entry.projectId === projectId)?.services ?? [];
    const services = on
      ? [...new Set([...current, service])]
      : current.filter((entry) => entry !== service);
    void run("Could not change project access", () =>
      setProjectAccess({ environmentId, input: { projectId, services } }),
    );
  };

  const applyChanges = async (
    title: string,
    changes: ReadonlyArray<{ projectId: ProjectId; services: ReadonlyArray<GoogleService> }>,
  ) => {
    if (environmentId === null || changes.length === 0) return;
    setBusy(true);
    try {
      for (const change of changes) {
        const result = await setProjectAccess({
          environmentId,
          input: { projectId: change.projectId, services: [...change.services] },
        });
        if (result._tag === "Failure") {
          if (!isAtomCommandInterrupted(result)) {
            const failure = squashAtomCommandFailure(result);
            toastManager.add({
              type: "error",
              title,
              description:
                failure instanceof Error ? failure.message : "The host refused the change.",
            });
          }
          return;
        }
      }
    } finally {
      setBusy(false);
      refresh();
    }
  };

  const activeIds = projects.map((project) => project.id);
  const setServiceForAll = (service: GoogleService, on: boolean) => {
    if (status === null) return;
    // Disabling also covers archived projects, so nothing keeps reading behind a collapsed list.
    const ids = on ? activeIds : [...activeIds, ...archivedProjects.map((project) => project.id)];
    void applyChanges(
      on ? "Could not enable access" : "Could not disable access",
      bulkServiceChanges(status.projects, ids, service, on),
    );
  };
  const enableAllPending =
    status === null ? [] : enableAllChanges(status.projects, activeIds, status.services);

  const renderProjectRow = (project: (typeof projects)[number]) => {
    if (status === null) return null;
    const enabled = status.projects.find((entry) => entry.projectId === project.id)?.services ?? [];
    return (
      <li
        key={project.id}
        className="flex flex-col gap-2 px-3 py-2 sm:flex-row sm:items-center sm:justify-between sm:px-4"
      >
        <span className="min-w-0 truncate text-sm">
          {project.title}
          {project.workspaceSettings?.kind === "personal" ? (
            <span className="text-muted-foreground"> (personal)</span>
          ) : null}
        </span>
        <div className="flex flex-wrap items-center gap-4">
          {GOOGLE_SERVICES.map((service) => {
            const granted = status.services.includes(service);
            return (
              <label
                key={service}
                className="flex items-center gap-1.5 text-muted-foreground text-xs"
              >
                <Switch
                  size="sm"
                  checked={granted && enabled.includes(service)}
                  disabled={!canWrite || busy || !granted}
                  aria-label={`${SERVICE_LABELS[service]} for ${project.title}`}
                  onCheckedChange={(on) => toggleService(project.id, service, on)}
                />
                {SERVICE_LABELS[service]}
              </label>
            );
          })}
          {enabled.length > 0 ? (
            <Button
              size="xs"
              variant="ghost-muted"
              render={
                <Link
                  to="/settings/scheduled-tasks"
                  search={{
                    template: MORNING_BRIEFING_TEMPLATE,
                    projectId: project.id,
                    returnTo,
                  }}
                />
              }
            >
              Morning briefing
            </Button>
          ) : null}
        </div>
      </li>
    );
  };

  return (
    <SettingsPageContainer>
      <SettingsSection
        title="Google account"
        icon={<MailIcon className="size-4" />}
        id="google-account"
        headerAction={
          status?.connected ? (
            <Badge variant="success">Connected</Badge>
          ) : status?.clientConfigured ? (
            <Badge variant="secondary">Not connected</Badge>
          ) : undefined
        }
      >
        <div className="flex flex-col gap-1 px-3 py-3 text-muted-foreground text-sm sm:px-4">
          <p>
            Let a project&apos;s agents read your Gmail, Calendar and Drive, so a Personal project
            can brief you on your day, find a document or check who is coming to a meeting.
          </p>
          <p className="text-xs">
            Access is read-only: agents cannot send, change or delete anything. SpecWithCode talks
            Google from this machine, keeps the sign-in in a private file on this machine, and gives
            a project nothing until you turn it on below. Only your Personal project starts with
            access.
          </p>
        </div>

        {config !== undefined && !supported ? (
          <p className="px-3 py-3 text-muted-foreground text-sm sm:px-4">
            The SpecWithCode service this app is connected to (version{" "}
            {config.environment.serverVersion}) is older than Google account support. Update that
            service to use it.
          </p>
        ) : null}
        {query.error ? (
          <p className="px-3 py-3 text-destructive-foreground text-sm sm:px-4">{query.error}</p>
        ) : null}

        {status !== null && showClientForm ? (
          <div className="flex flex-col gap-3 border-t px-3 py-4 sm:px-4">
            <div className="flex flex-col gap-1">
              <span className="font-medium text-sm">Your own OAuth client</span>
              <span className="text-muted-foreground text-xs">
                {status.clientConfigured
                  ? "Optional. Use a client from your own Google Cloud project instead of SpecWithCode's, for example when your organisation only allows its own apps. "
                  : "This SpecWithCode build has no Google client of its own, so connecting needs one from your Google Cloud project. "}
                In Google Cloud Console, enable the Gmail, Google Calendar and Google Drive APIs,
                set up the consent screen, then create credentials of type{" "}
                <span className="font-medium">OAuth client ID</span> and application type{" "}
                <span className="font-medium">Desktop app</span>. Paste its ID and secret here.
              </span>
            </div>
            <Input
              size="sm"
              autoComplete="off"
              spellCheck={false}
              aria-label="Google OAuth client ID"
              placeholder="1234567890-abc123.apps.googleusercontent.com"
              value={clientId}
              disabled={!canWrite || busy}
              onChange={(event) => setClientId(event.target.value)}
            />
            <Input
              size="sm"
              type="password"
              autoComplete="off"
              spellCheck={false}
              aria-label="Google OAuth client secret"
              placeholder="GOCSPX-..."
              value={clientSecret}
              disabled={!canWrite || busy}
              onChange={(event) => setClientSecret(event.target.value)}
            />
            {trimmedId !== "" && !GOOGLE_CLIENT_ID_PATTERN.test(trimmedId) ? (
              <span className="text-destructive-foreground text-xs">
                A client ID ends in .apps.googleusercontent.com.
              </span>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                disabled={!canWrite || busy || !clientLooksValid}
                onClick={saveClient}
              >
                Save client
              </Button>
              {replacingClient ? (
                <Button size="sm" variant="outline" onClick={() => setReplacingClient(false)}>
                  Cancel
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}

        {status?.clientConfigured && !showClientForm ? (
          <div className="flex flex-col gap-3 border-t px-3 py-4 sm:px-4">
            {usesOwnClient ? (
              <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <span className="min-w-0 truncate text-muted-foreground">
                  Your OAuth client <span className="font-mono text-xs">{status.clientId}</span>
                </span>
                <Button
                  size="xs"
                  variant="ghost-muted"
                  disabled={!canWrite || busy}
                  onClick={() => setReplacingClient(true)}
                >
                  Replace client
                </Button>
              </div>
            ) : null}

            {status.connected ? (
              <div className="flex flex-col gap-1 text-sm">
                <span>
                  Signed in as <span className="font-medium">{status.email ?? "your account"}</span>
                  . SpecWithCode can read {listServices(status.services) || "nothing"}.
                </span>
                {status.lastError ? (
                  <span className="text-destructive-foreground text-xs">{status.lastError}</span>
                ) : null}
              </div>
            ) : (
              <div className="flex flex-col gap-1">
                <span className="font-medium text-sm">Connect your Google account</span>
                <span className="text-muted-foreground text-xs">
                  Pick what SpecWithCode may read. Google asks you to confirm in your browser.
                </span>
              </div>
            )}

            <div className="flex flex-wrap items-center gap-4">
              {GOOGLE_SERVICES.map((service) => (
                <label key={service} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={wanted.has(service)}
                    disabled={!canWrite || busy}
                    aria-label={`Ask Google for ${SERVICE_LABELS[service]}`}
                    onCheckedChange={(checked) =>
                      setWanted((current) => {
                        const next = new Set(current);
                        if (checked === true) next.add(service);
                        else next.delete(service);
                        return next;
                      })
                    }
                  />
                  {SERVICE_LABELS[service]}
                </label>
              ))}
            </div>

            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant={status.connected ? "outline" : "default"}
                disabled={!canWrite || busy || wanted.size === 0}
                onClick={beginSignIn}
              >
                {status.connected ? "Reconnect" : "Connect Google"}
              </Button>
              {status.connected ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!canWrite || busy || environmentId === null}
                  onClick={() => {
                    if (environmentId === null) return;
                    void run("Could not disconnect", () =>
                      disconnect({ environmentId, input: {} }),
                    );
                  }}
                >
                  Disconnect
                </Button>
              ) : null}
            </div>

            {clientSource === "studio" && !status.connected ? (
              <span className="text-muted-foreground text-xs">
                If Google says it has not verified SpecWithCode yet, choose Advanced, then Go to
                SpecWithCode.
              </span>
            ) : null}

            {status.signIn ? (
              <div className="flex flex-col gap-2 rounded-md border bg-muted/40 p-3 text-sm">
                <span>
                  Finish in the{" "}
                  <a
                    className="underline"
                    href={status.signIn.authorizationUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Google sign-in tab
                  </a>
                  . This page updates when Google sends you back.
                </span>
                <span className="text-muted-foreground text-xs">
                  Google returns to {status.signIn.redirectUri}. If SpecWithCode runs on another
                  machine, that page will not load: copy the address from the browser and paste it
                  here.
                </span>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Input
                    size="sm"
                    autoComplete="off"
                    spellCheck={false}
                    aria-label="Address Google sent you to"
                    placeholder="http://127.0.0.1:…/api/google/oauth/callback?state=…&code=…"
                    value={pasted}
                    disabled={!canWrite || busy}
                    onChange={(event) => setPasted(event.target.value)}
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!canWrite || busy || !pasted.includes("code=")}
                    onClick={finishFromPaste}
                  >
                    Finish sign-in
                  </Button>
                </div>
              </div>
            ) : null}
          </div>
        ) : null}

        {status?.connected ? (
          <div className="flex flex-col border-t">
            <div className="flex flex-col gap-1 px-3 pt-4 pb-2 sm:px-4">
              <span className="font-medium text-sm">Projects that may read it</span>
              <span className="text-muted-foreground text-xs">
                Agents in a project see only the services you turn on for it.
              </span>
            </div>
            {offerEnableAll && enableAllPending.length > 0 ? (
              <div
                role="status"
                className="mx-3 mb-2 flex flex-col gap-2 rounded-md border bg-muted/40 p-3 text-sm sm:mx-4 sm:flex-row sm:items-center sm:justify-between"
              >
                <span>
                  Connected. Let all {projects.length} active{" "}
                  {projects.length === 1 ? "project" : "projects"} read{" "}
                  {listServices(status.services)}?
                </span>
                <div className="flex gap-2">
                  <Button
                    size="xs"
                    disabled={!canWrite || busy}
                    onClick={() => {
                      setOfferEnableAll(false);
                      void applyChanges("Could not enable access", enableAllPending);
                    }}
                  >
                    Enable for all active projects
                  </Button>
                  <Button size="xs" variant="ghost-muted" onClick={() => setOfferEnableAll(false)}>
                    Not now
                  </Button>
                </div>
              </div>
            ) : null}
            {projects.length === 0 && archivedProjects.length === 0 ? (
              <p className="px-3 pb-4 text-muted-foreground text-sm sm:px-4">
                Add a project first. A Personal project suits a personal agent.
              </p>
            ) : (
              <>
                {status.services.length > 0 && projects.length > 0 ? (
                  <div className="flex flex-col gap-1 border-b px-3 pb-2 sm:px-4">
                    {GOOGLE_SERVICES.filter((service) => status.services.includes(service)).map(
                      (service) => {
                        const label = SERVICE_LABELS[service];
                        const onCount = projects.filter((project) =>
                          status.projects
                            .find((entry) => entry.projectId === project.id)
                            ?.services.includes(service),
                        ).length;
                        const anyOn =
                          bulkServiceChanges(
                            status.projects,
                            [...projects, ...archivedProjects].map((project) => project.id),
                            service,
                            false,
                          ).length > 0;
                        return (
                          <div
                            key={service}
                            className="flex flex-wrap items-center justify-between gap-2 text-xs"
                          >
                            <span className="text-muted-foreground">
                              <span className="font-medium text-foreground">{label}</span> ·{" "}
                              {onCount} of {projects.length} active
                            </span>
                            <div className="flex gap-1">
                              <Button
                                size="xs"
                                variant="ghost-muted"
                                disabled={!canWrite || busy || onCount === projects.length}
                                aria-label={`Enable ${label} for all active projects`}
                                onClick={() => setServiceForAll(service, true)}
                              >
                                Enable for all active projects
                              </Button>
                              <Button
                                size="xs"
                                variant="ghost-muted"
                                disabled={!canWrite || busy || !anyOn}
                                aria-label={`Disable ${label} for all projects`}
                                onClick={() => setServiceForAll(service, false)}
                              >
                                Disable all
                              </Button>
                            </div>
                          </div>
                        );
                      },
                    )}
                  </div>
                ) : null}
                {projects.length > 0 ? (
                  <ul className="flex flex-col py-2">{projects.map(renderProjectRow)}</ul>
                ) : (
                  <p className="px-3 py-2 text-muted-foreground text-sm sm:px-4">
                    Every project here is archived.
                  </p>
                )}
                <ArchivedDisclosure count={archivedProjects.length} className="pb-2">
                  <ul className="flex flex-col">{archivedProjects.map(renderProjectRow)}</ul>
                </ArchivedDisclosure>
              </>
            )}
          </div>
        ) : null}

        {status !== null && clientSource === "studio" && !showClientForm ? (
          <div className="border-t px-3 py-3 sm:px-4">
            <Button
              size="xs"
              variant="ghost-muted"
              disabled={!canWrite || busy}
              onClick={() => setReplacingClient(true)}
            >
              Use your own OAuth client
            </Button>
          </div>
        ) : null}

        {status?.connected || usesOwnClient || (status?.projects.length ?? 0) > 0 ? (
          <div className="flex flex-wrap items-center justify-between gap-2 border-t px-3 py-3 sm:px-4">
            <span className="text-muted-foreground text-xs">
              Remove forgets the sign-in, your own OAuth client if you saved one, and every
              project&apos;s access on this machine.
            </span>
            <Button
              size="xs"
              variant="destructive-outline"
              disabled={!canWrite || busy || environmentId === null}
              onClick={() => {
                if (environmentId === null) return;
                void run("Could not remove the Google account", () =>
                  remove({ environmentId, input: {} }),
                );
              }}
            >
              Remove
            </Button>
          </div>
        ) : null}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
