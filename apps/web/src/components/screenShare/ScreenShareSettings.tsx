/**
 * Settings > Machines: screen sharing for the machine this app runs on (1490).
 *
 * Everything here goes through the desktop bridge to this machine's own app
 * and nowhere else: the switch is turned on only at the machine itself, and no
 * window, browser tab or other machine has a way to it. A page with no bridge
 * shows where to go instead of a control.
 */
import type {
  ScreenShareAuditEntry,
  ScreenShareEndReason,
  ScreenShareLocalState,
} from "@specweave-studio/contracts";
import { EyeIcon, ShieldAlertIcon } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";

import { useTx } from "../../i18n";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { SettingsSection } from "../settings/settingsLayout";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";

const SECTION_TITLE = "Screen sharing";
const SESSIONS_SHOWN = 8;
const ROW = "px-3 py-3 sm:px-4";

/** Why a session was not shown or ended, as this machine's own list says it. */
const REASON_HERE: Readonly<Partial<Record<ScreenShareEndReason, string>>> = {
  off: "sharing was off",
  busy: "another view was open",
  cooldown: "asked too often",
  no_permission: "no Screen Recording permission",
  denied: "denied here",
  prompt_timeout: "nobody answered",
  stopped_at_machine: "stopped here",
  viewer_ended: "ended by the device",
  viewer_silent: "the device went quiet",
  time_limit: "2 hour limit",
  device_removed: "device removed",
  handshake_failed: "secure session failed",
  protocol_error: "ended to be safe",
  banner_lost: "the notice could not be shown",
  app_quit: "the app was closed",
  turned_off: "sharing was turned off",
  wrong_code: "wrong code",
  grant_removed: "device removed here",
  no_host: "connection lost",
  host_refused: "this machine's server refused the app",
  host_replaced: "another program took the link",
};

const sessionOutcome = (entry: ScreenShareAuditEntry): string =>
  entry.outcome === "refused"
    ? "Not shown"
    : entry.outcome === "allowed_once"
      ? "Allowed once"
      : entry.outcome === "allowed_always"
        ? "Allowed, now always"
        : "Always allowed";

function Notice({ children }: { children: ReactNode }) {
  return (
    <div role="alert" className={`flex items-start gap-3 ${ROW}`} data-screen-share-notice="">
      <ShieldAlertIcon className="mt-0.5 size-4 shrink-0 text-warning-foreground" aria-hidden />
      <p className="min-w-0 flex-1 text-sm">{children}</p>
    </div>
  );
}

function ShortId({ id }: { id: string }) {
  return id === "" ? null : (
    <span className="shrink-0 rounded border border-border px-1.5 py-0.5 font-mono text-xs font-normal text-muted-foreground">
      {id}
    </span>
  );
}

export interface ScreenShareSettingsViewProps {
  /**
   * `here`: this window belongs to the app on this machine. `elsewhere`: a
   * browser tab or another machine's page, which has no way to the switch.
   */
  place: "here" | "elsewhere";
  /** Null until the app answered. */
  state: ScreenShareLocalState | null;
  /** A change is under way: the system may be asking for Touch ID or the password. */
  busy: boolean;
  onSetEnabled: (enabled: boolean) => void;
  onRemoveGrant: (thumbprint: string) => void;
}

export function ScreenShareSettingsView({
  place,
  state,
  busy,
  onSetEnabled,
  onRemoveGrant,
}: ScreenShareSettingsViewProps) {
  const tx = useTx();
  if (place === "elsewhere")
    return (
      <SettingsSection id="screen-sharing" title={tx(SECTION_TITLE)}>
        <p className={`text-sm text-muted-foreground ${ROW}`} data-screen-share-elsewhere="">
          {tx(
            "Turn this on at that machine. Screen sharing is switched on only in the SpecWithCode app on the machine whose screen is shown, by a person at it.",
          )}
        </p>
      </SettingsSection>
    );
  if (state === null)
    return (
      <SettingsSection id="screen-sharing" title={tx(SECTION_TITLE)}>
        <p className={`text-sm text-muted-foreground ${ROW}`}>{tx("Checking…")}</p>
      </SettingsSection>
    );
  if (!state.supported)
    return (
      <SettingsSection id="screen-sharing" title={tx(SECTION_TITLE)}>
        <p className={`text-sm text-muted-foreground ${ROW}`} data-screen-share-unsupported="">
          {tx(
            "This machine cannot show its screen yet. Screen sharing needs the SpecWithCode app on a Mac.",
          )}
        </p>
      </SettingsSection>
    );

  const sessions = state.audit.slice(0, SESSIONS_SHOWN);
  // Each device once, with what it may do: view, control, or both (1519).
  const devices = [...state.grants, ...(state.controlGrants ?? [])]
    .filter(
      (grant, index, all) =>
        all.findIndex((other) => other.thumbprint === grant.thumbprint) === index,
    )
    .map((grant) => ({
      grant,
      view: state.grants.find((other) => other.thumbprint === grant.thumbprint),
      control: state.controlGrants?.find((other) => other.thumbprint === grant.thumbprint),
    }));
  return (
    <SettingsSection
      id="screen-sharing"
      title={tx(SECTION_TITLE)}
      headerAction={
        state.active ? (
          <Badge variant="success" size="sm">
            {tx("Being viewed")}
          </Badge>
        ) : null
      }
    >
      <div className="divide-y divide-border/60" data-screen-share-settings="">
        <div className={`flex items-start gap-4 ${ROW}`}>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium" id="screen-share-switch-label">
              {tx("Let your approved devices view this machine's screen")}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {tx(
                "Off until you turn it on here. Turning it on asks for Touch ID or your password. A device's first view is allowed by someone at this machine, and a notice stays on screen the whole time it is viewed. View only: nothing can be clicked or typed from the device.",
              )}
            </p>
          </div>
          <Switch
            aria-labelledby="screen-share-switch-label"
            checked={state.enabled}
            disabled={busy}
            onCheckedChange={(checked) => onSetEnabled(checked)}
            data-screen-share-switch=""
          />
        </div>

        {state.storeHealthy ? null : (
          <Notice>
            {tx(
              "The saved screen sharing settings on this machine could not be read. Sharing is off and every device is asked again until you turn it on.",
            )}
          </Notice>
        )}
        {state.storeWritable ? null : (
          <Notice>
            {tx(
              "Screen sharing could not save a change on this machine. A choice you just made may not have been kept, and a session that cannot be listed does not start.",
            )}
          </Notice>
        )}
        {state.link === "refused" || state.link === "replaced" ? (
          <Notice>
            {tx(
              "Another program holds this machine's screen sharing link, so no device can view this screen through SpecWithCode right now. The app tries again every minute. If you did not start that program, turn screen sharing off.",
            )}
          </Notice>
        ) : null}
        {state.enabled && !state.screenRecording ? (
          <Notice>
            {tx(
              "SpecWithCode is not allowed to record this screen, so nothing can be shown. Allow it in System Settings > Privacy & Security > Screen & System Audio Recording, then quit and reopen SpecWithCode.",
            )}
          </Notice>
        ) : null}

        {state.active ? (
          <div className={`flex items-center gap-3 ${ROW}`} data-screen-share-active="">
            <EyeIcon className="size-4 shrink-0 text-success-foreground" aria-hidden />
            <p className="flex min-w-0 flex-1 flex-wrap items-center gap-2 text-sm">
              <span>
                {tx(
                  state.active.controlling === true
                    ? "{device} is controlling this screen, viewing since {when}."
                    : "{device} is viewing this screen, since {when}.",
                  {
                    device: state.active.label,
                    when: formatRelativeTimeLabel(state.active.startedAt),
                  },
                )}
              </span>
              <ShortId id={state.active.shortId} />
            </p>
            <Button
              size="sm"
              variant="destructive-outline"
              disabled={busy}
              onClick={() => onSetEnabled(false)}
            >
              {tx("Stop and turn off")}
            </Button>
          </div>
        ) : null}

        <div className={`space-y-2 ${ROW}`} data-screen-share-grants="">
          <p className="text-xs font-medium text-foreground">{tx("Always allowed devices")}</p>
          {devices.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {tx(
                "None. Each device asks at this machine before it views, until you choose Always allow for it.",
              )}
            </p>
          ) : (
            <ul className="space-y-2">
              {devices.map(({ grant, view, control }) => (
                <li
                  key={grant.thumbprint}
                  className="flex items-start gap-3"
                  data-screen-share-grant={grant.shortId}
                >
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-2 text-sm">
                      <span className="truncate">{grant.label}</span>
                      <ShortId id={grant.shortId} />
                    </p>
                    {view ? (
                      <p className="text-xs text-muted-foreground">
                        {tx("Allowed {allowed}, last viewed {viewed}. Ends after 30 days unused.", {
                          allowed: formatRelativeTimeLabel(view.grantedAt),
                          viewed: formatRelativeTimeLabel(view.lastUsedAt),
                        })}
                      </p>
                    ) : null}
                    {control ? (
                      <p
                        className="text-xs text-warning-foreground"
                        data-screen-share-control-grant=""
                      >
                        {tx(
                          "May also control this screen with nobody here, last {used}. Ends after 30 days unused.",
                          { used: formatRelativeTimeLabel(control.lastUsedAt) },
                        )}
                      </p>
                    ) : null}
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => onRemoveGrant(grant.thumbprint)}
                  >
                    {tx("Remove")}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className={`space-y-2 ${ROW}`} data-screen-share-sessions="">
          <p className="text-xs font-medium text-foreground">{tx("Recent sessions")}</p>
          {sessions.length === 0 ? (
            <p className="text-sm text-muted-foreground">{tx("No device has asked yet.")}</p>
          ) : (
            <ul className="space-y-1.5">
              {sessions.map((entry) => {
                const reason = entry.reason === undefined ? undefined : REASON_HERE[entry.reason];
                return (
                  <li
                    key={entry.id}
                    className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm"
                    data-screen-share-session={entry.outcome}
                  >
                    <span className="min-w-0 truncate">{entry.label}</span>
                    <ShortId id={entry.shortId} />
                    <span
                      className={
                        entry.outcome === "refused"
                          ? "text-muted-foreground"
                          : "text-success-foreground"
                      }
                    >
                      {tx(sessionOutcome(entry))}
                      {entry.control !== undefined && entry.control.outcome !== "refused"
                        ? tx(", and controlled")
                        : null}
                    </span>
                    {reason ? (
                      <span className="text-xs text-muted-foreground">{tx(reason)}</span>
                    ) : null}
                    <span className="ml-auto text-xs text-muted-foreground tabular-nums">
                      {formatRelativeTimeLabel(entry.at)}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
          <p className="text-xs text-muted-foreground">
            {tx(
              "This list records what other devices did. It is no proof against programs running on this machine itself.",
            )}
          </p>
        </div>
      </div>
    </SettingsSection>
  );
}

/**
 * The block wired to this machine's own app. In a browser tab it only says
 * where to go, and so does an app window whose page is about another machine:
 * the switch would act on the Mac the window is on, not the one being read about.
 */
export function ScreenShareSettings({ otherMachine = false }: { readonly otherMachine?: boolean }) {
  const bridge =
    typeof window === "undefined" || otherMachine ? undefined : window.desktopBridge?.screenShare;
  const [state, setState] = useState<ScreenShareLocalState | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (bridge === undefined) return;
    let gone = false;
    const read = () =>
      void bridge.getState().then(
        (next) => {
          if (!gone) setState(next);
        },
        () => undefined,
      );
    read();
    // Who is viewing and the session list change without this window doing anything.
    const timer = setInterval(read, 5_000);
    return () => {
      gone = true;
      clearInterval(timer);
    };
  }, [bridge]);

  if (bridge === undefined)
    return (
      <ScreenShareSettingsView
        place="elsewhere"
        state={null}
        busy={false}
        onSetEnabled={() => {}}
        onRemoveGrant={() => {}}
      />
    );
  const change = (ask: Promise<ScreenShareLocalState>) => {
    setBusy(true);
    void ask
      .then(
        (next) => setState(next),
        () => undefined,
      )
      .then(() => setBusy(false));
  };
  return (
    <ScreenShareSettingsView
      place="here"
      state={state}
      busy={busy}
      // The app's main process asks the system for Touch ID or the password; the answer says what is true afterwards.
      onSetEnabled={(enabled) => change(bridge.setEnabled(enabled))}
      onRemoveGrant={(thumbprint) => change(bridge.removeGrant(thumbprint))}
    />
  );
}
