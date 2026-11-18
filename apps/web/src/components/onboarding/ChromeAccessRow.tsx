import {
  AuthFilesystemReadScope,
  AuthTerminalOperateScope,
  BROWSER_EXTENSION_STORE_URL,
  type EnvironmentId,
} from "@specweave-studio/contracts";
import { useEffect, useRef, useState, type ReactNode } from "react";

import {
  canUseExternalBrowsers,
  openUrlInExternalBrowser,
  readChromeProfiles,
} from "../../browser/externalBrowsers";
import { useTx } from "../../i18n";
import { chromeRowState, type ChromeRowState } from "../../onboarding/chromeRowState.logic";
import { useEnvironment } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { projectWorkspace } from "../../studio/projectWorkspace";
import { teamRulesToolLock } from "../../teamRules/teamRulesView";
import { useTeamRules } from "../../teamRules/useTeamRules";
import {
  BROWSER_EXTENSION_POLL_MS,
  BrowserExtensionSteps,
  useChromeWhy,
  usePairingCode,
  type ChromeProfileChoice,
} from "../settings/BrowserExtensionSetup";
import type { AccessRowOpen } from "./AccessStep";
import { AccessRow, AccessRowAction, AccessRowChip, BrowserRowGlyph } from "./AccessRow";

/**
 * Whether the desktop app on macOS lists Chrome's profiles in this row. Set by
 * the check on a fresh macOS account (increment 1387, T-06,
 * `reports/chrome-profile-read.md`). Off means the store link opens in the
 * profile Chrome used last, with a sentence that says so.
 */
export const CHROME_PROFILE_LIST_ON_MAC = false;

function profileListAllowed(): boolean {
  if (!canUseExternalBrowsers()) return false;
  const platform = window.desktopBridge?.getClientPlatform?.();
  return platform !== "darwin" || CHROME_PROFILE_LIST_ON_MAC;
}

/**
 * The row as drawn: a state from `chromeRowState`, the steps to draw while it
 * is open, and its actions. Every state can be drawn from a fixture.
 */
export function ChromeAccessRowView({
  state,
  machine,
  open,
  onOpenChange,
  steps,
  storeUrl,
  busy = false,
  onReconnect,
  onAnswer,
}: AccessRowOpen & {
  readonly state: ChromeRowState;
  readonly machine: string;
  /** The pairing steps, drawn while the row is open. */
  readonly steps: ReactNode;
  readonly storeUrl: string;
  readonly busy?: boolean;
  readonly onReconnect: () => void;
  readonly onAnswer: (allow: boolean) => void;
}) {
  const tx = useTx();
  const why = useChromeWhy();
  const toggle = (label: string) => (
    <AccessRowAction
      expands={{ row: "browser", open }}
      onClick={() => onOpenChange(!open)}
      data-access-focus="browser-toggle"
    >
      {open ? tx("Hide") : label}
    </AccessRowAction>
  );
  const status: ReactNode =
    state.kind === "loading"
      ? tx("Checking Chrome…")
      : state.kind === "offline"
        ? tx("{machine} is offline.", { machine })
        : state.kind === "team-rules"
          ? tx("Turned off by your team's rules.")
          : state.kind === "not-allowed"
            ? tx("This window cannot pair a browser with {machine}.", { machine })
            : state.kind === "chrome-missing"
              ? tx("Chrome is not installed on {machine}.", { machine })
              : state.kind === "approval"
                ? tx("{asking} asks to use this Chrome for its threads.", {
                    asking: state.asking?.machine ?? "",
                  })
                : state.kind === "not-answering"
                  ? tx("Paired, not answering. Open Chrome, or reconnect.")
                  : state.kind === "paired"
                    ? state.paired.length > 1
                      ? `${why.another} ${why.several}`
                      : why.another
                    : null;
  const notes = state.kind === "paired" && (
    <>
      {state.outdated.length > 0 ? (
        <span className="block text-warning-foreground">
          {tx("{profiles}: an older extension.", { profiles: state.outdated.join(", ") })}{" "}
          <a className="underline underline-offset-2" href={storeUrl} target="_blank" rel="noreferrer">
            {tx("Update the extension")}
          </a>
        </span>
      ) : null}
      {state.notFromStore.length > 0 ? (
        <span className="block text-warning-foreground">
          {tx("{profiles}: not from the Chrome Web Store.", {
            profiles: state.notFromStore.join(", "),
          })}
        </span>
      ) : null}
      {state.unnamed.length > 0 ? (
        <span className="block">
          {tx("{profiles}: give it a name agents can tell apart.", {
            profiles: state.unnamed.join(", "),
          })}
        </span>
      ) : null}
    </>
  );
  const actions: ReactNode =
    state.kind === "not-set-up" || state.kind === "waiting" ? (
      toggle(tx("Set up"))
    ) : state.kind === "approval" ? (
      <>
        <AccessRowAction disabled={busy} onClick={() => onAnswer(true)}>
          {tx("Allow")}
        </AccessRowAction>
        <AccessRowAction disabled={busy} onClick={() => onAnswer(false)}>
          {tx("Decline")}
        </AccessRowAction>
      </>
    ) : state.kind === "paired" ? (
      <>
        <AccessRowChip on>{tx("Paired: {names}", { names: state.paired.join(", ") })}</AccessRowChip>
        {toggle(tx("Pair another profile"))}
      </>
    ) : state.kind === "not-answering" ? (
      <>
        <AccessRowAction disabled={busy} onClick={onReconnect}>
          {tx("Reconnect")}
        </AccessRowAction>
        {toggle(tx("Set up"))}
      </>
    ) : null;
  return (
    <AccessRow
      id="browser"
      glyph={<BrowserRowGlyph />}
      title={tx("Your browser")}
      done={state.kind === "paired"}
      state={
        <>
          <span className="block">{why.always}</span>
          {status ? (
            <span className="block" data-chrome-state={state.kind}>
              {status}
            </span>
          ) : (
            <span hidden data-chrome-state={state.kind} />
          )}
          {notes}
        </>
      }
      actions={actions}
      open={open && state.actionable && state.kind !== "approval"}
    >
      <p className="mb-2">{why.open}</p>
      {steps}
    </AccessRow>
  );
}

/** First-run's "Your browser" row for this computer's Chrome. */
export function ChromeAccessRow({
  environmentId,
  machine,
  open,
  onOpenChange,
  onDoneChange,
}: AccessRowOpen & {
  readonly environmentId: EnvironmentId;
  readonly machine: string;
  /** Told whether a profile is paired, for the step's picture. */
  readonly onDoneChange?: ((done: boolean) => void) | undefined;
}) {
  const environment = useEnvironment(environmentId);
  const online = environment?.connection.phase === "connected";
  const canRead = useEnvironmentScope(environmentId, AuthFilesystemReadScope);
  const canPair = useEnvironmentScope(environmentId, AuthTerminalOperateScope);
  const teamRules = useTeamRules(environmentId);
  const locked = teamRulesToolLock(teamRules.summary, "chrome") !== null;
  const reading = online && canRead && !locked;
  const query = useEnvironmentQuery(
    reading ? projectWorkspace.browserExtensionStatus({ environmentId, input: {} }) : null,
  );
  const reconnect = useAtomCommand(projectWorkspace.browserExtensionReconnect);
  const answerPeer = useAtomCommand(projectWorkspace.browserExtensionPeer);
  const [busy, setBusy] = useState(false);
  const status = query.data ?? null;
  const pairedCount = status?.profiles.length ?? 0;
  const pairing = usePairingCode(environmentId, { profiles: pairedCount });
  const state = chromeRowState({
    online,
    teamRulesLocked: locked,
    allowed: canRead && canPair,
    status,
    codeHandedOut: pairing.handedOut,
  });

  const done = state.kind === "paired";
  useEffect(() => {
    onDoneChange?.(done);
  }, [done, onDoneChange]);
  // While open, read every 3 s, so the row turns Paired within 3 s of a profile connecting.
  const refresh = query.refresh;
  useEffect(() => {
    if (!open || !reading) return;
    const timer = setInterval(refresh, BROWSER_EXTENSION_POLL_MS);
    return () => clearInterval(timer);
  }, [open, reading, refresh]);
  // A profile pairs while the steps are open: they close.
  const wasPaired = useRef(pairedCount);
  useEffect(() => {
    if (pairedCount > wasPaired.current && open) onOpenChange(false);
    wasPaired.current = pairedCount;
  }, [pairedCount, open, onOpenChange]);

  // Chrome's profiles are read once Set up is pressed, never when the step opens.
  const [profiles, setProfiles] = useState<readonly ChromeProfileChoice[] | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const listed = useRef(false);
  useEffect(() => {
    if (!open || listed.current || !profileListAllowed()) return;
    listed.current = true;
    void readChromeProfiles().then((found) => {
      setProfiles(found);
      setChosen((current) => current ?? found?.[0]?.directory ?? null);
    });
  }, [open]);
  const storeUrl = status?.storeUrl ?? BROWSER_EXTENSION_STORE_URL;
  const canOpenInProfile = profileListAllowed() && profiles !== null && profiles.length > 0;
  const run = async (action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
      refresh();
    }
  };
  return (
    <ChromeAccessRowView
      state={state}
      machine={machine}
      open={open}
      onOpenChange={onOpenChange}
      storeUrl={storeUrl}
      busy={busy}
      onReconnect={() => void run(() => reconnect({ environmentId, input: {} }))}
      onAnswer={(allow) => {
        const id = state.asking?.id;
        if (id !== undefined) void run(() => answerPeer({ environmentId, input: { id, allow } }));
      }}
      steps={
        <BrowserExtensionSteps
          profiles={profiles}
          chosen={chosen}
          onChoose={setChosen}
          storeUrl={storeUrl}
          onAddToChrome={
            canOpenInProfile
              ? () =>
                  void openUrlInExternalBrowser(storeUrl, {
                    browserId: "chrome",
                    ...(chosen !== null ? { profileDirectory: chosen } : {}),
                  }).catch(() => undefined)
              : undefined
          }
          code={pairing.code}
          onCopyCode={pairing.copy}
          onShowCode={pairing.show}
          onHideCode={pairing.hide}
          canPair={canPair}
          waiting={pairing.handedOut}
        />
      }
    />
  );
}
