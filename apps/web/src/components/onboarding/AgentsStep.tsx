import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  ProviderInstanceId,
  ServerConfig,
  ServerProvider,
} from "@specweave-studio/contracts";
import { scopeThreadRef } from "@specweave-studio/client-runtime/environment";
import {
  AuthOrchestrationReadScope,
  AuthProvidersManageScope,
  AuthTerminalOperateScope,
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  ThreadId,
} from "@specweave-studio/contracts";
import * as Schema from "effect/Schema";
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
import { TYPOGRAPHY_ADVANCED_STORAGE_KEY } from "../../appearanceFonts";
import { useMachineNicknames } from "../../studio/machineNickname";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import {
  canInstallOnboardingAgent,
  DEVELOPER_TOOLS_INSTALL_COMMAND,
  listOnboardingAgents,
  onboardingAgentUses,
  resolveAgentSignInCommand,
  resolveOnboardingProviderInstallCommand,
  type OnboardingAgentRow,
} from "../../onboarding/providerReadiness.logic";
import { randomUUID } from "../../lib/utils";
import { acpAgentIdForInstanceConfig } from "../../providerInstances";
import { useEnvironments } from "../../state/environments";
import { useAgentReadiness } from "../../onboarding/useAgentReadiness";
import { agentReadinessMessage } from "../../onboarding/agentReadiness.logic";
import { serverEnvironment } from "../../state/server";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import { terminalEnvironment } from "../../state/terminal";
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
import { TerminalViewport } from "../ThreadTerminalDrawer";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { ScrollArea } from "../ui/scroll-area";
import { cn } from "../../lib/utils";
import { useT, useTx } from "../../i18n";
import { AgentCommand, AgentRow, AgentRowStatus } from "./AgentRow";
import { FoundAgentRow, GitRow, InstallAgentRow, ProviderAgentRow } from "./AgentRows";
import { StepShell, useHeldFor, WizardStepFooter } from "./WizardFrame";

const AddProviderInstanceDialog = lazy(() =>
  import("../settings/AddProviderInstanceDialog").then((module) => ({
    default: module.AddProviderInstanceDialog,
  })),
);

const AGENT_ONBOARDING_THREAD_ID = ThreadId.make("onboarding-agent-setup");
// Some providers report "not checked yet" for good, so checking cannot last forever.
const AGENT_CHECK_TIMEOUT_MS = 15_000;
/** While an agent's sign-in runs in the panel, its machine is asked this often. */
const SIGN_IN_POLL_MS = 3_000;
/** While macOS installs its developer tools, the machine is asked for Git this often. */
const GIT_POLL_MS = 5_000;
/** The developer tools download can take a while; asking stops after this many tries. */
const GIT_POLL_LIMIT = 240;

/** Setup values stay fixed while provider probes refresh the surrounding rows. */
interface AgentTerminalSession {
  readonly environmentId: EnvironmentId;
  readonly agent: string;
  readonly agentName: string;
  /** Absent for a command that belongs to no agent, such as the Git install. */
  readonly providerInstanceId?: ServerProvider["instanceId"] | undefined;
  readonly cwd: string;
  readonly command: string;
  /**
   * Each runs at once, and its output is the log. A sign-in's panel closes when
   * it ends. An install's closes when it worked and stays open with the log
   * when it did not. `tools` installs something agents need, such as Git.
   */
  readonly purpose: "signIn" | "install" | "tools";
  readonly keybindings: ServerConfig["keybindings"];
}

/** Claude Code is the product name of the agent the driver list calls Claude. */
/** Whether a read's own answer says that agent is signed in. */
function readAsSignedIn(
  result:
    | {
        readonly _tag: string;
        readonly value?: { readonly providers?: ReadonlyArray<ServerProvider> } | undefined;
      }
    | undefined,
  instanceId: ProviderInstanceId,
): boolean {
  if (result?._tag !== "Success") return false;
  return (
    result.value?.providers?.some(
      (provider) => provider.instanceId === instanceId && provider.auth.status === "authenticated",
    ) === true
  );
}

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
  const [terminalSession, setTerminalSession] = useState<AgentTerminalSession | null>(null);
  const [addingAccount, setAddingAccount] = useState(false);
  const [addingAgent, setAddingAgent] = useState(false);
  const [createdAccount, setCreatedAccount] = useState<{
    instanceId: ProviderInstanceId;
    displayName: string;
    autoStart: boolean;
  } | null>(null);
  const canOperateTerminal = useEnvironmentScope(environmentId, AuthTerminalOperateScope);
  const canManage = useEnvironmentScope(environmentId, AuthProvidersManageScope);
  const canSearch = useEnvironmentScope(environmentId, AuthOrchestrationReadScope);
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
  // The agent whose sign-in the app started and whose result is being read.
  const [checkingInstance, setCheckingInstance] = useState<ProviderInstanceId | null>(null);
  // The agent whose sign-in in the panel ended last, for a line on its row if it is still signed out.
  const [endedInstance, setEndedInstance] = useState<ProviderInstanceId | null>(null);
  const polling = useRef(false);
  const checkTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  // A sign-in in the panel is done when the machine reads the agent as signed in.
  const signInInstanceId =
    terminalSession?.purpose === "signIn" ? terminalSession.providerInstanceId : null;
  const panelSignedIn =
    signInInstanceId !== null &&
    providers?.find((provider) => provider.instanceId === signInInstanceId)?.auth.status ===
      "authenticated";
  if (panelSignedIn) setTerminalSession(null);
  // The line about a sign-in that ended is about that sign-in only.
  if (
    endedInstance !== null &&
    providers?.find((provider) => provider.instanceId === endedInstance)?.auth.status ===
      "authenticated"
  )
    setEndedInstance(null);
  useEffect(() => {
    if (signInInstanceId === null) return;
    const timer = setInterval(() => {
      if (polling.current) return;
      polling.current = true;
      void Promise.resolve(
        refreshProviders({ environmentId, input: { instanceId: signInInstanceId } }),
      ).finally(() => {
        polling.current = false;
      });
    }, SIGN_IN_POLL_MS);
    return () => clearInterval(timer);
  }, [signInInstanceId, environmentId, refreshProviders]);

  const openPanel = (
    session: Pick<AgentTerminalSession, "agent" | "agentName" | "command" | "purpose"> & {
      readonly providerInstanceId?: ServerProvider["instanceId"];
    },
  ) => {
    if (serverConfig === null || !readEnvironmentScope(environmentId, AuthTerminalOperateScope))
      return;
    setEndedInstance(null);
    setTerminalSession({
      ...session,
      environmentId,
      cwd: serverConfig.cwd,
      keybindings: serverConfig.keybindings,
    });
  };

  const closePanel = (installed = false) => {
    const closed = terminalSession;
    setTerminalSession(null);
    if (closed === null) return;
    if (closed.purpose === "install") {
      // The row gets its button back, and a sign-in nobody is waiting for never starts.
      setInstallFailed(null);
      if (!installed)
        setSignInAfterTurnOn((current) => (current === closed.agent ? null : current));
    }
    if (closed.purpose !== "signIn") {
      void refreshProviders({ environmentId, input: {} });
      find();
      return;
    }
    // The sign-in command has ended: read that agent now, and say so on its row.
    const instanceId = closed.providerInstanceId;
    if (instanceId === undefined) return;
    const checked = () =>
      setCheckingInstance((current) => (current === instanceId ? null : current));
    setCheckingInstance(instanceId);
    setEndedInstance(instanceId);
    // A read already under way may have begun before the sign-in saved the account.
    // So this one is asked for by itself, and a signed-out answer is read once more.
    const read = (fresh: boolean) =>
      Promise.resolve(
        refreshProviders({
          environmentId,
          input: fresh ? { instanceId, fresh } : { instanceId },
        }),
      );
    void read(true)
      .then((result) => (readAsSignedIn(result, instanceId) ? undefined : read(false)))
      .finally(checked);
    // A check that never answers must not hold the row on "Checking…".
    if (checkTimer.current !== null) clearTimeout(checkTimer.current);
    checkTimer.current = setTimeout(checked, AGENT_CHECK_TIMEOUT_MS);
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
            setCheckingInstance(null);
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
              panelAvailable={serverConfig !== null && canOperateTerminal}
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
              checking={checkingInstance === provider.instanceId}
              signInEnded={endedInstance === provider.instanceId}
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
      {gitMissing || (gitWasMissing && git === "present") ? (
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
      ) : null}
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
          key={`${terminalSession.environmentId}:${terminalSession.agent}:${terminalSession.purpose}`}
          session={terminalSession}
          onClose={() => closePanel()}
          onEnded={installEnded}
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

/**
 * The panel under the list, and the log of what it runs. Opens a PTY on the
 * connected environment under a synthetic onboarding thread id (terminals are
 * keyed by free-form thread id; the server validates only the cwd). The command
 * is the session's own: it runs at once and the session ends with it. A sign-in
 * closes the panel when it ends. An install closes it when it worked, and keeps
 * the log on screen with the exit code when it did not.
 */
function AgentSetupPanel({
  session,
  onClose,
  onEnded,
  onRetry,
}: {
  readonly session: AgentTerminalSession;
  readonly onClose: () => void;
  /** An install's command has ended; `false` keeps this panel open on its log. */
  readonly onEnded: (succeeded: boolean) => void;
  /** The command is about to run again in a new session. */
  readonly onRetry: () => void;
}) {
  const t = useT();
  const tx = useTx();
  const { agent, agentName, command, cwd, environmentId, keybindings, providerInstanceId } =
    session;
  const signIn = session.purpose === "signIn";
  const canOperateTerminal = useEnvironmentScope(environmentId, AuthTerminalOperateScope);
  // Same terminal typography preference the thread drawer honors.
  const [advancedTypography] = useLocalStorage(
    TYPOGRAPHY_ADVANCED_STORAGE_KEY,
    false,
    Schema.Boolean,
  );
  const openTerminal = useAtomCommand(terminalEnvironment.open, { reportFailure: false });
  const closeTerminal = useAtomCommand(terminalEnvironment.close, { reportFailure: false });
  const setupQueueRef = useRef(Promise.resolve());
  const setupGenerationRef = useRef(0);
  const activeSetupGenerationRef = useRef<number | null>(null);
  const [setupAttempt, setSetupAttempt] = useState(0);
  // A session that has ended cannot run again, so each try gets its own.
  const terminalId = useMemo(
    () => `onboarding-${agent}-${setupAttempt}-${randomUUID()}`,
    [agent, setupAttempt],
  );
  const threadRef = useMemo(
    () => scopeThreadRef(environmentId, AGENT_ONBOARDING_THREAD_ID),
    [environmentId],
  );
  const [setupState, setSetupState] = useState<"preparing" | "ready" | "openFailed" | "failed">(
    "preparing",
  );
  const [exitCode, setExitCode] = useState<number | null>(null);
  const terminalReady = setupState === "ready" || setupState === "failed";
  const panelRef = useRef<HTMLDivElement | null>(null);

  // The panel opens under a list that may be longer than the window.
  useEffect(() => {
    panelRef.current?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
  }, []);

  // Keep each setup generation distinct. In Strict Mode, a canceled open can
  // finish after the replacement setup starts; it must not close the
  // replacement session.
  useEffect(() => {
    const generation = setupGenerationRef.current + 1;
    setupGenerationRef.current = generation;
    activeSetupGenerationRef.current = generation;
    setSetupState("preparing");
    setExitCode(null);

    setupQueueRef.current = setupQueueRef.current.then(async () => {
      if (activeSetupGenerationRef.current !== generation) return;
      if (!readEnvironmentScope(environmentId, AuthTerminalOperateScope)) {
        setSetupState("openFailed");
        return;
      }
      const opened = await openTerminal({
        environmentId,
        input: {
          threadId: AGENT_ONBOARDING_THREAD_ID,
          terminalId,
          cwd,
          ...(providerInstanceId !== undefined ? { providerInstanceId } : {}),
          command,
        },
      });
      if (activeSetupGenerationRef.current !== generation) return;
      setSetupState(opened._tag === "Success" ? "ready" : "openFailed");
    });

    // Every exit path unmounts the drawer. Close the PTY only while this
    // connection still has terminal access; revocation leaves it running.
    return () => {
      if (activeSetupGenerationRef.current === generation) {
        activeSetupGenerationRef.current = null;
      }
      setupQueueRef.current = setupQueueRef.current.then(async () => {
        if (!readEnvironmentScope(environmentId, AuthTerminalOperateScope)) return;
        await closeTerminal({
          environmentId,
          input: { threadId: AGENT_ONBOARDING_THREAD_ID, terminalId, deleteHistory: true },
        });
      });
    };
  }, [closeTerminal, command, cwd, environmentId, openTerminal, providerInstanceId, terminalId]);

  const sessionExited = (code: number | null) => {
    if (signIn) {
      onClose();
      return;
    }
    if (code === 0) {
      onEnded(true);
      return;
    }
    setExitCode(code);
    setSetupState("failed");
    onEnded(false);
  };

  const running =
    session.purpose === "signIn"
      ? tx("{agent}'s sign-in is running here. Its row updates when it is done.", {
          agent: agentName,
        })
      : session.purpose === "install"
        ? tx("Installing {agent}. This is its log. Its sign-in opens when the install is done.", {
            agent: agentName,
          })
        : tx("Asking macOS to install its developer tools, which carry Git. This is its log.");
  const failed =
    exitCode === null
      ? tx("The install of {agent} stopped before it was done. Its log is below.", {
          agent: agentName,
        })
      : tx("The install of {agent} ended with an error (exit code {code}). Its log is below.", {
          agent: agentName,
          code: exitCode,
        });

  return (
    <div
      ref={panelRef}
      data-thread-terminal-drawer
      data-agent-panel={session.purpose}
      data-agent-panel-state={setupState}
      className="mt-4 overflow-hidden rounded-lg border border-border/70 bg-background text-foreground"
    >
      <div className="flex items-center justify-between gap-3 border-b border-border/60 bg-background/60 px-3 py-1.5">
        <span
          role="status"
          className={cn(
            "min-w-0 text-2xs font-medium",
            setupState === "failed" || setupState === "openFailed"
              ? "text-warning-foreground"
              : "text-muted-foreground",
          )}
        >
          {!canOperateTerminal
            ? t("wizard.agents.noTerminal")
            : setupState === "failed"
              ? failed
              : setupState === "ready"
                ? running
                : setupState === "openFailed"
                  ? t("wizard.terminal.openFailed")
                  : t("wizard.terminal.preparing")}
        </span>
        <div className="flex shrink-0 items-center gap-1">
          {setupState === "openFailed" || setupState === "failed" ? (
            <Button
              size="xs"
              variant="ghost"
              disabled={!canOperateTerminal}
              onClick={() => {
                if (readEnvironmentScope(environmentId, AuthTerminalOperateScope)) {
                  onRetry();
                  setSetupAttempt((value) => value + 1);
                }
              }}
            >
              {t("wizard.retry")}
            </Button>
          ) : null}
          <Button size="xs" variant="ghost-muted" onClick={onClose}>
            {t("wizard.closeTerminal")}
          </Button>
        </div>
      </div>
      <details className="border-b border-border/60 px-3 py-1.5 text-2xs text-muted-foreground">
        <summary className="cursor-default">{tx("Show command")}</summary>
        <code className="mt-1 block overflow-x-auto font-mono whitespace-nowrap">{command}</code>
      </details>
      {/* Enter and Escape typed here belong to the terminal, not to setup. */}
      <div className="h-64" data-wizard-keys="off">
        {terminalReady ? (
          <TerminalViewport
            key={terminalId}
            threadRef={threadRef}
            threadId={AGENT_ONBOARDING_THREAD_ID}
            terminalId={terminalId}
            terminalLabel={
              signIn
                ? tx("Sign in to {agent}", { agent: agentName })
                : t("wizard.terminal.label", { driver: agentName })
            }
            cwd={cwd}
            {...(providerInstanceId !== undefined ? { providerInstanceId } : {})}
            advancedTypography={advancedTypography}
            onSessionExited={sessionExited}
            focusRequestId={1}
            autoFocus
            visible
            resizeEpoch={0}
            drawerHeight={256}
            keybindings={keybindings}
          />
        ) : null}
      </div>
    </div>
  );
}
