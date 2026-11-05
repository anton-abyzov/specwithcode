import { renderRich } from "../../i18n/rich";
import { useTx } from "../../i18n";
import type {
  GoogleAccountStatus,
  GoogleConnectedAccount,
  GoogleService,
  ProjectId,
} from "@specweave-studio/contracts";
import {
  AuthOrchestrationReadScope,
  AuthSettingsWriteScope,
  GOOGLE_ACCOUNT_LABEL_MAX,
  GOOGLE_CLIENT_ID_PATTERN,
  GOOGLE_CLIENT_SECRET_PATTERN,
  GOOGLE_READ_SERVICES,
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
import { useAideEnabled } from "../../hooks/useSettings";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { teamRulesToolLock } from "../../teamRules/teamRulesView";
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
import { TeamRulesInert, TeamRulesLockNote } from "./TeamRulesLock";

const SERVICE_LABELS: Record<GoogleService, string> = {
  gmail: "Gmail",
  calendar: "Calendar",
  drive: "Drive",
  gmailDrafts: "Gmail drafts",
};

const listServices = (services: ReadonlyArray<GoogleService>) =>
  services.map((service) => SERVICE_LABELS[service]).join(", ");

/** The saved accounts; a server from before several accounts reports one at the top level. */
const accountsOf = (status: GoogleAccountStatus | null): ReadonlyArray<GoogleConnectedAccount> => {
  if (status === null) return [];
  if (status.accounts !== undefined) return status.accounts;
  if (!status.connected && status.projects.length === 0) return [];
  return [
    {
      id: "primary",
      email: status.email,
      label: null,
      connected: status.connected,
      services: status.services,
      projects: status.projects,
      lastError: status.lastError,
    },
  ];
};

const accountTitle = (account: GoogleConnectedAccount) =>
  account.label
    ? `${account.label} · ${account.email ?? "Google account"}`
    : (account.email ?? "Google account");

export function GoogleAccountSettingsPanel() {
  const tx = useTx();
  const returnTo = useLocation({ select: (location) => location.href });
  const environmentId = usePrimaryEnvironmentId();
  const canRead = useEnvironmentScope(environmentId, AuthOrchestrationReadScope);
  const canWrite = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const configs = useServerConfigs();
  const config = environmentId === null ? undefined : configs.get(environmentId);
  // Disconnect stays outside every lock below, so access can always be removed.
  const teamRulesLock = teamRulesToolLock(config?.teamRules, "google");
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
  const setLabel = useAtomCommand(serverEnvironment.setGoogleAccountLabel, {
    reportFailure: false,
  });

  // Several accounts: the project switches below are for the one picked here.
  const accounts = accountsOf(status);
  const multiAccount = status?.accounts !== undefined;
  const [pickedAccount, setPickedAccount] = useState<string | null>(null);
  const selected =
    accounts.find((account) => account.id === pickedAccount) ??
    accounts.find((account) => account.connected) ??
    accounts[0] ??
    null;
  const scopedServices = selected?.connected ? selected.services : [];
  const scopedProjects = selected?.projects ?? [];
  const accountInput = multiAccount && selected !== null ? { account: selected.id } : {};
  const [labels, setLabels] = useState<ReadonlyMap<string, string>>(() => new Map());
  /** The account a project uses when its agents name none: its chosen one, else the first it may read. */
  const defaultAccountOf = (projectId: ProjectId) => {
    const chosen = status?.defaults?.find((entry) => entry.projectId === projectId)?.account;
    const readable = accounts.filter(
      (account) =>
        account.connected &&
        account.projects.some(
          (entry) =>
            entry.projectId === projectId &&
            entry.services.some((service) => account.services.includes(service)),
        ),
    );
    return (readable.find((account) => account.id === chosen) ?? readable[0])?.id ?? null;
  };

  const allProjects = useProjects();
  const scratchRoot = config?.scratchWorkspaceRoot ?? null;
  const aideEnabled = useAideEnabled();
  const statusAccounts = status?.accounts;
  const statusProjects = status?.projects;
  const projectsWithAccess = useMemo(
    () => [
      ...new Set(
        [...(statusAccounts?.flatMap((account) => account.projects) ?? statusProjects ?? [])]
          .filter((entry) => entry.services.length > 0)
          .map((entry) => entry.projectId),
      ),
    ],
    [statusAccounts, statusProjects],
  );
  const {
    active: projects,
    automated: automatedProjects,
    archived: archivedProjects,
  } = useMemo(
    () =>
      partitionGoogleProjects(
        allProjects.filter((project) => project.environmentId === environmentId),
        () => scratchRoot,
        { enabled: aideEnabled, keepIds: projectsWithAccess },
      ),
    [aideEnabled, allProjects, environmentId, projectsWithAccess, scratchRoot],
  );

  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [replacingClient, setReplacingClient] = useState(false);
  // Only the boxes the person changed; the rest follow what Google already granted,
  // so reconnecting to add Gmail drafts keeps every service already approved.
  const [choices, setChoices] = useState<ReadonlyMap<GoogleService, boolean>>(() => new Map());
  const granted = status?.connected ? status.services : [];
  const wantedFrom = (base: ReadonlyArray<GoogleService>) =>
    new Set(
      GOOGLE_SERVICES.filter(
        (service) =>
          choices.get(service) ??
          (base.includes(service) || GOOGLE_READ_SERVICES.includes(service)),
      ),
    );
  const wanted = wantedFrom(granted);
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

  /** Signs in again to `accountId`, or adds whichever account the person picks at Google. */
  const beginSignIn = (accountId?: string) => {
    if (environmentId === null) return;
    // Opened inside the click so the browser allows it; pointed at Google once the host answers.
    const tab = window.open("about:blank", "_blank");
    // Reconnecting keeps what that account granted; a new account starts from reading.
    const base =
      accountId === undefined
        ? []
        : (accountsOf(status).find((account) => account.id === accountId)?.services ?? granted);
    void run("Could not start Google sign-in", () =>
      startSignIn({
        environmentId,
        input: {
          services: [...wantedFrom(base)],
          ...(accountId === undefined || !multiAccount ? {} : { account: accountId }),
        },
      }),
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
    const current = scopedProjects.find((entry) => entry.projectId === projectId)?.services ?? [];
    const services = on
      ? [...new Set([...current, service])]
      : current.filter((entry) => entry !== service);
    void run("Could not change project access", () =>
      setProjectAccess({ environmentId, input: { projectId, services, ...accountInput } }),
    );
  };

  const makeDefault = (projectId: ProjectId) => {
    if (environmentId === null || selected === null) return;
    const services = scopedProjects.find((entry) => entry.projectId === projectId)?.services ?? [];
    void run("Could not change the default account", () =>
      setProjectAccess({
        environmentId,
        input: { projectId, services: [...services], account: selected.id, makeDefault: true },
      }),
    );
  };

  const saveLabel = (account: GoogleConnectedAccount) => {
    const label = labels.get(account.id);
    if (environmentId === null || label === undefined) return;
    void run("Could not rename the account", () =>
      setLabel({ environmentId, input: { account: account.id, label: label.trim() || null } }),
    ).then((result) => {
      // A refused rename keeps what the person typed.
      if (result === null) return;
      setLabels((current) => {
        const next = new Map(current);
        next.delete(account.id);
        return next;
      });
    });
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
          input: { projectId: change.projectId, services: [...change.services], ...accountInput },
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
    // Disabling also covers automated and archived projects, so nothing keeps reading behind a
    // collapsed list.
    const ids = on
      ? activeIds
      : [...activeIds, ...[...automatedProjects, ...archivedProjects].map((project) => project.id)];
    void applyChanges(
      on ? "Could not enable access" : "Could not disable access",
      bulkServiceChanges(scopedProjects, ids, service, on),
    );
  };
  // One click grants reading only; Gmail drafts writes, so it stays a per-project choice.
  const grantedReads = scopedServices.filter((service) => GOOGLE_READ_SERVICES.includes(service));
  const enableAllPending =
    status === null ? [] : enableAllChanges(scopedProjects, activeIds, grantedReads);

  const renderProjectRow = (project: (typeof projects)[number]) => {
    if (status === null) return null;
    const enabled = scopedProjects.find((entry) => entry.projectId === project.id)?.services ?? [];
    const isDefault = selected !== null && defaultAccountOf(project.id) === selected.id;
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
        <TeamRulesInert lock={teamRulesLock}>
          <div className="flex flex-wrap items-center gap-4">
            {GOOGLE_SERVICES.map((service) => {
              const granted = scopedServices.includes(service);
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
            {accounts.length > 1 && enabled.length > 0 && selected?.connected === true ? (
              isDefault ? (
                <Badge variant="secondary">{tx("Default account")}</Badge>
              ) : (
                <Button
                  size="xs"
                  variant="ghost-muted"
                  disabled={!canWrite || busy}
                  aria-label={`Make ${selected === null ? "this account" : accountTitle(selected)} the default for ${project.title}`}
                  onClick={() => makeDefault(project.id)}
                >
                  {tx("Make default")}
                </Button>
              )
            ) : null}
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
                {tx("Morning briefing")}
              </Button>
            ) : null}
          </div>
        </TeamRulesInert>
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
            <Badge variant="success">{tx("Connected")}</Badge>
          ) : status?.clientConfigured ? (
            <Badge variant="secondary">{tx("Not connected")}</Badge>
          ) : undefined
        }
      >
        <div className="flex flex-col gap-1 px-3 py-3 text-muted-foreground text-sm sm:px-4">
          <p>
            {tx(
              "Let a project's agents read your Gmail, Calendar and Drive, so a Personal project can brief you on your day, find a document or check who is coming to a meeting.",
            )}
          </p>
          <p className="text-xs">
            {tx(
              "Agents read. With Gmail drafts on they save reply drafts, and send one only when you choose Send for it on a reply card; they never change or delete anything. SpecWithCode talks Google from this machine, keeps the sign-in in a private file on this machine, and gives a project nothing until you turn it on below. Only your Personal project starts with access.",
            )}
          </p>
          {teamRulesLock ? <TeamRulesLockNote lock={teamRulesLock} /> : null}
        </div>

        {config !== undefined && !supported ? (
          <p className="px-3 py-3 text-muted-foreground text-sm sm:px-4">
            {renderRich(
              tx(
                "The SpecWithCode service this app is connected to (version {serverVersion}) is older than Google account support. Update that service to use it.",
              ),
              { serverVersion: config.environment.serverVersion },
            )}
          </p>
        ) : null}
        {query.error ? (
          <p className="px-3 py-3 text-destructive-foreground text-sm sm:px-4">{query.error}</p>
        ) : null}

        {status !== null && showClientForm && teamRulesLock === null ? (
          <div className="flex flex-col gap-3 border-t px-3 py-4 sm:px-4">
            <div className="flex flex-col gap-1">
              <span className="font-medium text-sm">{tx("Your own OAuth client")}</span>
              <span className="text-muted-foreground text-xs">
                {renderRich(
                  tx(
                    "{value}In Google Cloud Console, enable the Gmail, Google Calendar and Google Drive APIs, set up the consent screen, then create credentials of type {span} and application type {span2}. Paste its ID and secret here.",
                  ),
                  {
                    value: status.clientConfigured
                      ? "Optional. Use a client from your own Google Cloud project instead of SpecWithCode's, for example when your organisation only allows its own apps. "
                      : "This SpecWithCode build has no Google client of its own, so connecting needs one from your Google Cloud project. ",
                    span: <span className="font-medium">{tx("OAuth client ID")}</span>,
                    span2: <span className="font-medium">{tx("Desktop app")}</span>,
                  },
                )}
              </span>
            </div>
            <Input
              size="sm"
              autoComplete="off"
              spellCheck={false}
              aria-label={tx("Google OAuth client ID")}
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
              aria-label={tx("Google OAuth client secret")}
              placeholder="GOCSPX-..."
              value={clientSecret}
              disabled={!canWrite || busy}
              onChange={(event) => setClientSecret(event.target.value)}
            />
            {trimmedId !== "" && !GOOGLE_CLIENT_ID_PATTERN.test(trimmedId) ? (
              <span className="text-destructive-foreground text-xs">
                {tx("A client ID ends in .apps.googleusercontent.com.")}
              </span>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                disabled={!canWrite || busy || !clientLooksValid}
                onClick={saveClient}
              >
                {tx("Save client")}
              </Button>
              {replacingClient ? (
                <Button size="sm" variant="outline" onClick={() => setReplacingClient(false)}>
                  {tx("Cancel")}
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}

        {status?.clientConfigured && (!showClientForm || teamRulesLock !== null) ? (
          <div className="flex flex-col gap-3 border-t px-3 py-4 sm:px-4">
            {usesOwnClient ? (
              <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <span className="min-w-0 truncate text-muted-foreground">
                  {renderRich(tx("Your OAuth client {span}"), {
                    span: <span className="font-mono text-xs">{status.clientId}</span>,
                  })}
                </span>
                <TeamRulesInert lock={teamRulesLock}>
                  <Button
                    size="xs"
                    variant="ghost-muted"
                    disabled={!canWrite || busy}
                    onClick={() => setReplacingClient(true)}
                  >
                    {tx("Replace client")}
                  </Button>
                </TeamRulesInert>
              </div>
            ) : null}

            {accounts.length > 1 ? (
              <ul className="flex flex-col gap-2">
                {accounts.map((account) => {
                  const draft = labels.get(account.id);
                  return (
                    <li
                      key={account.id}
                      className="flex flex-col gap-2 rounded-md border px-3 py-2 text-sm"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="min-w-0 truncate">
                          <span className="font-medium">{accountTitle(account)}</span>
                          <span className="text-muted-foreground">
                            {" "}
                            ·{" "}
                            {account.connected
                              ? `reads ${listServices(account.services) || "nothing"}`
                              : tx("not connected")}
                          </span>
                        </span>
                        <div className="flex flex-wrap gap-1">
                          <TeamRulesInert lock={teamRulesLock}>
                            <Button
                              size="xs"
                              variant="ghost-muted"
                              disabled={!canWrite || busy || wanted.size === 0}
                              aria-label={`${account.connected ? "Reconnect" : "Connect"} ${accountTitle(account)}`}
                              onClick={() => beginSignIn(account.id)}
                            >
                              {account.connected ? tx("Reconnect") : tx("Connect")}
                            </Button>
                          </TeamRulesInert>
                          {account.connected ? (
                            <Button
                              size="xs"
                              variant="ghost-muted"
                              disabled={!canWrite || busy || environmentId === null}
                              aria-label={`Disconnect ${accountTitle(account)}`}
                              onClick={() => {
                                if (environmentId === null) return;
                                void run("Could not disconnect", () =>
                                  disconnect({ environmentId, input: { account: account.id } }),
                                );
                              }}
                            >
                              {tx("Disconnect")}
                            </Button>
                          ) : null}
                          <Button
                            size="xs"
                            variant="ghost-muted"
                            disabled={!canWrite || busy || environmentId === null}
                            aria-label={`Remove ${accountTitle(account)}`}
                            onClick={() => {
                              if (environmentId === null) return;
                              void run("Could not remove the account", () =>
                                disconnect({
                                  environmentId,
                                  input: { account: account.id, forget: true },
                                }),
                              );
                            }}
                          >
                            {tx("Remove")}
                          </Button>
                        </div>
                      </div>
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                        <Input
                          size="sm"
                          aria-label={`Label for ${account.email ?? "this account"}`}
                          placeholder={tx("Label, such as Work or Personal")}
                          maxLength={GOOGLE_ACCOUNT_LABEL_MAX}
                          value={draft ?? account.label ?? ""}
                          disabled={!canWrite || busy}
                          onChange={(event) =>
                            setLabels((current) =>
                              new Map(current).set(account.id, event.target.value),
                            )
                          }
                        />
                        {draft !== undefined && draft.trim() !== (account.label ?? "") ? (
                          <Button
                            size="xs"
                            variant="outline"
                            disabled={!canWrite || busy}
                            onClick={() => saveLabel(account)}
                          >
                            {tx("Save label")}
                          </Button>
                        ) : null}
                      </div>
                      {account.lastError ? (
                        <span className="text-destructive-foreground text-xs">
                          {account.lastError}
                        </span>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            ) : status.connected ? (
              <div className="flex flex-col gap-1 text-sm">
                <span>
                  {renderRich(tx("Signed in as {span}. SpecWithCode can read {value}."), {
                    span: <span className="font-medium">{status.email ?? tx("your account")}</span>,
                    value: listServices(status.services) || tx("nothing"),
                  })}
                </span>
                {status.lastError ? (
                  <span className="text-destructive-foreground text-xs">{status.lastError}</span>
                ) : null}
              </div>
            ) : (
              <div className="flex flex-col gap-1">
                <span className="font-medium text-sm">{tx("Connect your Google account")}</span>
                <span className="text-muted-foreground text-xs">
                  {tx(
                    "Pick what SpecWithCode may read. Gmail drafts lets your assistant save replies and send an exact copy only after you choose Send on its review card. The original draft stays in Gmail. Google asks you to confirm access in your browser.",
                  )}
                </span>
              </div>
            )}

            <TeamRulesInert lock={teamRulesLock}>
              <div className="flex flex-wrap items-center gap-4">
                {GOOGLE_SERVICES.map((service) => (
                  <label key={service} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={wanted.has(service)}
                      disabled={!canWrite || busy}
                      aria-label={`Ask Google for ${SERVICE_LABELS[service]}`}
                      onCheckedChange={(checked) =>
                        setChoices((current) => new Map(current).set(service, checked === true))
                      }
                    />
                    {SERVICE_LABELS[service]}
                  </label>
                ))}
              </div>
            </TeamRulesInert>

            <div className="flex flex-wrap gap-2">
              {accounts.length <= 1 ? (
                <TeamRulesInert lock={teamRulesLock}>
                  <Button
                    size="sm"
                    variant={status.connected ? "outline" : "default"}
                    disabled={!canWrite || busy || wanted.size === 0}
                    onClick={() => beginSignIn(accounts[0]?.id)}
                  >
                    {status.connected ? tx("Reconnect") : tx("Connect Google")}
                  </Button>
                </TeamRulesInert>
              ) : null}
              {multiAccount && status.connected ? (
                <TeamRulesInert lock={teamRulesLock}>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!canWrite || busy || wanted.size === 0}
                    onClick={() => beginSignIn()}
                  >
                    {tx("Add another Google account")}
                  </Button>
                </TeamRulesInert>
              ) : null}
              {status.connected && accounts.length <= 1 ? (
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
                  {tx("Disconnect")}
                </Button>
              ) : null}
            </div>

            {clientSource === "studio" && !status.connected ? (
              <span className="text-muted-foreground text-xs">
                {tx(
                  "If Google says it has not verified SpecWithCode yet, choose Advanced, then Go to SpecWithCode.",
                )}
              </span>
            ) : null}

            {status.signIn && teamRulesLock === null ? (
              <div className="flex flex-col gap-2 rounded-md border bg-muted/40 p-3 text-sm">
                <span>
                  {renderRich(
                    tx("Finish in the {a}. This page updates when Google sends you back."),
                    {
                      a: (
                        <a
                          className="underline"
                          href={status.signIn.authorizationUrl}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {tx("Google sign-in tab")}
                        </a>
                      ),
                    },
                  )}
                </span>
                <span className="text-muted-foreground text-xs">
                  {renderRich(
                    tx(
                      "Google returns to {redirectUri}. If SpecWithCode runs on another machine, that page will not load: copy the address from the browser and paste it here.",
                    ),
                    { redirectUri: status.signIn.redirectUri },
                  )}
                </span>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Input
                    size="sm"
                    autoComplete="off"
                    spellCheck={false}
                    aria-label={tx("Address Google sent you to")}
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
                    {tx("Finish sign-in")}
                  </Button>
                </div>
              </div>
            ) : null}
          </div>
        ) : null}

        {status?.connected ? (
          <div className="flex flex-col border-t">
            <div className="flex flex-col gap-1 px-3 pt-4 pb-2 sm:px-4">
              <span className="font-medium text-sm">
                {accounts.length > 1
                  ? tx("Projects that may read each account")
                  : tx("Projects that may read it")}
              </span>
              <span className="text-muted-foreground text-xs">
                {renderRich(
                  tx("Agents in a project see only the services you turn on for it.{value}"),
                  {
                    value:
                      accounts.length > 1
                        ? " Agents use the default account unless asked for another, and may read every account turned on here."
                        : "",
                  },
                )}
              </span>
              {accounts.length > 1 ? (
                <div
                  role="group"
                  aria-label={tx("Google account")}
                  className="flex flex-wrap gap-1 pt-1"
                >
                  {accounts.map((account) => (
                    <Button
                      key={account.id}
                      size="xs"
                      variant={account.id === selected?.id ? "default" : "outline"}
                      aria-pressed={account.id === selected?.id}
                      onClick={() => setPickedAccount(account.id)}
                    >
                      {accountTitle(account)}
                    </Button>
                  ))}
                </div>
              ) : null}
            </div>
            {offerEnableAll && enableAllPending.length > 0 ? (
              <div
                role="status"
                className="mx-3 mb-2 flex flex-col gap-2 rounded-md border bg-muted/40 p-3 text-sm sm:mx-4 sm:flex-row sm:items-center sm:justify-between"
              >
                <span>
                  {renderRich(
                    tx(
                      projects.length === 1
                        ? "Connected. Let the active project read {value2}?"
                        : "Connected. Let all {length} active projects read {value2}?",
                    ),
                    {
                      length: projects.length,
                      value2: listServices(grantedReads),
                    },
                  )}
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
                    {tx("Enable for all active projects")}
                  </Button>
                  <Button size="xs" variant="ghost-muted" onClick={() => setOfferEnableAll(false)}>
                    {tx("Not now")}
                  </Button>
                </div>
              </div>
            ) : null}
            {projects.length === 0 &&
            automatedProjects.length === 0 &&
            archivedProjects.length === 0 ? (
              <p className="px-3 pb-4 text-muted-foreground text-sm sm:px-4">
                {tx("Add a project first. A Personal project suits a personal agent.")}
              </p>
            ) : (
              <>
                {scopedServices.length > 0 && projects.length > 0 ? (
                  <div className="flex flex-col gap-1 border-b px-3 pb-2 sm:px-4">
                    {GOOGLE_SERVICES.filter((service) => scopedServices.includes(service)).map(
                      (service) => {
                        const label = SERVICE_LABELS[service];
                        const onCount = projects.filter((project) =>
                          scopedProjects
                            .find((entry) => entry.projectId === project.id)
                            ?.services.includes(service),
                        ).length;
                        const anyOn =
                          bulkServiceChanges(
                            scopedProjects,
                            [...projects, ...automatedProjects, ...archivedProjects].map(
                              (project) => project.id,
                            ),
                            service,
                            false,
                          ).length > 0;
                        return (
                          <div
                            key={service}
                            className="flex flex-wrap items-center justify-between gap-2 text-xs"
                          >
                            <span className="text-muted-foreground">
                              {renderRich(tx("{span} · {onCount} of {length} active"), {
                                span: <span className="font-medium text-foreground">{label}</span>,
                                onCount: onCount,
                                length: projects.length,
                              })}
                            </span>
                            <div className="flex gap-1">
                              <Button
                                size="xs"
                                variant="ghost-muted"
                                disabled={!canWrite || busy || onCount === projects.length}
                                aria-label={`Enable ${label} for all active projects`}
                                onClick={() => setServiceForAll(service, true)}
                              >
                                {tx("Enable for all active projects")}
                              </Button>
                              <Button
                                size="xs"
                                variant="ghost-muted"
                                disabled={!canWrite || busy || !anyOn}
                                aria-label={`Disable ${label} for all projects`}
                                onClick={() => setServiceForAll(service, false)}
                              >
                                {tx("Disable all")}
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
                    {tx("No active projects of your own here.")}
                  </p>
                )}
                <ArchivedDisclosure
                  count={automatedProjects.length}
                  label={tx("automated")}
                  className="pb-1"
                >
                  <ul className="flex flex-col">{automatedProjects.map(renderProjectRow)}</ul>
                </ArchivedDisclosure>
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
              {tx("Use your own OAuth client")}
            </Button>
          </div>
        ) : null}

        {status?.connected || usesOwnClient || (status?.projects.length ?? 0) > 0 ? (
          <div className="flex flex-wrap items-center justify-between gap-2 border-t px-3 py-3 sm:px-4">
            <span className="text-muted-foreground text-xs">
              {tx(
                "Remove forgets every sign-in, your own OAuth client if you saved one, and every project's access on this machine.",
              )}
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
              {tx("Remove")}
            </Button>
          </div>
        ) : null}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
