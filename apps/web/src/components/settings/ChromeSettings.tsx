import { useState } from "react";
import {
  AuthFilesystemReadScope,
  AuthTerminalOperateScope,
  type BrowserBridgeCheck,
  type BrowserBridgeProviderWiring,
  type BrowserBridgeStatus,
  type EnvironmentId,
} from "@specweave-studio/contracts";
import { squashAtomCommandFailure } from "@specweave-studio/client-runtime/state/runtime";
import {
  ChromeIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CopyIcon,
  ExternalLinkIcon,
  PlayCircleIcon,
  PlugZapIcon,
  RefreshCwIcon,
} from "lucide-react";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { useEnvironment, useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { projectWorkspace } from "../../studio/projectWorkspace";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { BrowserExtensionCard } from "./BrowserExtensionSettings";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsPageContainer, SettingsSection, useRelativeTimeTick } from "./settingsLayout";

export const CHROME_EXTENSION_URL = "https://claude.ai/chrome";
/** The Chrome profile agents should use; holds the accounts SpecWithCode publishes from. */
export const AGENT_CHROME_PROFILE = "SpecWithCode";
/** Walkthrough video; null until it is published. */
export const CHROME_SETUP_VIDEO_URL: string | null = null;
/** An MCP entry that lets another provider share Claude Code's browser server. */
export const SHARED_BRIDGE_JSON = `{
  "mcpServers": {
    "chrome": { "command": "claude", "args": ["--claude-in-chrome-mcp"] }
  }
}`;
export const SHARED_BRIDGE_TOML = `[mcp_servers.chrome]
command = "claude"
args = ["--claude-in-chrome-mcp"]`;

type Tone = "success" | "warning" | "error" | "info";

const CHECK_LABELS: Record<BrowserBridgeCheck["state"], { label: string; tone: Tone }> = {
  connected: { label: "Connected", tone: "success" },
  choose_browser: { label: "Choose a browser", tone: "warning" },
  not_connected: { label: "Not connected", tone: "error" },
  cli_missing: { label: "Claude Code missing", tone: "error" },
  timeout: { label: "No answer", tone: "warning" },
  error: { label: "Check failed", tone: "error" },
};

export interface ChromeDiagnosis {
  readonly tone: Tone;
  readonly title: string;
  readonly detail: string;
  readonly action: "reconnect" | "test" | null;
}

/** The one next step for this machine, from what it reports and its last round trip. */
export function diagnoseChrome(
  status: BrowserBridgeStatus,
  check: BrowserBridgeCheck | null,
  machine: string,
): ChromeDiagnosis | null {
  if (check?.state === "connected") return null;
  if (check?.state === "cli_missing")
    return {
      tone: "error",
      title: "Install Claude Code on this machine",
      detail:
        "Every provider reaches Chrome through Claude Code's browser server. Install Claude Code, sign in, then test again.",
      action: "test",
    };
  if (!status.chrome.installed)
    return {
      tone: "error",
      title: `Install Google Chrome on ${machine}`,
      detail:
        "Agents drive your real Chrome, with its logins. Install it, then follow the steps below.",
      action: null,
    };
  if (!status.chrome.running)
    return {
      tone: "warning",
      title: `Open Chrome on ${machine}`,
      detail: `Open the ${AGENT_CHROME_PROFILE} profile. The extension only answers while Chrome is open.`,
      action: "test",
    };
  if (!status.extension.nativeHostInstalled)
    return {
      tone: "warning",
      title: "Let Chrome reach Claude Code",
      detail: "Run `claude --chrome` once in a terminal on this machine, then restart Chrome.",
      action: "test",
    };
  if (status.extension.liveConnections === 0)
    return {
      tone: "warning",
      title: "Install or turn on the extension",
      detail: `Add Claude in Chrome to the ${AGENT_CHROME_PROFILE} profile, or turn it back on in chrome://extensions.`,
      action: "test",
    };
  if (check === null) return null;
  const account = status.claudeAccount ? ` as ${status.claudeAccount}` : "";
  switch (check.state) {
    case "choose_browser":
      return {
        tone: "warning",
        title: "More than one Chrome is connected",
        detail: `Click Reconnect, then press Connect in the ${AGENT_CHROME_PROFILE} profile so agents use the right logins.`,
        action: "reconnect",
      };
    case "timeout":
      return {
        tone: "warning",
        title: "Chrome did not answer in time",
        detail: "Restart Chrome, then test again. Reconnect if it still does not answer.",
        action: "test",
      };
    case "not_connected":
      return {
        tone: "error",
        title: "The extension is running but not connected",
        detail: `Click Reconnect and press Connect in the ${AGENT_CHROME_PROFILE} profile. If nothing appears, sign the extension in to claude.ai${account}, the same account as Claude Code.`,
        action: "reconnect",
      };
    default:
      return {
        tone: "error",
        title: "The check did not finish",
        detail: check.message ?? "Claude Code's browser server stopped early.",
        action: "test",
      };
  }
}

const ROUTE_LABELS: Record<BrowserBridgeProviderWiring["route"], { label: string; tone: Tone }> = {
  built_in: { label: "Built in", tone: "success" },
  shared_bridge: { label: "Shares Claude's browser", tone: "success" },
  own_extension: { label: "Own Codex extension", tone: "info" },
  turned_off: { label: "Turned off", tone: "warning" },
  not_set_up: { label: "Not set up", tone: "warning" },
  not_installed: { label: "Not installed", tone: "info" },
};

const PROVIDER_NAMES: Record<BrowserBridgeProviderWiring["provider"], string> = {
  claude: "Claude Code",
  codex: "Codex",
  copilot: "Copilot",
  gemini: "Gemini",
};

const PROVIDER_CONFIG_FILES: Record<BrowserBridgeProviderWiring["provider"], string> = {
  claude: "",
  codex: "~/.codex/config.toml",
  copilot: "~/.copilot/mcp-config.json",
  gemini: "~/.gemini/settings.json",
};

export function ChromeSettings() {
  const { environments } = useEnvironments();
  const { search, selectScope } = useSettingsScope();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  // Chrome on this computer pairs with this computer's service, so default to it.
  const selected =
    environments.find((environment) => environment.environmentId === search.machine) ??
    environments.find((environment) => environment.environmentId === primaryEnvironmentId) ??
    environments[0];
  const here = environments.find(
    (environment) => environment.environmentId === primaryEnvironmentId,
  );
  // This computer first, so the default and the safe choice are the same button.
  const ordered = here
    ? [here, ...environments.filter((environment) => environment !== here)]
    : environments;
  const elsewhere = here !== undefined && selected !== undefined && selected !== here;
  return (
    <SettingsPageContainer width="wide">
      <SettingsSection title="Chrome for agents" icon={<ChromeIcon className="size-4" />}>
        <div className="space-y-4 px-4 py-4">
          <p className="max-w-prose text-sm text-muted-foreground">
            Agents publish, read dashboards and fill forms in your real Chrome, signed in as you.
            The SpecWithCode Browser extension is the recommended way: install it once per Chrome
            profile and agents of every provider can use that profile. Claude in Chrome remains as
            an alternative below. Pick the computer whose Chrome you are setting up: Chrome pairs
            only with SpecWithCode on its own computer.
          </p>
          {environments.length === 0 ? (
            <p role="status" className="text-sm text-muted-foreground">
              Connect a machine to set up Chrome on it.
            </p>
          ) : (
            <div role="tablist" aria-label="Machine" className="flex flex-wrap gap-2">
              {ordered.map((environment) => {
                const active = environment.environmentId === selected?.environmentId;
                const here = environment.environmentId === primaryEnvironmentId;
                return (
                  <Button
                    key={environment.environmentId}
                    role="tab"
                    aria-selected={active}
                    size="sm"
                    variant={active ? "default" : "outline"}
                    onClick={() => selectScope({ ...search, machine: environment.environmentId })}
                  >
                    {environment.label}
                    {here && (
                      <Badge variant={active ? "secondary" : "success"} className="ms-1">
                        This computer
                      </Badge>
                    )}
                  </Button>
                );
              })}
            </div>
          )}
        </div>
      </SettingsSection>
      {selected && (
        <BrowserExtensionCard
          key={`extension-${selected.environmentId}`}
          environmentId={selected.environmentId}
          machine={selected.label}
          thisComputer={elsewhere ? here.label : null}
          onSwitchToThisComputer={
            elsewhere ? () => selectScope({ ...search, machine: here.environmentId }) : undefined
          }
        />
      )}
      <p className="px-1 pt-2 text-sm font-medium text-muted-foreground">
        Alternative: Claude in Chrome
      </p>
      {selected && (
        <MachineChromeCard
          key={selected.environmentId}
          environmentId={selected.environmentId}
          machine={selected.label}
        />
      )}
      <ChromeSetupGuide />
    </SettingsPageContainer>
  );
}

export function MachineChromeCard({
  environmentId,
  machine,
}: {
  environmentId: EnvironmentId;
  machine: string;
}) {
  const permitted = useEnvironmentScope(environmentId, AuthFilesystemReadScope);
  const canOperate = useEnvironmentScope(environmentId, AuthTerminalOperateScope);
  const environment = useEnvironment(environmentId);
  const connected = environment?.connection.phase === "connected";
  const query = useEnvironmentQuery(
    permitted && connected
      ? projectWorkspace.browserBridgeStatus({ environmentId, input: {} })
      : null,
  );
  const test = useAtomCommand(projectWorkspace.browserBridgeTest);
  const reconnect = useAtomCommand(projectWorkspace.browserBridgeReconnect);
  const [busy, setBusy] = useState<"test" | "reconnect" | null>(null);
  const [latest, setLatest] = useState<BrowserBridgeCheck | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  useRelativeTimeTick(30_000);

  async function run(kind: "test" | "reconnect") {
    if (busy) return;
    setBusy(kind);
    setRunError(null);
    try {
      const result = await (kind === "test" ? test : reconnect)({ environmentId, input: {} });
      if (result._tag === "Success") setLatest(result.value);
      else {
        const cause = squashAtomCommandFailure(result);
        setRunError(cause instanceof Error ? cause.message : `${machine} did not answer.`);
      }
    } catch {
      setRunError(`${machine} did not answer.`);
    } finally {
      setBusy(null);
      query.refresh();
    }
  }

  const header = (
    <span className="flex items-center gap-2">
      <ChromeIcon className="size-4" />
      Chrome on {machine}
    </span>
  );
  if (!connected || !permitted)
    return (
      <SettingsSection title={`Chrome on ${machine}`} icon={<ChromeIcon className="size-4" />}>
        <p role="status" className="px-4 py-4 text-sm text-muted-foreground">
          {!connected
            ? `${machine} is offline. Connect it to check its Chrome.`
            : "This device cannot read that machine's settings."}
        </p>
      </SettingsSection>
    );
  const status = query.data;
  const check = latest ?? status?.lastCheck ?? null;
  const pill = check
    ? CHECK_LABELS[check.state]
    : { label: "Not checked yet", tone: "info" as const };
  const diagnosis = status ? diagnoseChrome(status, check, machine) : null;
  const sharable = status?.providers.filter((p) => p.route === "not_set_up") ?? [];

  return (
    <SettingsSection
      title={`Chrome on ${machine}`}
      hideTitle
      aria-label={`Chrome on ${machine}`}
      data-testid="machine-chrome-card"
    >
      <div className="space-y-5 px-4 py-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <h3 className="text-base font-medium">{header}</h3>
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <Badge variant={pill.tone} data-testid="chrome-check-state">
                {pill.tone === "success" ? (
                  <CircleCheckIcon className="size-3" />
                ) : (
                  <CircleAlertIcon className="size-3" />
                )}
                {pill.label}
              </Badge>
              {check && (
                <span>
                  Checked {formatRelativeTimeLabel(check.checkedAt)}
                  {check.tabCount !== undefined &&
                    ` · ${check.tabCount} agent tab${check.tabCount === 1 ? "" : "s"}`}
                </span>
              )}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant={diagnosis?.action === "reconnect" ? "outline" : "default"}
              disabled={!canOperate || busy !== null}
              onClick={() => void run("test")}
            >
              {busy === "test" ? <Spinner /> : <PlugZapIcon />}
              Test connection
            </Button>
            <Button
              size="sm"
              variant={diagnosis?.action === "reconnect" ? "default" : "outline"}
              disabled={!canOperate || busy !== null}
              onClick={() => void run("reconnect")}
            >
              {busy === "reconnect" ? <Spinner /> : <RefreshCwIcon />}
              Reconnect
            </Button>
          </div>
        </div>

        {busy === "reconnect" && (
          <p role="status" className="rounded-md bg-info/8 px-3 py-2 text-sm text-info-foreground">
            Chrome on {machine} now shows Connect in the extension. Press it in the{" "}
            {AGENT_CHROME_PROFILE} profile. Waiting up to 2 minutes.
          </p>
        )}
        {!canOperate && (
          <p className="text-xs text-muted-foreground">
            This device can view {machine}'s Chrome but not test it.
          </p>
        )}
        {(runError || query.error) && (
          <p role="alert" className="text-sm text-destructive-foreground">
            {runError ?? query.error}
          </p>
        )}
        {diagnosis && busy === null && (
          <div
            role="alert"
            data-testid="chrome-diagnosis"
            className={
              diagnosis.tone === "error"
                ? "rounded-md bg-destructive/8 px-3 py-2"
                : "rounded-md bg-warning/8 px-3 py-2"
            }
          >
            <p className="text-sm font-medium">{diagnosis.title}</p>
            <p className="text-sm text-muted-foreground">{diagnosis.detail}</p>
          </div>
        )}

        {query.isPending && !status ? (
          <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner /> Reading Chrome on {machine}…
          </p>
        ) : status ? (
          <>
            <ChromeFacts status={status} />
            {check && check.browsers.length > 0 && (
              <div className="space-y-1.5">
                <p className="text-xs font-medium text-muted-foreground">Connected browsers</p>
                <ul className="flex flex-wrap gap-2">
                  {check.browsers.map((browser) => (
                    <li key={browser.deviceId ?? browser.name}>
                      <Badge variant={browser.inUse ? "success" : "outline"} size="lg">
                        {browser.name}
                        {browser.inUse && " · in use"}
                      </Badge>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <ProviderRoutes providers={status.providers} />
            {sharable.length > 0 && <SharedBridgeSnippet providers={sharable} />}
          </>
        ) : null}
      </div>
    </SettingsSection>
  );
}

function ChromeFacts({ status }: { status: BrowserBridgeStatus }) {
  const facts: Array<[string, string]> = [
    [
      "Chrome",
      !status.chrome.installed
        ? "Not installed"
        : status.chrome.running
          ? "Installed, open"
          : "Installed, closed",
    ],
    [
      "Extension",
      status.extension.liveConnections > 0
        ? `Running in ${status.extension.liveConnections} profile${status.extension.liveConnections === 1 ? "" : "s"}`
        : status.extension.nativeHostInstalled
          ? "Not running"
          : "Not set up",
    ],
    ["Claude account", status.claudeAccount ?? "Not signed in"],
    ["Chosen for agents", status.extension.pairedBrowserName ?? "None yet"],
    [
      "Chrome profiles",
      status.chromeProfiles === null
        ? "Hidden by macOS privacy settings"
        : status.chromeProfiles.join(", ") || "None",
    ],
  ];
  return (
    <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
      {facts.map(([term, value]) => (
        <div
          key={term}
          className="flex min-w-0 justify-between gap-3 border-b border-border/50 pb-1.5"
        >
          <dt className="text-muted-foreground">{term}</dt>
          <dd className="min-w-0 break-words text-right">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function ProviderRoutes({ providers }: { providers: ReadonlyArray<BrowserBridgeProviderWiring> }) {
  if (providers.length === 0) return null;
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium text-muted-foreground">How each provider reaches Chrome</p>
      <ul className="flex flex-wrap gap-2">
        {providers.map((wiring) => {
          const route = ROUTE_LABELS[wiring.route];
          return (
            <li key={wiring.provider}>
              <Badge variant={route.tone} size="lg">
                {PROVIDER_NAMES[wiring.provider]}: {route.label}
              </Badge>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function SharedBridgeSnippet({
  providers,
}: {
  providers: ReadonlyArray<BrowserBridgeProviderWiring>;
}) {
  const { copyToClipboard, isCopied } = useCopyToClipboard<string>();
  const [copied, setCopied] = useState<string | null>(null);
  const names = providers.map((p) => PROVIDER_NAMES[p.provider]).join(" and ");
  return (
    <details className="rounded-md border border-border/60 px-3 py-2 text-sm">
      <summary className="cursor-pointer">Let {names} share Claude's browser</summary>
      <div className="mt-2 space-y-3">
        <p className="text-muted-foreground">
          Add this entry to the provider's MCP settings on this machine, then start a new thread. It
          uses the same extension and the same Chrome profile.
        </p>
        {providers.map((wiring) => {
          const snippet = wiring.provider === "codex" ? SHARED_BRIDGE_TOML : SHARED_BRIDGE_JSON;
          return (
            <div key={wiring.provider} className="space-y-1">
              <div className="flex items-center justify-between gap-2">
                <code className="text-xs text-muted-foreground">
                  {PROVIDER_CONFIG_FILES[wiring.provider]}
                </code>
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => {
                    setCopied(wiring.provider);
                    copyToClipboard(snippet, wiring.provider);
                  }}
                >
                  <CopyIcon />
                  {isCopied && copied === wiring.provider ? "Copied" : "Copy"}
                </Button>
              </div>
              <pre className="overflow-x-auto rounded bg-muted px-2 py-1.5 text-xs">{snippet}</pre>
            </div>
          );
        })}
      </div>
    </details>
  );
}

const SETUP_STEPS: ReadonlyArray<{ title: string; body: React.ReactNode }> = [
  {
    title: "Install the extension",
    body: (
      <>
        Open Chrome in the <strong>{AGENT_CHROME_PROFILE}</strong> profile and add{" "}
        <a
          className="underline underline-offset-2"
          href={CHROME_EXTENSION_URL}
          target="_blank"
          rel="noreferrer"
        >
          Claude in Chrome
          <ExternalLinkIcon className="ml-0.5 inline size-3" />
        </a>
        . Keep the sites you publish to (YouTube, LinkedIn, X) signed in there and nowhere else.
      </>
    ),
  },
  {
    title: "Sign in",
    body: "Sign the extension in to claude.ai with the same account as Claude Code on this machine (shown above).",
  },
  {
    title: "Pick the profile",
    body: `Click Reconnect, then press Connect in the ${AGENT_CHROME_PROFILE} profile's extension. Agents use that profile from then on.`,
  },
  {
    title: "Verify",
    body: "Click Test connection. Green means agents can open and read tabs. Test again whenever a thread says Chrome is not connected.",
  },
];

function ChromeSetupGuide() {
  return (
    <SettingsSection title="Set up Claude in Chrome" icon={<PlayCircleIcon className="size-4" />}>
      <div className="grid gap-5 px-4 py-4 md:grid-cols-[1fr_16rem]">
        <ol className="space-y-3">
          {SETUP_STEPS.map((step, index) => (
            <li key={step.title} className="flex gap-3">
              <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-medium text-primary-foreground">
                {index + 1}
              </span>
              <div className="min-w-0 text-sm">
                <p className="font-medium">{step.title}</p>
                <p className="text-muted-foreground">{step.body}</p>
              </div>
            </li>
          ))}
        </ol>
        <div className="flex aspect-video flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border/70 bg-muted/40 p-4 text-center text-sm text-muted-foreground">
          <PlayCircleIcon className="size-8" />
          {CHROME_SETUP_VIDEO_URL ? (
            <a
              className="underline underline-offset-2"
              href={CHROME_SETUP_VIDEO_URL}
              target="_blank"
              rel="noreferrer"
            >
              Watch the 2-minute setup
            </a>
          ) : (
            <span>Video walkthrough coming soon</span>
          )}
        </div>
      </div>
    </SettingsSection>
  );
}
