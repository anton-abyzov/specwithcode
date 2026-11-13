import { useAtomValue } from "@effect/atom-react";
import {
  defaultInstanceIdForDriver,
  type AcpRegistryUrlAuthAction,
  type EnvironmentId,
  type ProviderInstanceConfig,
  type ProviderInstanceId,
  type ServerProvider,
  type ServerProviderAuth,
} from "@specweave-studio/contracts";
import { teamRulesProviderAllowed } from "@specweave-studio/shared/teamRules";
import { ExternalLinkIcon } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { useTx } from "../../i18n";
import { renderRich } from "../../i18n/rich";
import {
  agentSignInAccount,
  canInstallOnboardingAgent,
  resolveAgentSignInCommand,
  resolveOnboardingProviderInstallCommand,
} from "../../onboarding/providerReadiness.logic";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { teamRulesProviderLock } from "../../teamRules/teamRulesView";
import { useTeamRules } from "../../teamRules/useTeamRules";
import { AgentCommand, AgentRowStatus } from "../onboarding/AgentRow";
import {
  AGENT_CHECK_TIMEOUT_MS,
  AgentSetupPanel,
  agentSetupPanelKey,
  useAgentSetupPanel,
  useDetachedInstall,
} from "../onboarding/AgentSetupPanel";
import { useHeldFor } from "../onboarding/WizardFrame";
import { Button } from "../ui/button";
import { ClaudeSignIn } from "./ClaudeSignIn";
import { useFoundAgentPath } from "./FoundAgents";
import { getProviderStatusView, getProviderVersionLabel } from "./providerStatus";
import { RedactedSensitiveText } from "./RedactedSensitiveText";
import { TeamRulesLabel } from "./settingsLayout";

function savedCommand(config: unknown): string | null {
  if (config === null || typeof config !== "object" || !("binaryPath" in config)) return null;
  const path = config.binaryPath;
  return typeof path === "string" && path.trim() !== "" ? path.trim() : null;
}

function AccountName({ auth }: { readonly auth: ServerProviderAuth }) {
  const email = auth.email?.trim();
  if (!email) return auth.login?.trim() ?? null;
  return (
    <RedactedSensitiveText
      value={email}
      ariaLabel="Toggle account email visibility"
      revealTooltip="Click to reveal email"
      hideTooltip="Click to hide email"
      className="break-all"
    />
  );
}

/** While an install left running has not landed, its machine is read this often. */
const DETACHED_INSTALL_READ_MS = 5_000;

/**
 * The selected agent's status in Settings > Providers: where it stands, whose
 * account it uses, its version and command, and the one button that moves it
 * toward ready. A sign-in the app can run shows right under it.
 */
export function ProviderStatusRow({
  environmentId,
  environmentLabel,
  instanceId,
  instance,
  provider,
  enabled,
  readOnly,
  name,
  registryAgentId,
  setupBlock,
  onTurnOn,
  onAcceptUrlAuth,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly instanceId: ProviderInstanceId;
  readonly instance: ProviderInstanceConfig;
  readonly provider: ServerProvider | undefined;
  readonly enabled: boolean;
  readonly readOnly: boolean;
  readonly name: string;
  /** The registry's id for an agent added from it. */
  readonly registryAgentId?: string | undefined;
  /**
   * The sign-in or install this agent already has in the app, when it has one.
   * It shows under the row while the agent needs it, in place of a button.
   */
  readonly setupBlock?: ReactNode;
  readonly onTurnOn: () => void;
  readonly onAcceptUrlAuth?: ((action: AcpRegistryUrlAuthAction) => void) | undefined;
}) {
  const tx = useTx();
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const [checkingAgain, setCheckingAgain] = useState(false);
  const panel = useAgentSetupPanel({
    environmentId,
    providers: provider ? [provider] : null,
    serverConfig,
    // The row reads as checking until the machine answers, so Install is not offered twice.
    onInstallClosed: () => {
      setCheckingAgain(true);
      // A read already under way began before the install, so this one is asked for fresh.
      void Promise.resolve(
        refreshProviders({ environmentId, input: { instanceId, fresh: true } }),
      ).finally(() => setCheckingAgain(false));
    },
  });
  const agent = registryAgentId ?? String(instance.driver);
  const foundPath = useFoundAgentPath(environmentId, agent);
  const detached = useDetachedInstall(environmentId, instanceId);
  const view = getProviderStatusView(provider, enabled, tx);
  // A sign-in in progress stays on screen while the machine reads the agent again.
  const [signingIn, setSigningIn] = useState(false);
  if (view.state === "ready" && signingIn) setSigningIn(false);
  else if (view.action === "signIn" && !signingIn) setSigningIn(true);
  const claude = instance.driver === "claudeAgent";
  // Claude's sign-in is the row's own, and stays while the machine reads Claude again.
  const readingAgain =
    view.state === "checking" || view.state === "noAnswer" || view.state === "attention";
  const showSignIn =
    !readOnly && (view.action === "signIn" || (claude && signingIn && readingAgain));
  const teamRules = useTeamRules(environmentId);
  const driver = String(instance.driver);
  const turnOnLockedBy = teamRulesProviderAllowed(teamRules.state, driver)
    ? null
    : (teamRulesProviderLock(teamRules.summary, driver) ?? "");

  const os = serverConfig?.environment.platform.os;
  const settings = serverConfig?.settings;
  const signInCommand =
    provider && settings && os ? resolveAgentSignInCommand(provider, settings, os) : null;
  const hasSetupBlock = setupBlock !== undefined && setupBlock !== null && setupBlock !== false;
  const installsInApp = hasSetupBlock && provider?.setup?.canInstall === true;
  // An install this row started is still running with its panel gone: read until it lands.
  const installLeftRunning = detached.until !== null && panel.session === null;
  const checking = checkingAgain || panel.checkingInstance === instanceId || installLeftRunning;
  const installLanded = view.state !== "notInstalled" && view.state !== "checking";
  const { until: detachedUntil, forget: forgetDetached } = detached;
  useEffect(() => {
    if (!installLeftRunning || detachedUntil === null) return;
    // An install that landed, or never does, gives the row its button back.
    const done = () => installLanded || Date.now() >= detachedUntil;
    if (done()) {
      forgetDetached();
      return;
    }
    const timer = setInterval(() => {
      if (done()) {
        forgetDetached();
        return;
      }
      void refreshProviders({ environmentId, input: { instanceId } });
    }, DETACHED_INSTALL_READ_MS);
    return () => clearInterval(timer);
  }, [
    detachedUntil,
    environmentId,
    forgetDetached,
    installLanded,
    installLeftRunning,
    instanceId,
    refreshProviders,
  ]);
  // Some agents never report past "not checked yet"; that must not read as checking for good.
  const stalled = useHeldFor(view.state === "checking" && !checking, AGENT_CHECK_TIMEOUT_MS);
  const account = agentSignInAccount(agent);
  const version = getProviderVersionLabel(provider?.version);
  // The search looks for the agent's usual entry, so its answer is that entry's file only.
  const saved = savedCommand(instance.config);
  const searched =
    registryAgentId !== undefined || instanceId === defaultInstanceIdForDriver(instance.driver);
  const command =
    saved !== null && /[\\/]/.test(saved) ? saved : ((searched ? foundPath : null) ?? saved);
  // A sign-in the app has no way to start: the machine's words are the only lead.
  const signsInHere = hasSetupBlock || claude || signInCommand !== null;
  const noWayToSignIn = view.action === "signIn" && !signsInHere;
  const detail =
    view.detail ?? ((noWayToSignIn || stalled) && provider?.message ? provider.message : null);
  const urlAuthAction = provider?.auth.action;

  const checkAgain = () => {
    setCheckingAgain(true);
    void Promise.resolve(refreshProviders({ environmentId, input: { instanceId } })).finally(() =>
      setCheckingAgain(false),
    );
  };
  const checkAgainButton = (
    <Button size="sm" variant="outline" onClick={checkAgain}>
      {tx("Check again")}
    </Button>
  );

  const action = checking ? null : view.action === "turnOn" ? (
    readOnly || turnOnLockedBy !== null ? null : (
      <Button size="sm" onClick={onTurnOn}>
        {tx("Turn on")}
      </Button>
    )
  ) : view.action === "checkAgain" || stalled || noWayToSignIn ? (
    // Reading again changes nothing, so a connection that cannot change agents has it too.
    checkAgainButton
  ) : view.action === "install" ? (
    readOnly || installsInApp ? null : canInstallOnboardingAgent(agent) && os ? (
      <Button
        size="sm"
        disabled={panel.session !== null || !panel.available}
        onClick={() =>
          panel.open({
            agent,
            agentName: name,
            providerInstanceId: instanceId,
            command: resolveOnboardingProviderInstallCommand(agent, os),
            purpose: "install",
          })
        }
      >
        {tx("Install")}
      </Button>
    ) : (
      checkAgainButton
    )
  ) : showSignIn && !hasSetupBlock && !claude && signInCommand !== null ? (
    <Button
      size="sm"
      disabled={panel.session !== null || !panel.available}
      onClick={() =>
        panel.open({
          agent,
          agentName: name,
          providerInstanceId: instanceId,
          command: signInCommand,
          purpose: "signIn",
        })
      }
    >
      {account ? tx("Sign in with {account}", { account }) : tx("Sign in")}
    </Button>
  ) : null;

  const signInEnded =
    view.state === "signedOut" &&
    panel.endedInstance === instanceId &&
    !checking &&
    panel.session === null;

  return (
    <section
      aria-label={tx("Agent status")}
      className="space-y-3 border-b border-border/70 pb-4"
      data-agent-status-row={agent}
      data-agent-state={checking ? "checking" : view.state}
    >
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1 space-y-1">
          <AgentRowStatus tone={checking ? "checking" : view.tone}>
            <span className="text-sm">{checking ? tx("Checking…") : view.headline}</span>
          </AgentRowStatus>
          {view.account ? (
            <p className="text-xs leading-relaxed break-words text-muted-foreground">
              {view.accountIsLastKnown
                ? view.account.email || view.account.login
                  ? renderRich(tx("Last time it was signed in as {account}."), {
                      account: <AccountName auth={view.account} />,
                    })
                  : tx("Last time it was signed in.")
                : view.account.email || view.account.login
                  ? renderRich(tx("Signed in as {redactedSensitiveText}."), {
                      redactedSensitiveText: <AccountName auth={view.account} />,
                    })
                  : null}
              {(view.account.label ?? view.account.type) ? (
                <> {tx("Plan: {plan}.", { plan: view.account.label ?? view.account.type ?? "" })}</>
              ) : null}
            </p>
          ) : null}
          {detail || signInEnded ? (
            <p className="text-xs leading-relaxed break-words text-muted-foreground">
              {detail}
              {signInEnded
                ? tx("The sign-in ended before {agent} was signed in. Try again.", { agent: name })
                : null}
            </p>
          ) : null}
          {view.action === "turnOn" && turnOnLockedBy ? (
            <TeamRulesLabel>{turnOnLockedBy}</TeamRulesLabel>
          ) : null}
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted-foreground">{tx("Runs on")}</dt>
        <dd>{environmentLabel}</dd>
        {version ? (
          <>
            <dt className="text-muted-foreground">{tx("Version")}</dt>
            <dd>
              <code>{version}</code>
            </dd>
          </>
        ) : null}
        {command ? (
          <>
            <dt className="text-muted-foreground">{tx("Command")}</dt>
            <dd>
              <code className="break-all" data-agent-command-path>
                {command}
              </code>
            </dd>
          </>
        ) : null}
      </dl>
      {urlAuthAction && onAcceptUrlAuth ? (
        <div className="grid max-w-xl gap-1.5 text-xs">
          <p>{urlAuthAction.message}</p>
          <code className="break-all text-2xs">{urlAuthAction.url}</code>
          <Button
            render={
              <a
                href={urlAuthAction.url}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => onAcceptUrlAuth(urlAuthAction)}
              />
            }
            size="xs"
            variant="outline"
            className="w-fit"
            disabled={readOnly}
          >
            <ExternalLinkIcon />
            {tx("Continue authentication")}
          </Button>
        </div>
      ) : null}
      {hasSetupBlock && !readOnly ? (
        setupBlock
      ) : !showSignIn ? null : claude && provider ? (
        <ClaudeSignIn
          environmentId={environmentId}
          environmentLabel={environmentLabel}
          instanceId={instanceId}
          provider={provider}
          os={os}
          command={signInCommand ?? "claude auth login"}
          readOnly={readOnly}
        />
      ) : signInCommand !== null && !checking ? (
        <AgentCommand
          command={signInCommand}
          flush
          note={
            instance.driver === "pi"
              ? tx("Pi signs in from inside. Type /login once it has opened.")
              : undefined
          }
        />
      ) : null}
      {panel.session !== null ? (
        <AgentSetupPanel
          key={agentSetupPanelKey(panel.session)}
          session={panel.session}
          onClose={panel.close}
          keepInstallRunning
        />
      ) : null}
    </section>
  );
}
