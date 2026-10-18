import { useEffect, useState } from "react";
import {
  AuthFilesystemReadScope,
  AuthFilesystemWriteScope,
  AuthTerminalOperateScope,
  type BrowserExtensionAction,
  type BrowserExtensionCheck,
  type BrowserExtensionInstallFolder,
  type BrowserExtensionProfile,
  type EnvironmentId,
} from "@specweave-studio/contracts";
import { squashAtomCommandFailure } from "@specweave-studio/client-runtime/state/runtime";
import {
  CircleAlertIcon,
  CircleCheckIcon,
  CopyIcon,
  ExternalLinkIcon,
  EyeOffIcon,
  FolderOpenIcon,
  KeyRoundIcon,
  PlugZapIcon,
  PuzzleIcon,
  RefreshCwIcon,
  SquareIcon,
} from "lucide-react";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { ensureLocalApi } from "../../localApi";
import { useEnvironment } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { projectWorkspace } from "../../studio/projectWorkspace";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";
import { SettingsSection, useRelativeTimeTick } from "./settingsLayout";

/** Anchor for settings search. */
export const BROWSER_EXTENSION_SECTION_ID = "chrome-browser-extension";
export const BROWSER_EXTENSION_POLL_MS = 3_000;
export const EXTENSION_PROVIDERS = "Claude, Codex, Grok, Gemini, Copilot and Meta Muse";

const CHECK_LABELS: Record<
  BrowserExtensionCheck["state"],
  { label: string; tone: "success" | "warning" | "error" }
> = {
  connected: { label: "Connected", tone: "success" },
  not_connected: { label: "Not connected", tone: "warning" },
  error: { label: "Check failed", tone: "error" },
};

function failureMessage(result: unknown, fallback: string): string {
  const cause = squashAtomCommandFailure(result as never);
  return cause instanceof Error ? cause.message : fallback;
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const { copyToClipboard, isCopied } = useCopyToClipboard<void>({ target: label });
  return (
    <Button
      size="sm"
      variant="outline"
      aria-label={`Copy ${label}`}
      onClick={() => copyToClipboard(value, undefined)}
    >
      <CopyIcon />
      {isCopied ? "Copied" : "Copy"}
    </Button>
  );
}

function Steps({ items }: { items: ReadonlyArray<React.ReactNode> }) {
  return (
    <ol className="list-decimal space-y-1 ps-5 text-sm text-muted-foreground">
      {items.map((item, index) => (
        <li key={index}>{item}</li>
      ))}
    </ol>
  );
}

/**
 * The recommended way for agents to use Chrome: the SpecWithCode Browser
 * extension, installed once per Chrome profile and paired with this machine.
 */
export function BrowserExtensionCard({
  environmentId,
  machine,
  thisComputer = null,
  onSwitchToThisComputer,
}: {
  environmentId: EnvironmentId;
  machine: string;
  /**
   * The computer this app runs on, when it is not `machine`. Chrome here connects
   * only to this computer's SpecWithCode, so `machine`'s code fails in it.
   */
  thisComputer?: string | null;
  onSwitchToThisComputer?: (() => void) | undefined;
}) {
  const otherComputer = thisComputer !== null;
  const permitted = useEnvironmentScope(environmentId, AuthFilesystemReadScope);
  const canOperate = useEnvironmentScope(environmentId, AuthTerminalOperateScope);
  const canWrite = useEnvironmentScope(environmentId, AuthFilesystemWriteScope);
  const environment = useEnvironment(environmentId);
  const connected = environment?.connection.phase === "connected";
  const query = useEnvironmentQuery(
    permitted && connected
      ? projectWorkspace.browserExtensionStatus({ environmentId, input: {} })
      : null,
  );
  const pairing = useAtomCommand(projectWorkspace.browserExtensionPairing);
  const test = useAtomCommand(projectWorkspace.browserExtensionTest);
  const reconnect = useAtomCommand(projectWorkspace.browserExtensionReconnect);
  const stop = useAtomCommand(projectWorkspace.browserExtensionStop);
  const installFolder = useAtomCommand(projectWorkspace.browserExtensionInstallFolder);

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [folder, setFolder] = useState<BrowserExtensionInstallFolder | null>(null);
  const [check, setCheck] = useState<BrowserExtensionCheck | null>(null);
  useRelativeTimeTick(30_000);

  const refresh = query.refresh;
  const polling = permitted && connected;
  useEffect(() => {
    if (!polling) return;
    const timer = setInterval(refresh, BROWSER_EXTENSION_POLL_MS);
    return () => clearInterval(timer);
  }, [polling, refresh]);

  async function run<T>(
    kind: string,
    action: () => Promise<{ _tag: string; value?: T }>,
    onSuccess: (value: T) => void,
  ) {
    if (busy) return;
    setBusy(kind);
    setError(null);
    try {
      const result = await action();
      if (result._tag === "Success") onSuccess(result.value as T);
      else setError(failureMessage(result, `${machine} did not answer.`));
    } catch {
      setError(`${machine} did not answer.`);
    } finally {
      setBusy(null);
    }
  }

  const showCode = async () => {
    if (otherComputer) {
      const confirmed = await ensureLocalApi().dialogs.confirm(
        `This code is for Chrome on ${machine}. You are on ${thisComputer}, and Chrome here rejects it. Show it anyway, to paste into Chrome on ${machine}?`,
      );
      if (!confirmed) return;
    }
    await run(
      "pairing",
      () => pairing({ environmentId, input: {} }),
      (value) => setCode(value.pairingCode),
    );
  };
  const resetCode = async () => {
    const confirmed = await ensureLocalApi().dialogs.confirm(
      "Reset the pairing code? Every paired Chrome profile disconnects and must be paired again with the new code.",
      { variant: "destructive" },
    );
    if (!confirmed) return;
    await run(
      "reset",
      () => pairing({ environmentId, input: { reset: true } }),
      (value) => {
        setCode(value.pairingCode);
        refresh();
      },
    );
  };
  const runCheck = (kind: "test" | "reconnect") =>
    run(
      kind,
      () => (kind === "test" ? test : reconnect)({ environmentId, input: {} }),
      (value) => {
        setCheck(value);
        refresh();
      },
    );
  const stopProfile = (profileId: string) =>
    run(
      `stop:${profileId}`,
      () => stop({ environmentId, input: { profileId } }),
      () => refresh(),
    );
  const prepareFolder = () =>
    run(
      "folder",
      () => installFolder({ environmentId, input: {} }),
      (value) => setFolder(value),
    );

  const title = `SpecWithCode Browser extension on ${machine}`;
  if (!connected || !permitted)
    return (
      <SettingsSection
        id={BROWSER_EXTENSION_SECTION_ID}
        title={title}
        icon={<PuzzleIcon className="size-4" />}
      >
        <p role="status" className="px-4 py-4 text-sm text-muted-foreground">
          {!connected
            ? `${machine} is offline. Connect it to set up the extension.`
            : "This device cannot read that machine's settings."}
        </p>
      </SettingsSection>
    );

  const status = query.data;
  const profiles = status?.profiles ?? [];
  const pill =
    profiles.length > 0
      ? {
          label: `${profiles.length} profile${profiles.length === 1 ? "" : "s"} connected`,
          tone: "success" as const,
        }
      : { label: "No profile connected", tone: "warning" as const };

  return (
    <SettingsSection
      id={BROWSER_EXTENSION_SECTION_ID}
      title={title}
      icon={<PuzzleIcon className="size-4" />}
      data-testid="browser-extension-card"
    >
      <div className="space-y-5 px-4 py-4">
        {otherComputer && (
          <div
            role="alert"
            data-testid="browser-extension-other-computer"
            className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm"
          >
            <p className="flex min-w-0 items-start gap-1.5">
              <CircleAlertIcon className="mt-0.5 size-4 shrink-0 text-warning-foreground" />
              <span>
                You are on <b>{thisComputer}</b>. This sets up Chrome on <b>{machine}</b>, a
                different computer; its pairing code does not work in Chrome here.
              </span>
            </p>
            {onSwitchToThisComputer && (
              <Button size="sm" onClick={onSwitchToThisComputer}>
                Set up Chrome on {thisComputer}
              </Button>
            )}
          </div>
        )}
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 max-w-prose space-y-1">
            <p className="text-sm">
              <Badge variant="success" className="me-2">
                Recommended
              </Badge>
              One extension, installed once per Chrome profile. Agents of every provider (
              {EXTENSION_PROVIDERS}) use that profile, with its logins, through the{" "}
              <code className="text-xs">chrome_*</code> tools.
            </p>
            {status && (
              <Badge variant={pill.tone} data-testid="browser-extension-state">
                {pill.tone === "success" ? (
                  <CircleCheckIcon className="size-3" />
                ) : (
                  <CircleAlertIcon className="size-3" />
                )}
                {pill.label}
              </Badge>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={!canOperate || busy !== null}
              onClick={() => void runCheck("test")}
            >
              {busy === "test" ? <Spinner /> : <PlugZapIcon />}
              Test connection
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={!canOperate || busy !== null}
              onClick={() => void runCheck("reconnect")}
            >
              {busy === "reconnect" ? <Spinner /> : <RefreshCwIcon />}
              Reconnect
            </Button>
          </div>
        </div>

        {!canOperate && (
          <p className="text-xs text-muted-foreground">
            This device can view {machine}'s extension but not pair or test it.
          </p>
        )}
        {(error || query.error) && (
          <p role="alert" className="text-sm text-destructive-foreground">
            {error ?? query.error}
          </p>
        )}
        {check && <CheckResult check={check} />}

        {query.isPending && !status ? (
          <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner /> Reading the extension on {machine}…
          </p>
        ) : status ? (
          <>
            <div className="space-y-2">
              <p className="text-sm font-medium">1. Install</p>
              <div className="flex flex-wrap items-center gap-2">
                {status.storeUrl ? (
                  <Button
                    size="sm"
                    render={<a href={status.storeUrl} target="_blank" rel="noreferrer" />}
                  >
                    <ExternalLinkIcon />
                    Add to Chrome
                  </Button>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    The extension is in Chrome Web Store review. Until it is listed, load it
                    unpacked.
                  </p>
                )}
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!canWrite || busy !== null}
                  onClick={() => void prepareFolder()}
                >
                  {busy === "folder" ? <Spinner /> : <FolderOpenIcon />}
                  Load unpacked
                </Button>
              </div>
              {folder && (
                <div className="space-y-2 rounded-md border border-border/60 px-3 py-2">
                  <div className="flex items-center gap-2">
                    <Input
                      nativeInput
                      readOnly
                      font="mono"
                      size="compact"
                      aria-label="Extension folder"
                      value={folder.path}
                    />
                    <CopyButton value={folder.path} label="extension folder" />
                  </div>
                  <p className="text-xs text-muted-foreground">Version {folder.version}</p>
                  <Steps
                    items={[
                      <>
                        Open <code className="text-xs">chrome://extensions</code> in the Chrome
                        profile agents should use.
                      </>,
                      "Turn on Developer mode (top right).",
                      "Click Load unpacked.",
                      "Pick the folder above.",
                    ]}
                  />
                </div>
              )}
            </div>

            <div className="space-y-2">
              <p className="text-sm font-medium">2. Pair</p>
              {otherComputer && (
                <p className="flex items-start gap-1.5 text-xs text-warning-foreground">
                  <CircleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
                  This code works only in Chrome on {machine}, not in Chrome on {thisComputer}.
                </p>
              )}
              {code === null ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!canOperate || busy !== null}
                  onClick={() => void showCode()}
                >
                  {busy === "pairing" ? <Spinner /> : <KeyRoundIcon />}
                  Show pairing code
                </Button>
              ) : (
                <div className="flex flex-wrap items-center gap-2">
                  <Input
                    nativeInput
                    readOnly
                    font="mono"
                    size="compact"
                    className="max-w-xs"
                    aria-label="Pairing code"
                    value={code}
                  />
                  <CopyButton value={code} label="pairing code" />
                  <Button size="sm" variant="ghost" onClick={() => setCode(null)}>
                    <EyeOffIcon />
                    Hide
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive-outline"
                    disabled={!canOperate || busy !== null}
                    onClick={() => void resetCode()}
                  >
                    {busy === "reset" ? <Spinner /> : <RefreshCwIcon />}
                    Reset code
                  </Button>
                </div>
              )}
              <Steps
                items={[
                  "Click the SpecWithCode icon in Chrome's toolbar.",
                  "Paste the pairing code.",
                  "Name the profile, for example Work or Marketing.",
                  "Click Pair.",
                ]}
              />
              <p className="text-xs text-muted-foreground">
                The code lets a Chrome profile act for agents on {machine}. Keep it private.
              </p>
            </div>

            <ConnectedProfiles
              profiles={profiles}
              canOperate={canOperate}
              busy={busy}
              onStop={(id) => void stopProfile(id)}
            />
            <RecentActions actions={status.recentActions} />
          </>
        ) : null}
      </div>
    </SettingsSection>
  );
}

function CheckResult({ check }: { check: BrowserExtensionCheck }) {
  const label = CHECK_LABELS[check.state];
  return (
    <div
      role="status"
      data-testid="browser-extension-check"
      className="space-y-1 rounded-md bg-muted/50 px-3 py-2 text-sm"
    >
      <p className="flex items-center gap-2">
        <Badge variant={label.tone}>{label.label}</Badge>
        <span className="text-xs text-muted-foreground">
          Checked {formatRelativeTimeLabel(check.checkedAt)}
        </span>
      </p>
      {check.message && <p className="text-muted-foreground">{check.message}</p>}
      {check.profiles.length > 0 && (
        <ul className="space-y-0.5">
          {check.profiles.map((profile) => (
            <li key={profile.id} className="flex flex-wrap items-center gap-2">
              {profile.ok ? (
                <CircleCheckIcon className="size-3.5 text-success-foreground" />
              ) : (
                <CircleAlertIcon className="size-3.5 text-destructive-foreground" />
              )}
              <span className="font-medium">{profile.label}</span>
              <span className="text-muted-foreground">
                {profile.ok
                  ? [
                      profile.tabCount !== undefined &&
                        `${profile.tabCount} tab${profile.tabCount === 1 ? "" : "s"}`,
                      profile.roundTripMs !== undefined && `${profile.roundTripMs} ms`,
                    ]
                      .filter(Boolean)
                      .join(" · ") || "Answered"
                  : (profile.message ?? "No answer")}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ConnectedProfiles({
  profiles,
  canOperate,
  busy,
  onStop,
}: {
  profiles: ReadonlyArray<BrowserExtensionProfile>;
  canOperate: boolean;
  busy: string | null;
  onStop: (profileId: string) => void;
}) {
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">Connected profiles</p>
      {profiles.length === 0 ? (
        <p role="status" className="text-sm text-muted-foreground">
          No Chrome profile is paired yet. Install the extension and pair it above.
        </p>
      ) : (
        <ul className="divide-y divide-border/50 rounded-md border border-border/60">
          {profiles.map((profile) => {
            const active = profile.lease !== null || profile.attachedTabs > 0;
            return (
              <li
                key={profile.id}
                data-testid="browser-extension-profile"
                className="flex flex-wrap items-center justify-between gap-3 px-3 py-2 text-sm"
              >
                <div className="min-w-0 space-y-0.5">
                  <p className="font-medium">{profile.label}</p>
                  <p className="text-xs text-muted-foreground">
                    {profile.browser} · extension {profile.extensionVersion} · connected{" "}
                    {formatRelativeTimeLabel(profile.connectedAt)} · {profile.attachedTabs} agent
                    tab{profile.attachedTabs === 1 ? "" : "s"}
                    {profile.lease && ` · in use by thread ${profile.lease.threadId}`}
                  </p>
                </div>
                {active && (
                  <Button
                    size="sm"
                    variant="destructive-outline"
                    disabled={!canOperate || busy !== null}
                    onClick={() => onStop(profile.id)}
                  >
                    {busy === `stop:${profile.id}` ? <Spinner /> : <SquareIcon />}
                    Stop
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function RecentActions({ actions }: { actions: ReadonlyArray<BrowserExtensionAction> }) {
  if (actions.length === 0) return null;
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium text-muted-foreground">Recent agent actions</p>
      <ul className="space-y-0.5 text-xs">
        {actions.map((action, index) => (
          <li
            key={`${action.at}-${index}`}
            className="flex min-w-0 gap-2 text-muted-foreground"
            data-testid="browser-extension-action"
          >
            <span className="shrink-0 tabular-nums">{formatRelativeTimeLabel(action.at)}</span>
            <span className="shrink-0">{action.profile}</span>
            <code className="shrink-0 text-foreground">{action.tool}</code>
            {action.url && <span className="min-w-0 truncate">{action.url}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}
