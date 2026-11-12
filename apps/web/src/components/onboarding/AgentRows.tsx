import {
  AuthProvidersManageScope,
  ProviderDriverKind,
  type EnvironmentId,
  type ExecutionEnvironmentPlatformOs,
  type ProviderInstanceId,
  type ServerProvider,
} from "@specweave-studio/contracts";
import { useEffect, useState } from "react";

import { useT, useTx } from "../../i18n";
import { renderRich } from "../../i18n/rich";
import {
  getOnboardingProviderState,
  onboardingAgentUses,
  type FoundOnboardingAgent,
} from "../../onboarding/providerReadiness.logic";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { ClaudeSignIn } from "../settings/ClaudeSignIn";
import { ProviderAuthenticationSection } from "../settings/ProviderAuthenticationSection";
import { getProviderSummary } from "../settings/providerStatus";
import { RedactedSensitiveText } from "../settings/RedactedSensitiveText";
import { Button } from "../ui/button";
import { AgentCommand, AgentRow, AgentRowStatus } from "./AgentRow";

const QUIET = { reportFailure: false, reportDefect: false } as const;

/** Whether the app runs this agent's sign-in itself: a browser page or a code, no terminal. */
export function signsInThroughApp(provider: ServerProvider): boolean {
  return (
    provider.driver === "claudeAgent" ||
    provider.driver === "acpRegistry" ||
    provider.setup?.canAuthenticate === true
  );
}

function AgentIcon({
  agent,
  name,
  registryAgentId,
}: {
  readonly agent: string;
  readonly name: string;
  readonly registryAgentId?: string | undefined;
}) {
  return (
    <ProviderInstanceIcon
      driverKind={ProviderDriverKind.make(registryAgentId ? "acpRegistry" : agent)}
      displayName={name}
      acpRegistryAgentId={registryAgentId}
      iconClassName="size-5"
    />
  );
}

/**
 * Starts the app's sign-in for an agent that was just turned on with "Sign in",
 * once the machine has said where that agent's sign-in stands.
 */
function StartSignInOnce({
  environmentId,
  instanceId,
  onDone,
}: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly onDone: () => void;
}) {
  const query = useEnvironmentQuery(
    serverEnvironment.providerAuthState({ environmentId, input: { instanceId } }),
  );
  const start = useAtomCommand(serverEnvironment.startProviderAuth, QUIET);
  const phase = query.data?.phase;
  const unreadable = query.error !== null;
  useEffect(() => {
    if (unreadable) {
      onDone();
      return;
    }
    if (phase === undefined) return;
    if (phase === "idle" || phase === "failed" || phase === "cancelled") {
      void start({ environmentId, input: { instanceId } });
    }
    onDone();
  }, [phase, unreadable, environmentId, instanceId, start, onDone]);
  return null;
}

/** An agent that has an entry which is on: ready, checking, or one step from ready. */
export function ProviderAgentRow({
  environmentId,
  machineLabel,
  provider,
  name,
  os,
  command,
  registryAgentId,
  panelOpen,
  panelAvailable,
  onOpenPanel,
  checking = false,
  signInEnded = false,
  autoSignIn = false,
  onAutoSignInDone,
}: {
  readonly environmentId: EnvironmentId;
  readonly machineLabel: string;
  readonly provider: ServerProvider;
  readonly name: string;
  readonly os: ExecutionEnvironmentPlatformOs | undefined;
  /** The agent's own sign-in command, when it has one. */
  readonly command: string | null;
  readonly registryAgentId?: string | undefined;
  readonly panelOpen: boolean;
  readonly panelAvailable: boolean;
  /** Runs the agent's sign-in command in a panel under the list. */
  readonly onOpenPanel: () => void;
  /** A sign-in the app started has ended and the machine is reading the result. */
  readonly checking?: boolean;
  /** The sign-in the app ran in the panel has ended, and the agent is still signed out. */
  readonly signInEnded?: boolean;
  /** "Sign in" was pressed while the agent was still off. */
  readonly autoSignIn?: boolean;
  readonly onAutoSignInDone?: () => void;
}) {
  const t = useT();
  const tx = useTx();
  const canManage = useEnvironmentScope(environmentId, AuthProvidersManageScope);
  const state = getOnboardingProviderState(provider);
  const summary = getProviderSummary(provider, tx);
  const signedIn = provider.auth.status === "authenticated";
  const inApp = signsInThroughApp(provider);
  const claude = provider.driver === "claudeAgent";
  const needsSignIn = state === "signIn" || (state === "attention" && !signedIn);
  // A sign-in in progress stays on screen while the machine reads the agent again.
  const [signingIn, setSigningIn] = useState(false);
  if (state === "ready" && signingIn) setSigningIn(false);
  else if (needsSignIn && !signingIn) setSigningIn(true);
  const showSignIn = state !== "ready" && state !== "disabled" && (needsSignIn || signingIn);
  const email = provider.auth.email?.trim();
  const login = provider.auth.login?.trim();

  useEffect(() => {
    if (!autoSignIn) return;
    if (state === "ready") {
      onAutoSignInDone?.();
      return;
    }
    if (!showSignIn) return;
    // An agent the app signs in itself starts from its own block below. Claude's
    // block has its own button, so there is nothing more to start here.
    if (inApp && !claude) return;
    if (!inApp && command !== null && panelAvailable) onOpenPanel();
    onAutoSignInDone?.();
  }, [
    autoSignIn,
    state,
    showSignIn,
    inApp,
    claude,
    command,
    panelAvailable,
    onOpenPanel,
    onAutoSignInDone,
  ]);

  const account = email
    ? renderRich(tx("Signed in as {redactedSensitiveText}."), {
        redactedSensitiveText: (
          <RedactedSensitiveText
            value={email}
            ariaLabel="Toggle account email visibility"
            revealTooltip="Click to reveal email"
            hideTooltip="Click to hide email"
            className="break-all"
          />
        ),
      })
    : login
      ? tx("Signed in as {account}.", { account: login })
      : null;
  const plan = provider.auth.label ? tx("Plan: {plan}.", { plan: provider.auth.label }) : null;
  const detail =
    state === "ready" ? (
      account || plan ? (
        <>
          {account}
          {account && plan ? " " : null}
          {plan}
        </>
      ) : null
    ) : state === "checking" || (inApp && state === "signIn") ? null : provider.auth.status ===
      "unauthenticated" ? (
      // The machine's own words here often say to run a command; the button does that.
      <>
        {summary.headline}
        {signInEnded && !checking && !panelOpen ? (
          <> {tx("The sign-in ended before {agent} was signed in. Try again.", { agent: name })}</>
        ) : null}
      </>
    ) : (
      `${summary.headline}${summary.detail ? ` · ${summary.detail}` : ""}`
    );

  return (
    <AgentRow
      agent={registryAgentId ?? provider.driver}
      state={checking ? "checking" : state}
      icon={<AgentIcon agent={provider.driver} name={name} registryAgentId={registryAgentId} />}
      name={name}
      uses={tx(onboardingAgentUses(registryAgentId ?? provider.driver))}
      detail={detail}
      status={
        checking || state === "checking" ? (
          <AgentRowStatus tone="checking">{tx("Checking…")}</AgentRowStatus>
        ) : state === "ready" ? (
          <AgentRowStatus tone="ready">{t("wizard.agents.ready")}</AgentRowStatus>
        ) : state === "disabled" ? (
          <AgentRowStatus tone="quiet">{t("wizard.agents.disabled")}</AgentRowStatus>
        ) : undefined
      }
      action={
        showSignIn && !inApp && command !== null && !checking ? (
          <Button size="sm" disabled={panelOpen || !panelAvailable} onClick={onOpenPanel}>
            {t("wizard.agents.signIn")}
          </Button>
        ) : undefined
      }
    >
      {!showSignIn ? null : claude ? (
        <ClaudeSignIn
          environmentId={environmentId}
          environmentLabel={machineLabel}
          instanceId={provider.instanceId}
          provider={provider}
          os={os}
          command={command ?? "claude auth login"}
          readOnly={!canManage}
        />
      ) : inApp ? (
        <>
          <ProviderAuthenticationSection
            environmentId={environmentId}
            environmentLabel={machineLabel}
            instanceId={provider.instanceId}
            provider={provider}
            readOnly={!canManage}
          />
          {autoSignIn && onAutoSignInDone ? (
            <StartSignInOnce
              environmentId={environmentId}
              instanceId={provider.instanceId}
              onDone={onAutoSignInDone}
            />
          ) : null}
        </>
      ) : command !== null ? (
        <AgentCommand
          command={command}
          note={
            provider.driver === "pi"
              ? tx("Pi signs in from inside. Type /login once it has opened.")
              : undefined
          }
        />
      ) : null}
    </AgentRow>
  );
}

const FOUND_STATE_TEXT = {
  ready: "Signed in, not turned on.",
  "signed-out": "Installed, not signed in.",
  installed: "Installed, not turned on.",
} as const;

/** An agent the machine's search found that has no entry that is on yet. */
export function FoundAgentRow({
  found,
  name,
  readOnly,
  onTurnOn,
  onSignIn,
  onAdd,
}: {
  readonly found: FoundOnboardingAgent;
  readonly name: string;
  readonly readOnly: boolean;
  readonly onTurnOn: () => void;
  /** Turns the agent on and goes straight to its sign-in. */
  readonly onSignIn: () => void;
  /** Opens the dialog that adds an agent the registry offers. */
  readonly onAdd: () => void;
}) {
  const t = useT();
  const tx = useTx();
  const registry = found.kind === "registry";
  return (
    <AgentRow
      agent={found.agent}
      state={registry ? "not-added" : found.state}
      icon={
        <AgentIcon
          agent={found.agent}
          name={name}
          registryAgentId={registry ? found.agent : undefined}
        />
      }
      name={name}
      uses={tx(onboardingAgentUses(found.agent))}
      detail={
        <>
          {registry ? tx("Installed, not added.") : tx(FOUND_STATE_TEXT[found.state])}
          {found.agent === "muse" ? (
            <>
              {" "}
              {tx(
                "Muse Code can share your code with Meta when its Contributor mode is on. Check that setting before you turn it on.",
              )}
            </>
          ) : null}
        </>
      }
      action={
        readOnly ? undefined : registry ? (
          <Button
            size="sm"
            variant="outline"
            aria-label={tx("Add {agent}", { agent: name })}
            onClick={onAdd}
          >
            {tx("Add agent")}
          </Button>
        ) : found.state === "signed-out" ? (
          <Button
            size="sm"
            aria-label={tx("Sign in to {agent}", { agent: name })}
            onClick={onSignIn}
          >
            {t("wizard.agents.signIn")}
          </Button>
        ) : (
          <Button
            size="sm"
            variant="outline"
            aria-label={tx("Turn on {agent}", { agent: name })}
            onClick={onTurnOn}
          >
            {tx("Turn on")}
          </Button>
        )
      }
    />
  );
}
