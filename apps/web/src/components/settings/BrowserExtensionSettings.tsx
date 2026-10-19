import { useEffect, useState } from "react";
import {
  AuthAccessWriteScope,
  BROWSER_EXTENSION_STORE_URL,
  AuthFilesystemReadScope,
  AuthTerminalOperateScope,
  type BrowserExtensionAction,
  type BrowserExtensionCheck,
  type BrowserExtensionPeer,
  type BrowserExtensionProfile,
  type BrowserExtensionThreadUse,
  type EnvironmentId,
  ThreadId,
} from "@specweave-studio/contracts";
import { squashAtomCommandFailure } from "@specweave-studio/client-runtime/state/runtime";
import {
  CircleAlertIcon,
  CircleCheckIcon,
  CopyIcon,
  ExternalLinkIcon,
  EyeOffIcon,
  KeyRoundIcon,
  PlugZapIcon,
  PuzzleIcon,
  RefreshCwIcon,
  SquareIcon,
} from "lucide-react";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { ensureLocalApi } from "../../localApi";
import { useThreadShell } from "../../state/entities";
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
  const canGrant = useEnvironmentScope(environmentId, AuthAccessWriteScope);
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
  const answerPeer = useAtomCommand(projectWorkspace.browserExtensionPeer);

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState<string | null>(null);
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
  const stopProfile = (profileId: string, threadId?: string) =>
    run(
      threadId === undefined ? `stop:${profileId}` : `stop:${profileId}:${threadId}`,
      () =>
        stop({
          environmentId,
          input: threadId === undefined ? { profileId } : { profileId, threadId },
        }),
      () => refresh(),
    );
  const answer = (id: string, allow: boolean) =>
    run(
      `peer:${id}`,
      () => answerPeer({ environmentId, input: { id, allow } }),
      () => refresh(),
    );

  const title = `Chrome on ${machine}`;
  if (!connected || !permitted)
    return (
      <SettingsSection
        id={BROWSER_EXTENSION_SECTION_ID}
        title={title}
        icon={<PuzzleIcon className="size-4" />}
      >
        <p role="status" className="px-4 py-4 text-sm text-muted-foreground">
          {!connected
            ? `${machine} is offline. Connect it to set up Chrome on it.`
            : "This device cannot read that machine's settings."}
        </p>
      </SettingsSection>
    );

  const status = query.data;
  const profiles = status?.profiles ?? [];
  const storeUrl = status?.storeUrl ?? BROWSER_EXTENSION_STORE_URL;
  const pill =
    profiles.length > 0
      ? {
          label: `Ready · ${profiles.length} Chrome profile${profiles.length === 1 ? "" : "s"} paired`,
          tone: "success" as const,
        }
      : { label: "Not set up", tone: "warning" as const };
  // Reconnect only helps once a check found a paired profile that does not answer.
  const offerReconnect =
    check !== null &&
    profiles.length > 0 &&
    (check.state !== "connected" || check.profiles.some((profile) => !profile.ok));

  const setup = status && (
    <div className="space-y-4" data-testid="browser-extension-setup">
      <div className="space-y-2">
        <p className="text-sm font-medium">1. Install the SpecWithCode Browser extension</p>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" render={<a href={storeUrl} target="_blank" rel="noreferrer" />}>
            <ExternalLinkIcon />
            Add to Chrome
            <span className="sr-only"> (opens the Chrome Web Store)</span>
          </Button>
          <CopyButton value={storeUrl} label="Chrome Web Store link" />
        </div>
        {otherComputer ? (
          <p className="flex items-start gap-1.5 text-xs text-warning-foreground">
            <CircleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
            Install it in Chrome on {machine}: copy the link and open it there, in the profile
            agents should use.
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            Open the link in the Chrome profile agents should use. Chrome keeps the extension up to
            date.
          </p>
        )}
      </div>

      <div className="space-y-2">
        <p className="text-sm font-medium">2. Pair it with {machine}</p>
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
    </div>
  );

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
          <div className="min-w-0 max-w-prose space-y-1.5">
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
            <p className="text-sm text-muted-foreground">
              Every chat, project thread and Aide on {machine}, with any provider, uses the paired
              Chrome profile at the same time. Each works in its own tabs, in the blue SpecWithCode
              tab group. Threads on your other connected machines can use it too, once you allow
              that machine here.
            </p>
          </div>
          {profiles.length > 0 && (
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant={offerReconnect ? "outline" : "default"}
                disabled={!canOperate || busy !== null}
                onClick={() => void runCheck("test")}
              >
                {busy === "test" ? <Spinner /> : <PlugZapIcon />}
                Test connection
              </Button>
              {offerReconnect && (
                <Button
                  size="sm"
                  disabled={!canOperate || busy !== null}
                  onClick={() => void runCheck("reconnect")}
                >
                  {busy === "reconnect" ? <Spinner /> : <RefreshCwIcon />}
                  Reconnect
                </Button>
              )}
            </div>
          )}
        </div>

        {!canOperate && (
          <p className="text-xs text-muted-foreground">
            This device can view {machine}'s Chrome but not pair or test it.
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
            <Spinner /> Reading Chrome on {machine}…
          </p>
        ) : status ? (
          profiles.length === 0 ? (
            setup
          ) : (
            <>
              <OtherMachines
                machine={machine}
                peers={status.peers ?? []}
                canGrant={canGrant}
                busy={busy}
                onAnswer={(id, allow) => void answer(id, allow)}
              />
              <ConnectedProfiles
                environmentId={environmentId}
                profiles={profiles}
                storeUrl={storeUrl}
                canOperate={canOperate}
                busy={busy}
                onStop={(id, threadId) => void stopProfile(id, threadId)}
              />
              <details
                className="rounded-md border border-border/60 px-3 py-2 text-sm"
                open={profiles.some((profile) => profile.fromStore === false) || undefined}
              >
                <summary className="cursor-pointer">Pair another Chrome profile</summary>
                <div className="mt-3">{setup}</div>
              </details>
              <RecentActions environmentId={environmentId} actions={status.recentActions} />
            </>
          )
        ) : null}
      </div>
    </SettingsSection>
  );
}

/**
 * Other machines that asked to use this Chrome for their threads. Nothing
 * from them runs here until the owner allows that machine.
 */
function OtherMachines({
  machine,
  peers,
  canGrant,
  busy,
  onAnswer,
}: {
  machine: string;
  peers: ReadonlyArray<BrowserExtensionPeer>;
  canGrant: boolean;
  busy: string | null;
  onAnswer: (id: string, allow: boolean) => void;
}) {
  if (peers.length === 0) return null;
  const answerButton = (peer: BrowserExtensionPeer, allow: boolean, label: string) => (
    <Button
      size="xs"
      variant={allow ? "default" : "outline"}
      disabled={!canGrant || busy !== null}
      onClick={() => onAnswer(peer.id, allow)}
    >
      {busy === `peer:${peer.id}` && <Spinner />}
      {label}
    </Button>
  );
  return (
    <div className="space-y-2" data-testid="browser-extension-peers">
      <p className="text-sm font-medium">Your other machines</p>
      <ul className="divide-y divide-border/60 rounded-md border border-border/60">
        {peers.map((peer) => (
          <li
            key={peer.id}
            data-testid="browser-extension-peer"
            className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm"
          >
            <span className="min-w-0">
              <span className="font-medium">{peer.machine}</span>{" "}
              <span className="text-muted-foreground">
                {peer.state === "pending"
                  ? `wants its threads to use Chrome on ${machine} · asked ${formatRelativeTimeLabel(peer.requestedAt)}`
                  : peer.state === "allowed"
                    ? `can use Chrome on ${machine}`
                    : "was declined"}
              </span>
              <span className="block text-xs text-muted-foreground">{`Signed in as ${peer.label}`}</span>
            </span>
            <span className="flex gap-2">
              {peer.state !== "allowed" && answerButton(peer, true, "Allow")}
              {peer.state === "pending" && answerButton(peer, false, "Decline")}
              {peer.state === "allowed" && answerButton(peer, false, "Remove access")}
            </span>
          </li>
        ))}
      </ul>
      {!canGrant && (
        <p className="text-xs text-muted-foreground">
          This device cannot change who may use {machine}'s Chrome.
        </p>
      )}
    </div>
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

/** Threads acting in a profile; servers before per-tab ownership report one lease. */
function threadsOf(profile: BrowserExtensionProfile): ReadonlyArray<BrowserExtensionThreadUse> {
  if (profile.threads) return profile.threads;
  return profile.lease ? [{ ...profile.lease, tabs: profile.attachedTabs }] : [];
}

/** A thread by its title, as the sidebar shows it; ids mean nothing to people. */
export function ThreadName({
  environmentId,
  threadId,
}: {
  environmentId: EnvironmentId;
  threadId: string;
}) {
  const shell = useThreadShell({ environmentId, threadId: ThreadId.make(threadId) });
  const title = shell?.title?.trim();
  return (
    <span className="font-medium text-foreground">{title || "A thread no longer listed"}</span>
  );
}

/** A thread here by its sidebar title; one on another machine by the title that machine sent. */
function ThreadLabel({
  environmentId,
  use,
}: {
  environmentId: EnvironmentId;
  use: { readonly threadId: string; readonly title?: string; readonly machine?: string };
}) {
  if (use.machine === undefined)
    return <ThreadName environmentId={environmentId} threadId={use.threadId} />;
  return (
    <span>
      <span className="font-medium text-foreground">{use.title?.trim() || "Untitled thread"}</span>{" "}
      on {use.machine}
    </span>
  );
}

function ConnectedProfiles({
  environmentId,
  profiles,
  storeUrl,
  canOperate,
  busy,
  onStop,
}: {
  environmentId: EnvironmentId;
  profiles: ReadonlyArray<BrowserExtensionProfile>;
  storeUrl: string;
  canOperate: boolean;
  busy: string | null;
  onStop: (profileId: string, threadId?: string) => void;
}) {
  const stopButton = (key: string, label: string, onClick: () => void) => (
    <Button
      size="sm"
      variant="destructive-outline"
      disabled={!canOperate || busy !== null}
      onClick={onClick}
    >
      {busy === key ? <Spinner /> : <SquareIcon />}
      {label}
    </Button>
  );
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">Paired Chrome profiles</p>
      <ul className="divide-y divide-border/50 rounded-md border border-border/60">
        {profiles.map((profile) => {
          const threads = threadsOf(profile);
          const active = threads.length > 0 || profile.attachedTabs > 0;
          return (
            <li
              key={profile.id}
              data-testid="browser-extension-profile"
              className="space-y-2 px-3 py-2 text-sm"
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0 space-y-0.5">
                  <p className="font-medium">{profile.label}</p>
                  <p className="text-xs text-muted-foreground">
                    {profile.browser} · extension {profile.extensionVersion} · connected{" "}
                    {formatRelativeTimeLabel(profile.connectedAt)} ·{" "}
                    {threads.length === 0
                      ? "idle"
                      : `in use by ${threads.length} thread${threads.length === 1 ? "" : "s"}`}
                  </p>
                  {profile.fromStore === false && (
                    <p
                      data-testid="browser-extension-hand-loaded"
                      className="flex items-start gap-1.5 text-xs text-warning-foreground"
                    >
                      <CircleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
                      <span>
                        Loaded by hand, so it does not update itself. Remove it in{" "}
                        <code className="text-xs">chrome://extensions</code>, then{" "}
                        <a href={storeUrl} target="_blank" rel="noreferrer" className="underline">
                          add it from the Chrome Web Store
                          <ExternalLinkIcon className="ml-0.5 inline size-3" />
                          <span className="sr-only"> (opens the Chrome Web Store)</span>
                        </a>{" "}
                        and pair it under Pair another Chrome profile, with the same name.
                      </span>
                    </p>
                  )}
                </div>
                {active &&
                  threads.length !== 1 &&
                  stopButton(`stop:${profile.id}`, threads.length > 1 ? "Stop all" : "Stop", () =>
                    onStop(profile.id),
                  )}
              </div>
              {threads.length > 0 && (
                <ul className="space-y-1">
                  {threads.map((use) => (
                    <li
                      key={use.threadId}
                      data-testid="browser-extension-thread"
                      className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground"
                    >
                      <span className="min-w-0 truncate">
                        <ThreadLabel environmentId={environmentId} use={use} /> · {use.tabs} tab
                        {use.tabs === 1 ? "" : "s"} · last action{" "}
                        {formatRelativeTimeLabel(use.lastActionAt)}
                      </span>
                      {stopButton(`stop:${profile.id}:${use.threadId}`, "Stop", () =>
                        onStop(profile.id, use.threadId),
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function RecentActions({
  environmentId,
  actions,
}: {
  environmentId: EnvironmentId;
  actions: ReadonlyArray<BrowserExtensionAction>;
}) {
  if (actions.length === 0) return null;
  return (
    <details className="rounded-md border border-border/60 px-3 py-2 text-sm">
      <summary className="cursor-pointer">Recent agent actions</summary>
      <ul className="mt-2 space-y-0.5 text-xs">
        {actions.map((action, index) => (
          <li
            key={`${action.at}-${index}`}
            className="flex min-w-0 gap-2 text-muted-foreground"
            data-testid="browser-extension-action"
          >
            <span className="shrink-0 tabular-nums">{formatRelativeTimeLabel(action.at)}</span>
            <span className="shrink-0">
              <ThreadLabel environmentId={environmentId} use={action} />
            </span>
            <code className="shrink-0 text-foreground">{action.tool}</code>
            {action.url && <span className="min-w-0 truncate">{action.url}</span>}
          </li>
        ))}
      </ul>
    </details>
  );
}
