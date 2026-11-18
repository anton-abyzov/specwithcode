import {
  AuthAccessWriteScope,
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
 * `reports/chrome-profile-read.md`): the list came back with no TCC request,
 * so no prompt. Off would open the store link in the profile Chrome used
 * last, with a sentence that says so.
 */
export const CHROME_PROFILE_LIST_ON_MAC = true;

const NO_PROFILES: readonly string[] = [];

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
  canAnswer = true,
  failed = null,
  onReconnect,
  onAnswer,
}: AccessRowOpen & {
  readonly state: ChromeRowState;
  readonly machine: string;
  /** The pairing steps, drawn while the row is open. */
  readonly steps: ReactNode;
  readonly storeUrl: string;
  readonly busy?: boolean;
  /** This window may answer another machine's request (`AuthAccessWriteScope`). */
  readonly canAnswer?: boolean;
  /** Why the last answer or reconnect did not go through. */
  readonly failed?: string | null;
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
                ? canAnswer
                  ? tx("{asking} asks to use this Chrome for its threads.", {
                      asking: state.asking?.machine ?? "",
                    })
                  : tx(
                      "{asking} asks to use this Chrome for its threads. This window cannot answer it: answer in Settings > Chrome where you can change access.",
                      { asking: state.asking?.machine ?? "" },
                    )
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
          <a
            className="underline underline-offset-2"
            href={storeUrl}
            target="_blank"
            rel="noreferrer"
          >
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
      <>
        {/* The closed row says its state in words; open, the steps say it. */}
        {open ? null : (
          <AccessRowChip>
            {state.kind === "waiting" ? tx("Waiting for Chrome…") : tx("Not set up")}
          </AccessRowChip>
        )}
        {toggle(tx("Set up"))}
      </>
    ) : state.kind === "approval" && canAnswer ? (
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
        <AccessRowChip on>
          {tx("Paired: {names}", { names: state.paired.join(", ") })}
        </AccessRowChip>
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
          {failed ? (
            <span role="alert" className="block text-destructive-foreground">
              {failed}
            </span>
          ) : null}
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
  const canAnswer = useEnvironmentScope(environmentId, AuthAccessWriteScope);
  const teamRules = useTeamRules(environmentId);
  const locked = teamRulesToolLock(teamRules.summary, "chrome") !== null;
  const reading = online && canRead && !locked;
  const query = useEnvironmentQuery(
    reading ? projectWorkspace.browserExtensionStatus({ environmentId, input: {} }) : null,
  );
  const reconnect = useAtomCommand(projectWorkspace.browserExtensionReconnect);
  const answerPeer = useAtomCommand(projectWorkspace.browserExtensionPeer);
  const [busy, setBusy] = useState(false);
  // A failure belongs to the state it was pressed in, and goes when that state does.
  const [failed, setFailed] = useState<{ readonly kind: string; readonly message: string } | null>(
    null,
  );
  const status = query.data ?? null;
  // Profiles by name: the relay keeps each unique and a reconnect keeps it.
  const paired = status?.profiles.map((profile) => profile.label) ?? NO_PROFILES;
  const pairing = usePairingCode(environmentId, { profiles: paired });
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
  // A profile pairs while the steps are open: they close. A profile is new
  // when its name was not seen since the first read, so a reconnect is not.
  const seen = useRef<Set<string> | null>(null);
  const pairedKey = status === null ? null : paired.join("\n");
  useEffect(() => {
    if (pairedKey === null) return;
    const names = pairedKey === "" ? [] : pairedKey.split("\n");
    const known = seen.current;
    seen.current = new Set([...(known ?? []), ...names]);
    if (known !== null && open && names.some((name) => !known.has(name))) onOpenChange(false);
  }, [pairedKey, open, onOpenChange]);

  // Chrome's profiles are read once Set up is pressed, never when the step opens.
  const [profiles, setProfiles] = useState<readonly ChromeProfileChoice[] | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [profilesRead, setProfilesRead] = useState(false);
  const listed = useRef(false);
  useEffect(() => {
    if (!open || listed.current || !profileListAllowed()) return;
    listed.current = true;
    void readChromeProfiles()
      .catch(() => null)
      .then((found) => {
        setProfiles(found);
        // With several, none starts picked: the person picks where the accounts are (D-15).
        // With one there is no list, so that one is the profile.
        setChosen((current) => current ?? (found?.length === 1 ? found[0]!.directory : null));
        setProfilesRead(true);
      });
  }, [open]);
  // Until the read settles, Add to Chrome waits: a store link now could open in another profile.
  const profilesPending = open && profileListAllowed() && !profilesRead;
  const storeUrl = status?.storeUrl ?? BROWSER_EXTENSION_STORE_URL;
  const canOpenInProfile = profileListAllowed() && profiles !== null && profiles.length > 0;
  const tx = useTx();
  const run = async (action: () => Promise<{ readonly _tag: string }>) => {
    if (busy) return;
    setBusy(true);
    setFailed(null);
    try {
      const result = await action();
      if (result._tag === "Failure")
        setFailed({ kind: state.kind, message: tx("That did not go through. Try again.") });
    } catch {
      setFailed({ kind: state.kind, message: tx("That did not go through. Try again.") });
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
      canAnswer={canAnswer}
      failed={failed?.kind === state.kind ? failed.message : null}
      onReconnect={() => void run(() => reconnect({ environmentId, input: {} }))}
      onAnswer={(allow) => {
        const id = state.asking?.id;
        if (id !== undefined) void run(() => answerPeer({ environmentId, input: { id, allow } }));
      }}
      steps={
        <BrowserExtensionSteps
          profiles={profiles}
          profilesPending={profilesPending}
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
