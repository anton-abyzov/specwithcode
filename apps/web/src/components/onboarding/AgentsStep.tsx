import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  ProviderInstanceId,
  ServerConfig,
  ServerProvider,
} from "@specweave-studio/contracts";
import {
  AuthOrchestrationReadScope,
  AuthEnvironmentMaintainScope,
  AuthProvidersManageScope,
  defaultInstanceIdForDriver,
  ProviderDriverKind,
} from "@specweave-studio/contracts";
import { EllipsisIcon } from "lucide-react";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useMachineNicknames } from "../../studio/machineNickname";
import {
  canInstallOnboardingAgent,
  DEVELOPER_TOOLS_INSTALL_COMMAND,
  listOnboardingAgents,
  onboardingAgentUses,
  resolveAgentSignInCommand,
  resolveOnboardingProviderInstallCommand,
  type OnboardingAgentRow,
} from "../../onboarding/providerReadiness.logic";
import { acpAgentIdForInstanceConfig } from "../../providerInstances";
import { useEnvironments } from "../../state/environments";
import { useAgentReadiness } from "../../onboarding/useAgentReadiness";
import { agentReadinessMessage } from "../../onboarding/agentReadiness.logic";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { AddManagedCodexAccountDialog, CodexSetupSection } from "../settings/CodexSetupSection";
import { readCodexSetupMode } from "../settings/CodexSetupSection.logic";
import {
  agentName,
  defaultAgentInstance,
  foundAgentsView,
  useAgentSearch,
} from "../settings/FoundAgents";
import { buildProviderInstanceUpdatePatch } from "../settings/SettingsPanels.logic";
import { OpenAI } from "../Icons";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { ScrollArea } from "../ui/scroll-area";
import { cn } from "../../lib/utils";
import { useT, useTx } from "../../i18n";
import { AgentCommand, AgentRow, AgentRowStatus } from "./AgentRow";
import { FoundAgentRow, GitRow, InstallAgentRow, ProviderAgentRow } from "./AgentRows";
import {
  AGENT_CHECK_TIMEOUT_MS,
  AgentSetupPanel,
  agentSetupPanelKey,
  useAgentSetupPanel,
} from "./AgentSetupPanel";
import { MachineBasics } from "./MachineBasics";
import { StepShell, useHeldFor, WizardStepFooter } from "./WizardFrame";

const AddProviderInstanceDialog = lazy(() =>
  import("../settings/AddProviderInstanceDialog").then((module) => ({
    default: module.AddProviderInstanceDialog,
  })),
);

/** While macOS installs its developer tools, the machine is asked for Git this often. */
const GIT_POLL_MS = 5_000;
/** The developer tools download can take a while; asking stops after this many tries. */
const GIT_POLL_LIMIT = 240;

/** Claude Code is the product name of the agent the driver list calls Claude. */
function rowName(agent: string, provider?: ServerProvider): string {
  return provider?.displayName || (agent === "claudeAgent" ? "Claude Code" : agentName(agent));
}

/** Every agent found on each machine, one row each: its state and at most one button. */
export function AgentsStep({
  environmentIds,
  onBack,
  onContinue,
}: {
  readonly environmentIds: readonly EnvironmentId[];
  readonly onBack?: (() => void) | undefined;
  readonly onContinue: () => void;
}) {
  const t = useT();
  const tx = useTx();
  const { environments } = useEnvironments();
  const nickname = useMachineNicknames();
  const machines = useMemo(
    () =>
      environmentIds.map((environmentId) => ({
        environmentId,
        label: nickname(
          environmentId,
          environments.find((environment) => environment.environmentId === environmentId)?.label ??
            t("wizard.computer"),
        ),
      })),
    [environmentIds, environments, nickname, t],
  );
  const reported = useAgentReadiness(machines);
  const [installing, setInstalling] = useState<readonly EnvironmentId[]>([]);
  const onInstalling = useCallback(
    (environmentId: EnvironmentId, running: boolean) =>
      setInstalling((current) =>
        running === current.includes(environmentId)
          ? current
          : running
            ? [...current, environmentId]
            : current.filter((id) => id !== environmentId),
      ),
    [],
  );
  const busy = installing.length > 0;
  const checkStalled = useHeldFor(reported.kind === "checking", AGENT_CHECK_TIMEOUT_MS);
  const readiness = checkStalled ? ({ kind: "none" } as const) : reported;
  return (
    <StepShell title={t("wizard.agents.title")} description={t("wizard.agents.description")}>
      <ScrollArea scrollFade className="mt-5 h-auto max-h-[min(32rem,55dvh)]">
        <div className="space-y-5 pr-3">
          {machines.map(({ environmentId, label }) => (
            <ConnectedAgentsStep
              key={environmentId}
              environmentId={environmentId}
              machineLabel={label}
              onInstalling={onInstalling}
            />
          ))}
        </div>
      </ScrollArea>
      <p
        role="status"
        className={cn(
          "mt-4 text-sm leading-relaxed",
          readiness.kind === "ready"
            ? "text-success-foreground"
            : readiness.kind === "checking"
              ? "text-muted-foreground"
              : "text-warning-foreground",
        )}
      >
        {agentReadinessMessage(readiness, tx)}
      </p>
      <WizardStepFooter
        back={onBack ? { onClick: onBack, disabled: busy } : undefined}
        note={
          busy
            ? tx("An install is running. Wait for it to end, or close its log to stop it.")
            : null
        }
        primary={{
          disabled: busy,
          label: readiness.kind === "none" ? tx("Continue without an agent") : t("wizard.continue"),
          onClick: onContinue,
          variant: readiness.kind === "none" ? "outline" : "default",
        }}
      />
    </StepShell>
  );
}

function ConnectedAgentsStep({
  environmentId,
  machineLabel,
  onInstalling,
}: {
  readonly environmentId: EnvironmentId;
  readonly machineLabel: string;
  readonly onInstalling: (environmentId: EnvironmentId, running: boolean) => void;
}) {
  const t = useT();
  const tx = useTx();
  const providers = useAtomValue(serverEnvironment.providersValueAtom(environmentId));
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, "Agent setup settings");
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const [addingAccount, setAddingAccount] = useState(false);
  const [addingAgent, setAddingAgent] = useState(false);
  const [createdAccount, setCreatedAccount] = useState<{
    instanceId: ProviderInstanceId;
    displayName: string;
    autoStart: boolean;
  } | null>(null);
  const canManage = useEnvironmentScope(environmentId, AuthProvidersManageScope);
  const canSearch = useEnvironmentScope(environmentId, AuthOrchestrationReadScope);
  const canMaintain = useEnvironmentScope(environmentId, AuthEnvironmentMaintainScope);
  const { search, find } = useAgentSearch(environmentId, canSearch);
  const [rechecking, setRechecking] = useState(false);
  // The agent whose install last ended with an error, for a line on its row.
  const [installFailed, setInstallFailed] = useState<string | null>(null);
  // "Install Git" was pressed: macOS has its own window, so the machine is asked again.
  const [gitRequested, setGitRequested] = useState(false);
  const [gitWasMissing, setGitWasMissing] = useState(false);
  const gitPolls = useRef(0);
  // "Sign in" on an agent that was still off: its sign-in starts once it is on.
  const [signInAfterTurnOn, setSignInAfterTurnOn] = useState<string | null>(null);

  // Re-probe on entry so freshly installed CLIs show up without a manual
  // refresh; harmless when nothing changed (single-flighted per environment).
  useEffect(() => {
    void refreshProviders({ environmentId, input: {} });
  }, [environmentId, refreshProviders]);

  const settings = serverConfig?.settings;
  const os = serverConfig?.environment.platform.os;
  const list = useMemo(() => {
    const view = search !== null && settings ? foundAgentsView(search, settings) : null;
    return listOnboardingAgents({
      providers,
      found: view?.rows ?? [],
      notFound: (search?.agents ?? [])
        .filter(({ state }) => state === "not-installed")
        .map(({ agent }) => agent),
    });
  }, [providers, search, settings]);

  const rows: OnboardingAgentRow[] = [...list.rows];
  // Keep the newly created row mounted while settings and provider snapshots catch up.
  if (createdAccount) {
    const index = rows.findIndex((row) => row.key === createdAccount.instanceId);
    const [existing] = index >= 0 ? rows.splice(index, 1) : [];
    rows.unshift(
      existing ?? {
        kind: "agent",
        key: createdAccount.instanceId,
        agent: "codex",
        provider: undefined,
        state: "checking",
      },
    );
  }

  // Coming back from a browser or a terminal is the moment to look again.
  const waiting = rows.some((row) => row.kind !== "agent" || row.state !== "ready");
  const git = search?.git;
  const gitMissing = git === "missing";
  if (gitMissing && !gitWasMissing) setGitWasMissing(true);
  if (!gitMissing && gitRequested && git === "present") setGitRequested(false);
  useEffect(() => {
    if (!(waiting || gitMissing) || typeof window === "undefined") return;
    const onFocus = () => {
      void refreshProviders({ environmentId, input: {} });
      // Git and a missing agent are read by the search, not by the agent list.
      if (gitMissing) find();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [waiting, gitMissing, environmentId, refreshProviders, find]);

  // macOS installs its developer tools in its own window and tells nobody when it is done.
  useEffect(() => {
    if (!gitMissing || !gitRequested) return;
    gitPolls.current = 0;
    const timer = setInterval(() => {
      gitPolls.current += 1;
      if (gitPolls.current > GIT_POLL_LIMIT) {
        clearInterval(timer);
        return;
      }
      find();
    }, GIT_POLL_MS);
    return () => clearInterval(timer);
  }, [gitMissing, gitRequested, find]);

  const panel = useAgentSetupPanel({
    environmentId,
    providers,
    serverConfig,
    onInstallClosed: () => {
      void refreshProviders({ environmentId, input: {} });
      find();
    },
  });
  const terminalSession = panel.session;
  const canOperateTerminal = panel.canOperateTerminal;
  const openPanel = panel.open;

  const closePanel = (installed = false) => {
    const closed = terminalSession;
    if (closed?.purpose === "install") {
      // The row gets its button back, and a sign-in nobody is waiting for never starts.
      setInstallFailed(null);
      if (!installed)
        setSignInAfterTurnOn((current) => (current === closed.agent ? null : current));
    }
    panel.close();
  };

  const turnOn = (agent: string) => {
    if (!settings) return;
    const driver = ProviderDriverKind.make(agent);
    const instanceId = defaultInstanceIdForDriver(driver);
    void Promise.resolve(
      updateSettings({
        environmentId,
        input: {
          patch: buildProviderInstanceUpdatePatch({
            settings,
            instanceId,
            driver,
            isDefault: true,
            instance: { ...defaultAgentInstance(settings, driver), enabled: true },
          }),
        },
      }),
    ).then((result) => {
      // An agent that could not be turned on has no sign-in to start later.
      if (result?._tag === "Failure") {
        setSignInAfterTurnOn((current) => (current === agent ? null : current));
      }
    });
  };

  const autoSignInDone = useCallback(() => setSignInAfterTurnOn(null), []);

  // An install or the Git install has ended. The machine is read either way: an
  // install that failed late may still have left the agent in place.
  const installEnded = (succeeded: boolean) => {
    const ended = terminalSession;
    if (ended === null) return;
    if (ended.purpose === "install") setInstallFailed(succeeded ? null : ended.agent);
    if (succeeded) {
      closePanel(true);
      return;
    }
    if (ended.purpose === "install") {
      setSignInAfterTurnOn((current) => (current === ended.agent ? null : current));
    }
    void refreshProviders({ environmentId, input: {} });
    find();
  };

  const install = (agent: string) => {
    if (!os || !canInstallOnboardingAgent(agent)) return;
    const driver = ProviderDriverKind.make(agent);
    setInstallFailed(null);
    // Its sign-in follows the install with no second click.
    setSignInAfterTurnOn(agent);
    openPanel({
      agent,
      agentName: rowName(agent),
      providerInstanceId:
        providers?.find((provider) => provider.driver === agent)?.instanceId ??
        defaultInstanceIdForDriver(driver),
      command: resolveOnboardingProviderInstallCommand(agent, os),
      purpose: "install",
    });
  };

  // Leaving the step closes the panel's terminal, which would stop an install midway.
  const installRunning = terminalSession?.purpose === "install" && installFailed === null;
  useEffect(() => {
    onInstalling(environmentId, installRunning);
    return () => onInstalling(environmentId, false);
  }, [environmentId, installRunning, onInstalling]);

  const panelBlocked = terminalSession !== null || serverConfig === null || !canOperateTerminal;
  const codexMenu = (
    <Menu>
      <MenuTrigger
        render={<Button size="icon-xs" variant="ghost-muted" aria-label={tx("More for Codex")} />}
      >
        <EllipsisIcon aria-hidden />
      </MenuTrigger>
      <MenuPopup align="end">
        <MenuItem onClick={() => setAddingAccount(true)}>
          {tx("Add another ChatGPT account")}
        </MenuItem>
      </MenuPopup>
    </Menu>
  );

  return (
    <section>
      <div className="mb-2 flex items-center justify-between gap-3">
        <h2 className="min-w-0 text-sm font-medium break-words">{machineLabel}</h2>
        <Button
          className="shrink-0"
          size="xs"
          variant="ghost-muted"
          disabled={rechecking}
          onClick={() => {
            setRechecking(true);
            panel.stopChecking();
            find();
            void Promise.resolve(refreshProviders({ environmentId, input: {} })).finally(() =>
              setRechecking(false),
            );
          }}
        >
          {rechecking ? tx("Checking…") : tx("Check again")}
        </Button>
      </div>
      {!canOperateTerminal ? (
        <p className="mb-2 text-sm text-muted-foreground">{t("wizard.agents.noTerminal")}</p>
      ) : null}
      <div className="space-y-1.5">
        {rows.map((row) => {
          if (row.kind === "install") {
            const failed = installFailed === row.agent;
            const installing =
              !failed &&
              terminalSession?.purpose === "install" &&
              terminalSession.agent === row.agent;
            return (
              <InstallAgentRow
                key={row.key}
                agent={row.agent}
                name={rowName(row.agent)}
                command={
                  os && canInstallOnboardingAgent(row.agent)
                    ? resolveOnboardingProviderInstallCommand(row.agent, os)
                    : null
                }
                installing={installing}
                failed={failed}
                disabled={panelBlocked || !os}
                onInstall={() => install(row.agent)}
              />
            );
          }
          if (row.kind === "found") {
            return (
              <FoundAgentRow
                key={row.key}
                found={{
                  agent: row.agent,
                  kind: row.registry ? "registry" : "builtIn",
                  state: row.state,
                }}
                name={rowName(row.agent)}
                readOnly={!canManage}
                onTurnOn={() => turnOn(row.agent)}
                onSignIn={() => {
                  setSignInAfterTurnOn(row.agent);
                  turnOn(row.agent);
                }}
                onAdd={() => setAddingAgent(true)}
              />
            );
          }
          if (row.agent === "codex") {
            const command =
              row.provider && settings && os
                ? resolveAgentSignInCommand(row.provider, settings, os)
                : null;
            return serverConfig !== null ? (
              <OnboardingCodexSetup
                key={row.key}
                environmentId={environmentId}
                provider={row.provider}
                serverConfig={serverConfig}
                createdAccount={row.key === createdAccount?.instanceId ? createdAccount : null}
                onAutoStartConsumed={() =>
                  setCreatedAccount((account) =>
                    account ? { ...account, autoStart: false } : null,
                  )
                }
                menu={codexMenu}
                signedOutFooter={command ? <AgentCommand command={command} flush /> : null}
              />
            ) : (
              <AgentRow
                key={row.key}
                agent="codex"
                state="checking"
                icon={<OpenAI className="size-5 shrink-0 fill-foreground" />}
                name={rowName("codex", row.provider)}
                uses={tx(onboardingAgentUses("codex"))}
                status={<AgentRowStatus tone="checking">{tx("Checking…")}</AgentRowStatus>}
              />
            );
          }
          const provider = row.provider;
          if (provider === undefined) return null;
          const command = settings && os ? resolveAgentSignInCommand(provider, settings, os) : null;
          const name = rowName(row.agent, provider);
          return (
            <ProviderAgentRow
              key={row.key}
              environmentId={environmentId}
              machineLabel={machineLabel}
              provider={provider}
              name={name}
              os={os}
              command={command}
              registryAgentId={
                provider.driver === "acpRegistry"
                  ? acpAgentIdForInstanceConfig(
                      settings?.providerInstances[provider.instanceId]?.config,
                    )
                  : undefined
              }
              panelOpen={terminalSession !== null}
              panelAvailable={panel.available}
              onOpenPanel={() => {
                if (command === null) return;
                openPanel({
                  agent: row.agent,
                  agentName: name,
                  providerInstanceId: provider.instanceId,
                  command,
                  purpose: "signIn",
                });
              }}
              checking={panel.checkingInstance === provider.instanceId}
              signInEnded={panel.endedInstance === provider.instanceId}
              autoSignIn={signInAfterTurnOn === row.agent}
              onAutoSignInDone={autoSignInDone}
            />
          );
        })}
      </div>
      {list.notInstalled.length > 0 ? (
        <p className="mt-2 px-1 text-xs text-muted-foreground" data-agents-not-installed>
          {tx("Not installed: {agents}.", {
            agents: list.notInstalled.map((agent) => rowName(agent)).join(", "),
          })}
        </p>
      ) : null}
      <p className="mt-2 px-1 text-xs text-muted-foreground" data-agents-more-later>
        {tx(
          "Want another agent or a custom provider, such as Muse Code? Add it any time after setup in Settings > Providers.",
        )}
      </p>
      <MachineBasics
        environmentId={environmentId}
        os={os}
        readOnly={!canMaintain}
        // A machine on an older SpecWithCode answers only whether it has Git.
        fallback={
          gitMissing || (gitWasMissing && git === "present") ? (
            <div className="mt-3">
              <GitRow
                state={gitMissing ? (gitRequested ? "requested" : "missing") : "present"}
                os={os}
                disabled={panelBlocked}
                onInstall={() => {
                  setGitRequested(true);
                  openPanel({
                    agent: "git",
                    agentName: "Git",
                    command: DEVELOPER_TOOLS_INSTALL_COMMAND,
                    purpose: "tools",
                  });
                }}
              />
            </div>
          ) : null
        }
      />
      {addingAccount ? (
        <AddManagedCodexAccountDialog
          environmentId={environmentId}
          onClose={() => setAddingAccount(false)}
          onAccountCreated={(instanceId, displayName) =>
            setCreatedAccount({ instanceId, displayName, autoStart: true })
          }
        />
      ) : null}
      {addingAgent ? (
        <Suspense fallback={null}>
          <AddProviderInstanceDialog
            open
            environmentId={environmentId}
            environmentLabel={machineLabel}
            onOpenChange={(open) => {
              if (open) return;
              setAddingAgent(false);
              void refreshProviders({ environmentId, input: {} });
            }}
          />
        </Suspense>
      ) : null}
      {terminalSession !== null ? (
        <AgentSetupPanel
          key={agentSetupPanelKey(terminalSession)}
          session={terminalSession}
          onClose={() => closePanel()}
          onEnded={installEnded}
          signInFollowsInstall
          onRetry={() => {
            setInstallFailed(null);
            if (terminalSession.purpose === "install") setSignInAfterTurnOn(terminalSession.agent);
          }}
        />
      ) : null}
    </section>
  );
}

function OnboardingCodexSetup({
  createdAccount,
  onAutoStartConsumed,
  environmentId,
  provider,
  serverConfig,
  menu,
  signedOutFooter,
}: {
  readonly environmentId: EnvironmentId;
  readonly provider: ServerProvider | undefined;
  readonly serverConfig: ServerConfig;
  readonly createdAccount: {
    instanceId: ProviderInstanceId;
    displayName: string;
    autoStart: boolean;
  } | null;
  readonly onAutoStartConsumed: () => void;
  readonly menu: ReactNode;
  readonly signedOutFooter: ReactNode;
}) {
  const update = useAtomCommand(serverEnvironment.updateSettings, "Codex setup settings");
  const instanceId =
    createdAccount?.instanceId ??
    provider?.instanceId ??
    defaultInstanceIdForDriver(ProviderDriverKind.make("codex"));
  const settings = serverConfig.settings;
  const instance = settings.providerInstances[instanceId] ?? {
    driver: ProviderDriverKind.make("codex"),
    enabled: settings.providers.codex.enabled,
    config: createdAccount ? { enabled: true, setupMode: "managed" } : settings.providers.codex,
  };
  const changeMode = (setupMode: "managed" | "existing") => {
    void update({
      environmentId,
      input: {
        patch: buildProviderInstanceUpdatePatch({
          settings,
          instanceId,
          driver: ProviderDriverKind.make("codex"),
          isDefault: instanceId === defaultInstanceIdForDriver(ProviderDriverKind.make("codex")),
          instance: {
            ...instance,
            enabled: true,
            config: {
              ...(instance.config !== null && typeof instance.config === "object"
                ? instance.config
                : {}),
              enabled: true,
              setupMode,
            },
          },
        }),
      },
    });
  };
  return (
    <CodexSetupSection
      presentation="onboarding"
      autoStart={createdAccount?.autoStart === true}
      displayName={createdAccount?.displayName}
      onAutoStartConsumed={onAutoStartConsumed}
      environmentId={environmentId}
      instanceId={instanceId}
      provider={provider}
      mode={readCodexSetupMode(instance.config)}
      enabled={provider?.enabled ?? true}
      onModeChange={changeMode}
      onboardingMenu={menu}
      onboardingSignedOutFooter={signedOutFooter}
    />
  );
}
