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
import { renderRich } from "../../i18n/rich";
import { AgentCommand, AgentRow, AgentRowStatus } from "./AgentRow";
import { FoundAgentRow, ProviderAgentRow } from "./AgentRows";
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

/** Setup values stay fixed while provider probes refresh the surrounding rows. */
interface AgentTerminalSession {
  readonly environmentId: EnvironmentId;
  readonly agent: string;
  readonly agentName: string;
  readonly providerInstanceId: ServerProvider["instanceId"];
  readonly cwd: string;
  readonly command: string;
  /**
   * A sign-in runs at once and the panel closes when it ends. An install is
   * typed and waits for Enter, so the person reads what will run.
   */
  readonly purpose: "signIn" | "install";
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
        back={onBack ? { onClick: onBack } : undefined}
        primary={{
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
}: {
  readonly environmentId: EnvironmentId;
  readonly machineLabel: string;
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
  const waiting = rows.some((row) => row.kind === "found" || row.state !== "ready");
  useEffect(() => {
    if (!waiting || typeof window === "undefined") return;
    const onFocus = () => void refreshProviders({ environmentId, input: {} });
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [waiting, environmentId, refreshProviders]);

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
    session: Pick<
      AgentTerminalSession,
      "agent" | "agentName" | "providerInstanceId" | "command" | "purpose"
    >,
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

  const closePanel = () => {
    const closed = terminalSession;
    setTerminalSession(null);
    if (closed === null) return;
    if (closed.purpose === "install") {
      void refreshProviders({ environmentId, input: {} });
      find();
      return;
    }
    // The sign-in command has ended: read that agent now, and say so on its row.
    const instanceId = closed.providerInstanceId;
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
  const installable = list.notInstalled.filter(canInstallOnboardingAgent);
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
        <div
          className="mt-2 flex items-center gap-2 px-1 text-xs text-muted-foreground"
          data-agents-not-installed
        >
          <p className="min-w-0 flex-1">
            {tx("Not installed: {agents}.", {
              agents: list.notInstalled.map((agent) => rowName(agent)).join(", "),
            })}
          </p>
          {installable.length > 0 ? (
            <Menu>
              <MenuTrigger
                render={
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={
                      terminalSession !== null || serverConfig === null || !canOperateTerminal
                    }
                  />
                }
              >
                {tx("Install one")}
              </MenuTrigger>
              <MenuPopup align="end">
                {installable.map((agent) => (
                  <MenuItem
                    key={agent}
                    onClick={() => {
                      if (!os) return;
                      const driver = ProviderDriverKind.make(agent);
                      openPanel({
                        agent,
                        agentName: rowName(agent),
                        providerInstanceId:
                          providers?.find((provider) => provider.driver === agent)?.instanceId ??
                          defaultInstanceIdForDriver(driver),
                        command: resolveOnboardingProviderInstallCommand(agent, os),
                        purpose: "install",
                      });
                    }}
                  >
                    {rowName(agent)}
                  </MenuItem>
                ))}
              </MenuPopup>
            </Menu>
          ) : null}
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
          key={`${terminalSession.environmentId}:${terminalSession.providerInstanceId}:${terminalSession.purpose}`}
          session={terminalSession}
          onClose={closePanel}
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
 * The panel under the list. Opens a PTY on the connected environment under a
 * synthetic onboarding thread id (terminals are keyed by free-form thread id;
 * the server validates only the cwd). An agent's sign-in is the session's
 * command: it runs at once and the session ends with it. An install command is
 * typed without submitting, so the person reviews it and presses Enter.
 */
function AgentSetupPanel({
  session,
  onClose,
}: {
  readonly session: AgentTerminalSession;
  readonly onClose: () => void;
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
  const writeTerminal = useAtomCommand(terminalEnvironment.write, { reportFailure: false });
  const closeTerminal = useAtomCommand(terminalEnvironment.close, { reportFailure: false });
  const setupQueueRef = useRef(Promise.resolve());
  const setupGenerationRef = useRef(0);
  const activeSetupGenerationRef = useRef<number | null>(null);
  const [terminalId] = useState(() => `onboarding-${agent}-${randomUUID()}`);
  const threadRef = useMemo(
    () => scopeThreadRef(environmentId, AGENT_ONBOARDING_THREAD_ID),
    [environmentId],
  );
  const [setupAttempt, setSetupAttempt] = useState(0);
  const [setupState, setSetupState] = useState<
    "preparing" | "ready" | "openFailed" | "writeFailed"
  >("preparing");
  const terminalReady = setupState === "ready" || setupState === "writeFailed";

  // Keep each setup generation distinct. In Strict Mode, a canceled open can
  // finish after the replacement setup starts; it must not close or pre-type
  // into the replacement session that shares this terminal id.
  useEffect(() => {
    const generation = setupGenerationRef.current + 1;
    setupGenerationRef.current = generation;
    activeSetupGenerationRef.current = generation;
    setSetupState("preparing");

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
          providerInstanceId,
          ...(signIn ? { command } : {}),
        },
      });
      if (opened._tag !== "Success") {
        if (activeSetupGenerationRef.current === generation) setSetupState("openFailed");
        return;
      }

      if (activeSetupGenerationRef.current !== generation) return;
      if (signIn) {
        setSetupState("ready");
        return;
      }
      if (!readEnvironmentScope(environmentId, AuthTerminalOperateScope)) {
        setSetupState("writeFailed");
        return;
      }

      const wrote = await writeTerminal({
        environmentId,
        input: { threadId: AGENT_ONBOARDING_THREAD_ID, terminalId, data: command },
      });
      if (activeSetupGenerationRef.current !== generation) return;
      setSetupState(wrote._tag === "Success" ? "ready" : "writeFailed");
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
  }, [
    closeTerminal,
    command,
    cwd,
    environmentId,
    openTerminal,
    providerInstanceId,
    setupAttempt,
    signIn,
    terminalId,
    writeTerminal,
  ]);

  return (
    <div
      data-thread-terminal-drawer
      data-agent-panel={session.purpose}
      className="mt-4 overflow-hidden rounded-lg border border-border/70 bg-background text-foreground"
    >
      <div className="flex items-center justify-between border-b border-border/60 bg-background/60 px-3 py-1.5">
        <span className="text-2xs font-medium text-muted-foreground">
          {!canOperateTerminal
            ? t("wizard.agents.noTerminal")
            : setupState === "writeFailed"
              ? renderRich(t("wizard.terminal.runCommand"), {
                  command: <code className="rounded bg-muted px-1 font-mono">{command}</code>,
                })
              : setupState === "ready"
                ? signIn
                  ? tx("{agent}'s sign-in is running here. Its row updates when it is done.", {
                      agent: agentName,
                    })
                  : t("wizard.terminal.review")
                : setupState === "openFailed"
                  ? t("wizard.terminal.openFailed")
                  : t("wizard.terminal.preparing")}
        </span>
        <div className="flex items-center gap-1">
          {setupState === "openFailed" ? (
            <Button
              size="xs"
              variant="ghost"
              disabled={!canOperateTerminal}
              onClick={() => {
                if (readEnvironmentScope(environmentId, AuthTerminalOperateScope)) {
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
      {/* Enter and Escape typed here belong to the terminal, not to setup. */}
      <div className="h-64" data-wizard-keys="off">
        {terminalReady ? (
          <TerminalViewport
            threadRef={threadRef}
            threadId={AGENT_ONBOARDING_THREAD_ID}
            terminalId={terminalId}
            terminalLabel={
              signIn
                ? tx("Sign in to {agent}", { agent: agentName })
                : t("wizard.terminal.label", { driver: agentName })
            }
            cwd={cwd}
            providerInstanceId={providerInstanceId}
            advancedTypography={advancedTypography}
            onSessionExited={onClose}
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
