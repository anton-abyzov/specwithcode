// @effect-diagnostics globalDate:off -- A plain class outside any Effect fiber; its clock is handed in and only formatted here.
/**
 * The rules of a screen sharing session on the machine being viewed (1490).
 * No Electron in here: the windows, the capture, the clock and the system's
 * authentication are handed in, so every rule below runs in a plain test.
 *
 * One session at a time. Its life:
 *
 *   hello -> proof -> (prompt -> authenticate) -> (code, first use) -> live -> ended
 *
 * - Nothing starts while sharing is off, unsupported, without the Screen
 *   Recording grant, busy, or while the device is in its quiet time.
 * - Whether this is a device's first time is read from this machine's own
 *   record of devices that typed its code. What the viewer says about itself
 *   can only add a first time, never take one away.
 * - A grant skips the prompt only when it is not a first time. A first-time
 *   viewer is always asked, so its first view needs a person at this machine.
 * - "Allow" is a click plus the system's own authentication. A click alone
 *   never allows: a click can be synthetic. The system's dialog names the
 *   exact thing being allowed, one dialog is up at a time, and its answer
 *   counts only for the session and the choice it was asked for.
 * - On first use no frame leaves before the viewer sent back the code that
 *   only this machine's screen shows. The code is for the person at the
 *   viewing device: it tells them the machine is theirs and not a stand-in.
 *   It is not what protects this machine; the prompt and the system's
 *   authentication are.
 * - The banner comes before the first frame. No banner, no session.
 * - The session is written to the list before the first frame. No entry, no session.
 * - From the viewer only four records are read; anything else ends the session.
 *   1519 adds a fifth, `viewport`, which this machine announces in its `live`
 *   state; only a viewer that saw that sends it, and only after it arrived do
 *   frames carry anything slice 1 did not.
 * - Control (1519) is asked for from a live view, only when this machine
 *   announced `control`: its own prompt, its own grant ("Always allow
 *   control" plus the system's authentication), its own banner wording. A
 *   view grant never allows control; a control grant counts only inside a
 *   view that the view rules already let start. The banner says
 *   "is controlling" and the list records it before the helper starts, and
 *   every end of control lets go of every key and button held.
 */
import {
  SCREEN_SHARE_CODE_TRIES,
  SCREEN_SHARE_CONTROL_ASKS,
  SCREEN_SHARE_FEATURES,
  SCREEN_SHARE_HELD_SILENCE_MS,
  SCREEN_SHARE_HANDSHAKE_MS,
  SCREEN_SHARE_PROMPT_MS,
  SCREEN_SHARE_RECORD,
  SCREEN_SHARE_SESSION_MAX_MS,
  SCREEN_SHARE_SILENCE_MS,
  SCREEN_SHARE_WIRE,
  decodeScreenShareJson,
  encodeScreenShareFrame,
  encodeScreenShareWire,
  encodeScreenShareWireJson,
  type ScreenShareAuditEntry,
  type ScreenShareAuditOutcome,
  type ScreenShareControlReason,
  type ScreenShareControlState,
  type ScreenShareDisplay,
  type ScreenShareEndReason,
  type ScreenShareHostStatus,
  type ScreenShareSessionState,
  type ScreenShareTypingBlock,
  type ScreenShareViewerDevice,
} from "@specweave-studio/contracts";
import {
  acceptScreenShareProof,
  makeScreenShareOpener,
  makeScreenShareSealer,
  screenShareCodeMatches,
  startScreenShareTarget,
  type ScreenShareOpener,
  type ScreenShareSealer,
  type ScreenShareTargetStart,
} from "@specweave-studio/shared/screenShareChannel";

import {
  HeldInput,
  parseInputRecord,
  takeInputTurn,
  toHelperEvents,
  type DisplayBounds,
  type ScreenControlLink,
  type ScreenControlStart,
} from "./screenControl.logic.ts";
import {
  fastLooksAfter,
  nextLookDelay,
  parseViewport,
  takeViewportTurn,
  type Viewport,
} from "./screenSharePicture.logic.ts";
import type { ScreenShareStore } from "./ScreenShareStore.ts";

/** One look at a display. */
export type ScreenShareGrab =
  | {
      readonly kind: "frame";
      readonly jpeg: Uint8Array;
      readonly width: number;
      readonly height: number;
      readonly pointer?: { readonly x: number; readonly y: number };
      /** Equal for two pictures that are the same. */
      readonly digest: string;
      /** 1519: how long the look and the encode took, and the quality it was encoded at. */
      readonly grabMs?: number;
      readonly encodeMs?: number;
      readonly quality?: number;
    }
  /** 1519: the picture is the one sent last (`previousDigest`); it was not encoded. */
  | { readonly kind: "same" }
  /** The machine is locked, or it cannot be told that it is not. */
  | { readonly kind: "locked" }
  /** No picture this time: the capture failed or the display is asleep. */
  | { readonly kind: "none" };

/** What one look asks of the capture (1519). */
export interface ScreenShareLook {
  /** The viewer's window and choice; null until it said them (slice 1's picture). */
  readonly viewport: Viewport | null;
  /** The digest of the picture sent last: a look that finds it again returns `same`. */
  readonly previousDigest: string | null;
}

export interface ScreenSharePromptView {
  readonly sid: string;
  readonly label: string;
  /** What the device calls itself now, when that is not the approved name. */
  readonly claimedLabel?: string;
  readonly shortId: string;
  /** `ask`: Deny, Allow once, Always allow. `code`: allowed; the code is being typed on the device. */
  readonly stage: "ask" | "code";
  /** 1519: the device asks to control the screen, not to view it. */
  readonly kind?: "control";
  /** First use only: the six digits to type on the device. */
  readonly code?: string;
  readonly expiresAt: number;
}

export interface ScreenShareBannerView {
  readonly label: string;
  readonly shortId: string;
  readonly startedAt: number;
  /** 1519: the device controls the screen. */
  readonly controlling?: boolean;
}

export interface ScreenShareSessionDeps {
  readonly store: ScreenShareStore;
  /** This build can share this system's screen at all. */
  readonly platformSupported: boolean;
  /** The Screen Recording grant, asked each time. */
  readonly screenRecording: () => boolean;
  readonly now: () => number;
  /** Runs `run` once after `ms`; the result cancels it. */
  readonly after: (ms: number, run: () => void) => () => void;
  /** A handshake message or sealed record for the viewer of `sid`. */
  readonly send: (sid: string, payload: Uint8Array) => void;
  /** Tells the server the session is over, with the reason the viewer reads. */
  readonly close: (sid: string, reason: ScreenShareEndReason) => void;
  /** The system's own check that a person is here: Touch ID or the account password. */
  readonly authenticate: (reason: string) => Promise<boolean>;
  readonly prompt: {
    readonly show: (view: ScreenSharePromptView) => void;
    readonly hide: () => void;
  };
  readonly banner: {
    /** False when the banner could not be put on screen. */
    readonly show: (view: ScreenShareBannerView) => boolean;
    readonly hide: () => void;
  };
  readonly capture: {
    readonly displays: () => ReadonlyArray<ScreenShareDisplay>;
    readonly grab: (displayId: string, look?: ScreenShareLook) => Promise<ScreenShareGrab>;
    /** Keeps the display from sleeping while true. */
    readonly keepAwake: (on: boolean) => void;
  };
  /** Something a window or the server shows has changed. */
  readonly changed: () => void;
  /** 1519: control of this screen. Absent where it cannot be controlled. */
  readonly control?: ScreenShareControlDeps;
}

export interface ScreenShareControlDeps {
  /** Whether control can work now: the helper is here and the app has Accessibility. */
  readonly available: () => Promise<boolean>;
  /** Starts the helper for one control session. */
  readonly start: (events: {
    readonly onBlocked: (blocked: ScreenShareTypingBlock | null) => void;
    /** The helper went away on its own. */
    readonly onExit: () => void;
  }) => Promise<ScreenControlStart>;
  /** A display's place in global points, or null when it is gone. */
  readonly bounds: (displayId: string) => DisplayBounds | null;
  /** Lets go of keys and buttons a helper that went away still held. */
  readonly releaseOrphaned: (held: {
    readonly keys: ReadonlyArray<string>;
    readonly buttons: ReadonlyArray<string>;
  }) => void;
  /** Computer use on this machine holds off while true. */
  readonly controlled: (on: boolean) => void;
}

type ControlMode = "off" | "asking" | "authenticating" | "starting" | "on";

interface Control {
  mode: ControlMode;
  /** The viewer asked at least once, so it reads control records. */
  requested: boolean;
  /** Times this session put the control prompt up. */
  asks: number;
  /** System dialogs for this control prompt that ended without a person. */
  authTries: number;
  outcome?: ScreenShareAuditOutcome;
  grantOnStart: boolean;
  startedAt?: number;
  endedAt?: number;
  link?: ScreenControlLink;
  held: HeldInput;
  inputTimes: Array<number>;
  blocked: ScreenShareTypingBlock | null;
  cancelAsk?: () => void;
  cancelHeld?: () => void;
}

type Phase = "hello" | "proof" | "prompt" | "authenticating" | "code" | "live";

interface Session {
  readonly sid: string;
  readonly environmentId: string;
  readonly device: ScreenShareViewerDevice;
  readonly openedAt: number;
  phase: Phase;
  start?: ScreenShareTargetStart;
  code?: string;
  firstUse: boolean;
  sealer?: ScreenShareSealer;
  opener?: ScreenShareOpener;
  outcome: ScreenShareAuditOutcome;
  grantOnLive: boolean;
  codeTriesLeft: number;
  /** System dialogs for this prompt that ended without a person. */
  authTries: number;
  startedAt?: number;
  displays: ReadonlyArray<ScreenShareDisplay>;
  displayId: string;
  seq: number;
  unconfirmed: number | null;
  grabbing: boolean;
  lastDigest: string | null;
  showingLocked: boolean;
  frames: number;
  lastHeard: number;
  /** 1519: the viewer's window and picture choice, once it said them. */
  viewport: Viewport | null;
  viewportTimes: Array<number>;
  /** The newest viewport that came over the rate limit: applied once the limit allows. */
  pendingViewport: Viewport | null;
  /** Looks left at the fast pace after the last change. */
  fastLooks: number;
  /** When the capture of the frame now unconfirmed started. */
  unconfirmedAt: number | null;
  /** From the start of the last confirmed frame's capture to its "frame received". */
  lastConfirmMs?: number;
  /** 1519: whether this machine can be controlled, once it was found out. */
  controlAvailable: boolean;
  control: Control;
  /** A sealed record was held back after the end, so nothing sealed after it would open. */
  gap?: true;
  /** Cancels for the timers this session holds: the stage's deadline, the time limit, the next frame. */
  cancelStage?: () => void;
  cancelLimit?: () => void;
  cancelTick?: () => void;
  /** Viewer records are handled one after another, in the order they came. */
  inbox: Promise<void>;
}

const encoder = new TextEncoder();
const wire = encodeScreenShareWire;
const jsonBody = decodeScreenShareJson;

/** After the system's dialog ended without a person, how long before another may be put up. */
export const AUTHENTICATE_PAUSE_MS = 3_000;
/** System dialogs one prompt may put up that end without a person, before it counts as Deny. */
export const AUTHENTICATE_TRIES = 3;

/**
 * Ends that count toward a device's quiet time, and only once a person here
 * was asked. Before that the device has proved nothing: whoever holds a copy
 * of its sign-in ticket could open and fail as often as the server lets it,
 * and counting those would keep the real device away. The server's own limit
 * on opens bounds them instead.
 */
const STRIKES: ReadonlySet<ScreenShareEndReason> = new Set([
  "denied",
  "prompt_timeout",
  "wrong_code",
  // Leaving, or sending something that makes no sense, after a person was made to look.
  "viewer_ended",
  "protocol_error",
]);

export class ScreenShareSessions {
  private session: Session | null = null;
  private pending: Promise<unknown> = Promise.resolve();
  /** The system's dialog is up. A second one is never put over it. */
  private asking = false;
  /** When the system's dialog last ended without a person: no new one for a moment after. */
  private notPresentAt = Number.NEGATIVE_INFINITY;
  /** Counts every use of the switch, so an old answer cannot undo a newer choice. */
  private switchUses = 0;
  private readonly deps: ScreenShareSessionDeps;

  constructor(deps: ScreenShareSessionDeps) {
    this.deps = deps;
  }

  private track<T>(work: Promise<T>): Promise<T> {
    this.pending = Promise.all([
      this.pending,
      work.then(
        () => undefined,
        () => undefined,
      ),
    ]);
    return work;
  }

  /**
   * Resolves once everything already under way has finished: records being
   * opened or sealed, a look at the screen, a last word on its way out. The
   * app waits on it before quitting; nothing waits on it to decide anything.
   */
  async idle(): Promise<void> {
    for (;;) {
      const seen = this.pending;
      await seen;
      if (seen === this.pending) return;
    }
  }

  /** What the server repeats to a device that asks before a session exists. */
  status(): ScreenShareHostStatus {
    const { store, platformSupported } = this.deps;
    return {
      enabled: store.enabled,
      supported: platformSupported && store.supported,
      busy: this.session !== null,
    };
  }

  /** The device viewing right now, for the settings page. */
  active(): {
    readonly label: string;
    readonly shortId: string;
    readonly startedAt: string;
    readonly controlling?: boolean;
  } | null {
    const session = this.session;
    return session === null || session.startedAt === undefined
      ? null
      : {
          label: session.device.label,
          shortId: session.device.shortId,
          startedAt: new Date(session.startedAt).toISOString(),
          ...(session.control.mode === "on" ? { controlling: true } : {}),
        };
  }

  // -------------------------------------------------------------------------
  // From the server.

  opened(sid: string, environmentId: string, device: ScreenShareViewerDevice): void {
    const { store, platformSupported } = this.deps;
    const refuse = (reason: ScreenShareEndReason) => {
      this.audit({ id: sid, device, outcome: "refused", reason, endedAt: this.deps.now() });
      this.deps.close(sid, reason);
    };
    if (this.session !== null) return this.deps.close(sid, "busy");
    if (!platformSupported || !store.supported) return refuse("unsupported");
    if (!store.enabled) return refuse("off");
    if (!this.deps.screenRecording()) return refuse("no_permission");
    if (store.inCooldown(device.thumbprint)) return refuse("cooldown");

    const session: Session = {
      sid,
      environmentId,
      device,
      openedAt: this.deps.now(),
      phase: "hello",
      firstUse: true,
      outcome: "refused",
      grantOnLive: false,
      codeTriesLeft: SCREEN_SHARE_CODE_TRIES,
      authTries: 0,
      displays: [],
      displayId: "",
      seq: 0,
      unconfirmed: null,
      grabbing: false,
      lastDigest: null,
      showingLocked: false,
      frames: 0,
      lastHeard: this.deps.now(),
      viewport: null,
      viewportTimes: [],
      pendingViewport: null,
      fastLooks: 0,
      unconfirmedAt: null,
      controlAvailable: false,
      control: {
        mode: "off",
        requested: false,
        asks: 0,
        authTries: 0,
        grantOnStart: false,
        held: new HeldInput(),
        inputTimes: [],
        blocked: null,
      },
      inbox: Promise.resolve(),
    };
    this.session = session;
    const control = this.deps.control;
    if (control !== undefined)
      void this.track(
        control.available().then(
          (available) => {
            if (this.session !== session || !available) return;
            session.controlAvailable = true;
            // A view that went live before the answer hears of control now.
            if (session.phase === "live" && !session.showingLocked) this.sendLive(session);
          },
          () => undefined,
        ),
      );
    session.cancelStage = this.deps.after(SCREEN_SHARE_HANDSHAKE_MS, () =>
      this.end(session, "handshake_failed"),
    );
    this.deps.changed();
  }

  /** A message from the viewer of `sid`, as the server passed it on. */
  received(sid: string, payload: Uint8Array): void {
    const session = this.session;
    if (session === null || session.sid !== sid || payload.length === 0) return;
    session.inbox = this.track(
      session.inbox
        .then(() => (this.session === session ? this.handle(session, payload) : undefined))
        .catch(() => this.end(session, "protocol_error")),
    );
  }

  /** The viewer's socket closed. */
  closed(sid: string): void {
    const session = this.session;
    if (session !== null && session.sid === sid) this.end(session, "viewer_ended");
  }

  /** The server went away: every session it carried is over. */
  disconnected(): void {
    if (this.session !== null) this.end(this.session, "no_host");
  }

  // -------------------------------------------------------------------------
  // From this machine's own windows.

  /**
   * Asks the system whether a person is here, for one named thing. False when
   * they are not, when it cannot be asked, or when another such dialog is up:
   * two dialogs at once would let one be answered in place of the other.
   */
  private async personPresent(reason: string): Promise<"present" | "absent" | "not_asked"> {
    if (this.asking) return "not_asked";
    // A dialog that was just cancelled or failed is not put straight back up:
    // a click that keeps summoning it gets one dialog every few seconds at most.
    if (this.deps.now() - this.notPresentAt < AUTHENTICATE_PAUSE_MS) return "not_asked";
    this.asking = true;
    let present = false;
    try {
      present = (await this.deps.authenticate(reason)) === true;
    } catch {
      present = false;
    } finally {
      this.asking = false;
    }
    if (!present) this.notPresentAt = this.deps.now();
    return present ? "present" : "absent";
  }

  /** A button in the prompt window. Only the window's own frame may call this. */
  async answerPrompt(sid: string, answer: "deny" | "once" | "always"): Promise<void> {
    const session = this.session;
    if (session === null || session.sid !== sid) return;
    // While live, the only prompt up is the one asking about control.
    if (session.phase === "live") return this.answerControlPrompt(session, answer);
    // Deny needs nothing and wins at any point before the screen is shown.
    if (answer === "deny") return this.end(session, "denied");
    if (session.phase !== "prompt" || this.asking) return;
    session.phase = "authenticating";
    const { label, shortId } = session.device;
    // The dialog says which of the two was pressed, so a press that was not the
    // person's own reads wrong to them before they authenticate.
    const present = await this.personPresent(
      answer === "always"
        ? `always allow "${label}" (${shortId}) to view this Mac's screen without asking again`
        : `allow "${label}" (${shortId}) to view this Mac's screen this once`,
    );
    // The session may have timed out, been denied or ended while the dialog was up:
    // then the answer is for nothing, and is dropped.
    if (this.session !== session || session.phase !== "authenticating") return;
    if (present !== "present") {
      // Not allowed, not denied: the prompt stays until someone answers or its time
      // runs out. A few dialogs that came to nothing are a refusal.
      if (present === "absent") session.authTries += 1;
      if (session.authTries >= AUTHENTICATE_TRIES) return this.end(session, "denied");
      session.phase = "prompt";
      return;
    }
    session.outcome = answer === "always" ? "allowed_always" : "allowed_once";
    session.grantOnLive = answer === "always";
    if (!session.firstUse) return this.goLive(session);
    session.phase = "code";
    session.cancelStage?.();
    const expiresAt = this.deps.now() + SCREEN_SHARE_PROMPT_MS;
    session.cancelStage = this.deps.after(SCREEN_SHARE_PROMPT_MS, () =>
      this.end(session, "prompt_timeout"),
    );
    this.deps.prompt.show({ ...this.promptOf(session), stage: "code", expiresAt });
    this.sendState(session, { phase: "needs_code", triesLeft: session.codeTriesLeft });
  }

  /** Stop on the banner. */
  stop(): void {
    if (this.session !== null) this.end(this.session, "stopped_at_machine");
  }

  /** The banner window is gone and was not closed by us. */
  bannerLost(): void {
    if (this.session?.phase === "live") this.end(this.session, "banner_lost");
  }

  /**
   * The switch. Turning on needs the system's authentication; turning off
   * needs nothing and ends whatever is running.
   */
  async setEnabled(enabled: boolean): Promise<boolean> {
    const { store } = this.deps;
    this.switchUses += 1;
    if (!enabled) {
      const saved = store.setEnabled(false);
      if (this.session !== null) this.end(this.session, "turned_off");
      this.deps.changed();
      return saved;
    }
    if (!this.deps.platformSupported || !store.supported) return false;
    if (store.enabled) return true;
    const use = this.switchUses;
    const present = await this.personPresent("turn on screen sharing for this Mac");
    // Turned off, or asked again, while the dialog was up: this answer is stale.
    const saved = present === "present" && use === this.switchUses && store.setEnabled(true);
    this.deps.changed();
    return saved;
  }

  removeGrant(thumbprint: string): void {
    this.deps.store.removeGrant(thumbprint);
    if (this.session?.device.thumbprint === thumbprint) this.end(this.session, "grant_removed");
    this.deps.changed();
  }

  /** The app is quitting. */
  shutdown(): void {
    if (this.session !== null) this.end(this.session, "app_quit");
  }

  // -------------------------------------------------------------------------

  private async handle(session: Session, payload: Uint8Array): Promise<void> {
    const type = payload[0];
    const body = payload.subarray(1);
    if (type === SCREEN_SHARE_WIRE.hello && session.phase === "hello")
      return this.hello(session, body);
    if (type === SCREEN_SHARE_WIRE.proof && session.phase === "proof")
      return this.proof(session, body);
    if (type === SCREEN_SHARE_WIRE.sealed && session.opener !== undefined) {
      const record = await session.opener.open(body);
      if (this.session !== session) return;
      return this.record(session, record.type, record.data);
    }
    this.end(session, session.opener === undefined ? "handshake_failed" : "protocol_error");
  }

  private hello(session: Session, body: Uint8Array): void {
    try {
      session.start = startScreenShareTarget({
        hello: jsonBody(body),
        environmentId: session.environmentId,
        sessionId: session.sid,
        attestedThumbprint: session.device.thumbprint,
        machineKey: this.deps.store.machineKey,
      });
    } catch {
      return this.end(session, "handshake_failed");
    }
    // This machine's record decides. A viewer that says it does not know this
    // machine is believed (it has no key to check against); one that says it
    // does is not, unless its person typed this machine's code here before.
    session.firstUse =
      !session.start.hello.knowsMachine || !this.deps.store.knowsDevice(session.device.thumbprint);
    session.phase = "proof";
    this.deps.send(
      session.sid,
      encodeScreenShareWireJson(SCREEN_SHARE_WIRE.challenge, session.start.challenge),
    );
  }

  private proof(session: Session, body: Uint8Array): void {
    try {
      const accepted = acceptScreenShareProof({
        start: session.start!,
        proof: jsonBody(body),
        environmentId: session.environmentId,
        sessionId: session.sid,
        nowEpochSeconds: Math.floor(this.deps.now() / 1000),
      });
      // One start answers one proof. It is gone whether the proof held or not.
      delete session.start;
      session.code = accepted.code;
      session.sealer = makeScreenShareSealer(accepted.keys.toViewer, session.sid);
      session.opener = makeScreenShareOpener(accepted.keys.toTarget, session.sid);
    } catch {
      delete session.start;
      return this.end(session, "handshake_failed");
    }
    session.cancelStage?.();
    // A grant counts only for a device this machine has seen through a first use.
    if (!session.firstUse && this.deps.store.hasGrant(session.device.thumbprint)) {
      session.outcome = "allowed_by_grant";
      return this.goLive(session);
    }
    session.phase = "prompt";
    const expiresAt = this.deps.now() + SCREEN_SHARE_PROMPT_MS;
    session.cancelStage = this.deps.after(SCREEN_SHARE_PROMPT_MS, () =>
      this.end(session, "prompt_timeout"),
    );
    this.deps.prompt.show({ ...this.promptOf(session), stage: "ask", expiresAt });
    this.sendState(session, { phase: "waiting_for_approval" });
    this.deps.changed();
  }

  private promptOf(session: Session): Omit<ScreenSharePromptView, "stage" | "expiresAt"> {
    const { label, claimedLabel, shortId } = session.device;
    return {
      sid: session.sid,
      label,
      ...(claimedLabel === undefined ? {} : { claimedLabel }),
      shortId,
      ...(session.firstUse && session.code !== undefined ? { code: session.code } : {}),
    };
  }

  private record(session: Session, type: number, data: Uint8Array): void {
    const body = jsonBody(data);
    if (body === null) return this.end(session, "protocol_error");
    if (type === SCREEN_SHARE_RECORD.end) return this.end(session, "viewer_ended");

    if (type === SCREEN_SHARE_RECORD.confirmCode && session.phase === "code") {
      if (typeof body.code !== "string" || body.code.length > 32)
        return this.end(session, "protocol_error");
      if (screenShareCodeMatches(body.code, session.code!)) {
        // Not kept: the next time is a first time again. Never a reason to refuse this one.
        this.deps.store.rememberDevice(session.device.thumbprint);
        return this.goLive(session);
      }
      session.codeTriesLeft -= 1;
      if (session.codeTriesLeft <= 0) return this.end(session, "wrong_code");
      return this.sendState(session, { phase: "needs_code", triesLeft: session.codeTriesLeft });
    }

    if (session.phase === "live") {
      if (type === SCREEN_SHARE_RECORD.frameReceived && Number.isInteger(body.seq)) {
        const seq = body.seq as number;
        // A viewer can only have drawn what was sent.
        if (seq < 0 || seq > session.seq) return this.end(session, "protocol_error");
        session.lastHeard = this.deps.now();
        if (seq === session.unconfirmed) {
          if (session.unconfirmedAt !== null)
            session.lastConfirmMs = session.lastHeard - session.unconfirmedAt;
          session.unconfirmed = null;
          session.unconfirmedAt = null;
        }
        return;
      }
      if (type === SCREEN_SHARE_RECORD.viewport) {
        const viewport = parseViewport(body);
        if (viewport === null) return this.end(session, "protocol_error");
        session.lastHeard = this.deps.now();
        // A window being dragged says its size many times; a few a second are enough. The
        // newest one over the limit is kept, so the last word is never lost.
        if (!takeViewportTurn(session.viewportTimes, session.lastHeard)) {
          session.pendingViewport = viewport;
          return;
        }
        session.pendingViewport = null;
        return this.applyViewport(session, viewport);
      }
      if (type === SCREEN_SHARE_RECORD.showDisplay && typeof body.displayId === "string") {
        if (!session.displays.some((display) => display.id === body.displayId))
          return this.end(session, "protocol_error");
        session.lastHeard = this.deps.now();
        if (session.displayId === body.displayId) return;
        // Keys held on one display are let go before the picture moves to another.
        this.releaseHeld(session);
        session.displayId = body.displayId;
        session.lastDigest = null;
        return this.sendLive(session);
      }
      // 1519 control: only from a viewer that saw `control` in this machine's live state.
      if (session.controlAvailable) {
        if (type === SCREEN_SHARE_RECORD.controlRequest) return this.requestControl(session);
        if (type === SCREEN_SHARE_RECORD.input) return this.input(session, body);
        if (type === SCREEN_SHARE_RECORD.controlEnd) {
          session.lastHeard = this.deps.now();
          if (session.control.mode !== "off") void this.stopControl(session, "ended");
          return;
        }
      }
    }
    this.end(session, "protocol_error");
  }

  private goLive(session: Session): void {
    const { store, capture, banner, prompt } = this.deps;
    session.cancelStage?.();
    delete session.cancelStage;
    prompt.hide();
    const displays = capture.displays();
    if (displays.length === 0) return this.end(session, "no_permission");
    const startedAt = this.deps.now();
    // The banner goes up first. If it cannot, nothing is shown to anyone.
    if (!banner.show({ label: session.device.label, shortId: session.device.shortId, startedAt }))
      return this.end(session, "banner_lost");
    // The list of sessions is the record of who saw this screen. One that cannot
    // be written is one that would not be on it, so it does not start.
    if (
      !this.audit({ id: session.sid, device: session.device, outcome: session.outcome, startedAt })
    ) {
      banner.hide();
      return this.end(session, "unsupported");
    }
    session.phase = "live";
    session.startedAt = startedAt;
    session.lastHeard = startedAt;
    session.displays = displays;
    session.displayId = (displays.find((display) => display.primary) ?? displays[0]!).id;
    const { thumbprint, label, shortId } = session.device;
    if (session.grantOnLive && !store.addGrant({ thumbprint, label, shortId })) {
      // "Always allow" that could not be kept is an allow for this once, and the list says so.
      session.outcome = "allowed_once";
      this.audit({ id: session.sid, device: session.device, outcome: session.outcome, startedAt });
    } else if (session.outcome === "allowed_by_grant") store.touchGrant(thumbprint);
    capture.keepAwake(true);
    session.cancelLimit = this.deps.after(SCREEN_SHARE_SESSION_MAX_MS, () =>
      this.end(session, "time_limit"),
    );
    this.sendLive(session);
    this.tick(session);
    this.deps.changed();
  }

  private sendLive(session: Session): void {
    session.showingLocked = false;
    this.sendState(session, {
      phase: "live",
      displays: session.displays,
      displayId: session.displayId,
      endsAt: session.startedAt! + SCREEN_SHARE_SESSION_MAX_MS,
      features: session.controlAvailable
        ? [SCREEN_SHARE_FEATURES.viewport, SCREEN_SHARE_FEATURES.control]
        : [SCREEN_SHARE_FEATURES.viewport],
    });
  }

  private applyViewport(session: Session, viewport: Viewport): void {
    const before = session.viewport;
    session.viewport = viewport;
    // A new size needs nothing here: the digest carries the picture's size, so a picture
    // that comes out bigger or smaller differs on its own. A new choice keeps the size and
    // changes only the encoding, so the last one is not compared against.
    if (before === null || before.picture !== viewport.picture) session.lastDigest = null;
  }

  /** One turn of the frame loop, then the next one soon while the picture changes. */
  private tick(session: Session): void {
    if (this.session !== session || session.phase !== "live") return;
    if (this.deps.now() - session.lastHeard > SCREEN_SHARE_SILENCE_MS)
      return this.end(session, "viewer_silent");
    if (
      session.pendingViewport !== null &&
      takeViewportTurn(session.viewportTimes, this.deps.now())
    ) {
      this.applyViewport(session, session.pendingViewport);
      session.pendingViewport = null;
    }
    session.cancelTick = this.deps.after(
      nextLookDelay(session.fastLooks, session.viewport?.picture ?? null),
      () => this.tick(session),
    );
    // One frame on its way at a time: a slow viewer gets fewer frames, never a queue.
    if (session.unconfirmed !== null || session.grabbing) return;
    session.grabbing = true;
    const displayId = session.displayId;
    const startedAt = this.deps.now();
    const looked = this.deps.capture
      .grab(displayId, { viewport: session.viewport, previousDigest: session.lastDigest })
      .catch((): ScreenShareGrab => ({ kind: "none" }))
      .then((grab) => {
        session.grabbing = false;
        if (this.session !== session || session.phase !== "live") return;
        if (session.displayId !== displayId) return;
        if (grab.kind === "locked") {
          session.fastLooks = fastLooksAfter(session.fastLooks, false);
          if (!session.showingLocked) {
            session.showingLocked = true;
            this.releaseHeld(session);
            session.lastDigest = null;
            this.sendState(session, { phase: "locked" });
          }
          return;
        }
        if (grab.kind === "none") {
          // A capture that keeps failing slows down like a still screen does.
          session.fastLooks = fastLooksAfter(session.fastLooks, false);
          return;
        }
        if (session.showingLocked) this.sendLive(session);
        const changed = grab.kind === "frame" && grab.digest !== session.lastDigest;
        session.fastLooks = fastLooksAfter(session.fastLooks, changed);
        if (grab.kind !== "frame" || !changed) return;
        session.lastDigest = grab.digest;
        session.seq += 1;
        session.unconfirmed = session.seq;
        session.unconfirmedAt = startedAt;
        session.frames += 1;
        // New fields only to a viewer that has shown it knows them, by its viewport.
        const stats =
          session.viewport === null
            ? {}
            : {
                stats: {
                  ...(session.lastConfirmMs === undefined
                    ? {}
                    : { confirmMs: session.lastConfirmMs }),
                  grabMs: grab.grabMs ?? 0,
                  encodeMs: grab.encodeMs ?? 0,
                  quality: grab.quality ?? 0,
                },
              };
        this.sendSealed(
          session,
          SCREEN_SHARE_RECORD.frame,
          encodeScreenShareFrame(
            {
              seq: session.seq,
              displayId,
              width: grab.width,
              height: grab.height,
              ...(grab.pointer === undefined ? {} : { pointer: grab.pointer }),
              ...stats,
            },
            grab.jpeg,
          ),
        );
      });
    void this.track(looked);
  }

  private sendState(session: Session, state: ScreenShareSessionState): void {
    this.sendSealed(session, SCREEN_SHARE_RECORD.state, encoder.encode(JSON.stringify(state)));
  }

  /**
   * Seals and sends one record. Sealing takes a moment, and the session can end
   * in it: what was sealed while live is then not sent, because the banner is
   * already down. `last` is the one record that follows the end.
   */
  private sendSealed(
    session: Session,
    type: number,
    data: Uint8Array,
    last = false,
  ): Promise<void> {
    const sealer = session.sealer;
    if (sealer === undefined) return Promise.resolve();
    return this.track(
      sealer.seal(type, data).then(
        (record) => {
          if (!last && this.session !== session) {
            session.gap = true;
            return;
          }
          // After a held-back record the viewer could not open this one: the plain close says why.
          if (last && session.gap) return;
          this.deps.send(session.sid, wire(SCREEN_SHARE_WIRE.sealed, record));
        },
        () => {
          // A record that could not be sealed spent its counter: nothing after it would open.
          if (this.session === session) this.end(session, "protocol_error");
        },
      ),
    );
  }

  private end(session: Session, reason: ScreenShareEndReason): void {
    if (this.session !== session) return;
    this.session = null;
    const { store, capture, banner, prompt } = this.deps;
    session.cancelStage?.();
    session.cancelLimit?.();
    session.cancelTick?.();
    const wasLive = session.phase === "live";
    // Control ends first: every key let go, computer use back, before the banner goes.
    this.endControl(session);
    if (wasLive) {
      capture.keepAwake(false);
      banner.hide();
    } else {
      prompt.hide();
      // Counted only once the device proved its key and a person was made to look.
      const asked = session.phase !== "hello" && session.phase !== "proof";
      if (asked && STRIKES.has(reason)) store.addStrike(session.device.thumbprint);
    }
    this.audit({
      id: session.sid,
      device: session.device,
      outcome: wasLive ? session.outcome : "refused",
      reason,
      ...(session.startedAt === undefined ? {} : { startedAt: session.startedAt }),
      endedAt: this.deps.now(),
      frames: session.frames,
      ...this.controlAudit(session),
    });
    // The last word goes inside the sealed session; the plain close follows it.
    void this.track(
      this.sendSealed(
        session,
        SCREEN_SHARE_RECORD.state,
        encoder.encode(
          JSON.stringify({ phase: "ended", reason } satisfies ScreenShareSessionState),
        ),
        true,
      ).finally(() => this.deps.close(session.sid, reason)),
    );
    this.deps.changed();
  }

  // -------------------------------------------------------------------------
  // Control (1519).

  private sendControl(session: Session, state: ScreenShareControlState): void {
    // Only a viewer that asked reads this record; a slice-1 viewer never gets one.
    if (!session.control.requested) return;
    void this.sendSealed(
      session,
      SCREEN_SHARE_RECORD.control,
      encoder.encode(JSON.stringify(state)),
    );
  }

  private controlAudit(session: Session): {
    readonly control?: ScreenShareAuditEntry["control"];
  } {
    const { control } = session;
    if (control.outcome === undefined) return {};
    const iso = (at: number) => new Date(at).toISOString();
    return {
      control: {
        outcome: control.outcome,
        ...(control.startedAt === undefined ? {} : { startedAt: iso(control.startedAt) }),
        ...(control.endedAt === undefined ? {} : { endedAt: iso(control.endedAt) }),
      },
    };
  }

  private auditLive(session: Session): boolean {
    return this.audit({
      id: session.sid,
      device: session.device,
      outcome: session.outcome,
      ...(session.startedAt === undefined ? {} : { startedAt: session.startedAt }),
      ...this.controlAudit(session),
    });
  }

  private bannerView(session: Session, controlling: boolean): ScreenShareBannerView {
    return {
      label: session.device.label,
      shortId: session.device.shortId,
      startedAt: session.startedAt ?? this.deps.now(),
      ...(controlling ? { controlling: true } : {}),
    };
  }

  private requestControl(session: Session): void {
    const control = session.control;
    const now = this.deps.now();
    session.lastHeard = now;
    control.requested = true;
    // Asked again while asking or controlling: nothing new.
    if (control.mode !== "off") return;
    if (session.showingLocked)
      return this.sendControl(session, { mode: "viewing", reason: "unavailable" });
    const { thumbprint, label, claimedLabel, shortId } = session.device;
    if (this.deps.store.hasControlGrant(thumbprint))
      return void this.track(this.startControl(session, "allowed_by_grant"));
    // The prompt is a person's attention: a few times a session, never during a quiet time.
    if (this.deps.store.inCooldown(thumbprint) || control.asks >= SCREEN_SHARE_CONTROL_ASKS)
      return this.sendControl(session, { mode: "viewing", reason: "asked_too_often" });
    control.asks += 1;
    control.authTries = 0;
    control.mode = "asking";
    const expiresAt = now + SCREEN_SHARE_PROMPT_MS;
    control.cancelAsk = this.deps.after(SCREEN_SHARE_PROMPT_MS, () =>
      this.refuseControl(session, "prompt_timeout", true),
    );
    this.deps.prompt.show({
      sid: session.sid,
      label,
      ...(claimedLabel === undefined ? {} : { claimedLabel }),
      shortId,
      stage: "ask",
      kind: "control",
      expiresAt,
    });
    this.sendControl(session, { mode: "asking" });
    this.deps.changed();
  }

  /** The control prompt's answer. Deny needs nothing; Always allow needs the system's authentication. */
  private async answerControlPrompt(
    session: Session,
    answer: "deny" | "once" | "always",
  ): Promise<void> {
    const control = session.control;
    if (answer === "deny") return this.refuseControl(session, "denied", true);
    // Control has no "once": the first time is the choice to allow it for good (D-05).
    if (answer !== "always" || control.mode !== "asking" || this.asking) return;
    control.mode = "authenticating";
    const { label, shortId } = session.device;
    const present = await this.personPresent(
      `always allow "${label}" (${shortId}) to control this Mac, also with nobody at it`,
    );
    // Denied, timed out, ended or asked about again while the dialog was up: the answer is for nothing.
    if (this.session !== session || session.phase !== "live" || control.mode !== "authenticating")
      return;
    if (present !== "present") {
      if (present === "absent") control.authTries += 1;
      if (control.authTries >= AUTHENTICATE_TRIES)
        return this.refuseControl(session, "denied", true);
      control.mode = "asking";
      return;
    }
    control.cancelAsk?.();
    delete control.cancelAsk;
    this.deps.prompt.hide();
    return this.startControl(session, "allowed_always");
  }

  private refuseControl(session: Session, reason: ScreenShareControlReason, strike: boolean): void {
    if (this.session !== session) return;
    const control = session.control;
    if (control.mode !== "asking" && control.mode !== "authenticating") return;
    control.cancelAsk?.();
    delete control.cancelAsk;
    control.mode = "off";
    this.deps.prompt.hide();
    if (strike) this.deps.store.addStrike(session.device.thumbprint);
    this.sendControl(session, { mode: "viewing", reason });
    this.deps.changed();
  }

  /**
   * Control starts in this order, and stops at the first step that fails: the
   * banner says "is controlling", the list records it, the grant is kept,
   * computer use here holds off, then the helper starts. No event is posted
   * before all of them.
   */
  private async startControl(session: Session, outcome: ScreenShareAuditOutcome): Promise<void> {
    const control = session.control;
    const deps = this.deps.control;
    if (deps === undefined) return;
    control.mode = "starting";
    const backToViewing = (reason: ScreenShareControlReason) => {
      control.mode = "off";
      if (!this.deps.banner.show(this.bannerView(session, false)))
        return this.end(session, "banner_lost");
      this.sendControl(session, { mode: "viewing", reason });
      this.deps.changed();
    };
    if (!this.deps.banner.show(this.bannerView(session, true)))
      return this.end(session, "banner_lost");
    control.outcome = outcome;
    control.startedAt = this.deps.now();
    delete control.endedAt;
    if (!this.auditLive(session)) {
      delete control.outcome;
      delete control.startedAt;
      return backToViewing("unavailable");
    }
    const { thumbprint, label, shortId } = session.device;
    if (
      outcome === "allowed_always" &&
      !this.deps.store.addControlGrant({ thumbprint, label, shortId })
    ) {
      // "Always allow control" that could not be kept is control for this session, and the list says so.
      control.outcome = "allowed_once";
      this.auditLive(session);
    }
    deps.controlled(true);
    let started: ScreenControlStart;
    try {
      started = await deps.start({
        onBlocked: (blocked) => this.controlBlocked(session, blocked),
        onExit: () => this.helperGone(session),
      });
    } catch {
      started = { kind: "unavailable" };
    }
    // Ended, or control stopped, while the helper was starting.
    if (this.session !== session || control.mode !== "starting") {
      if (started.kind === "ok") started.link.stop();
      return;
    }
    if (started.kind !== "ok") {
      deps.controlled(false);
      control.endedAt = this.deps.now();
      this.auditLive(session);
      return backToViewing(started.kind === "no_permission" ? "no_permission" : "unavailable");
    }
    control.link = started.link;
    control.mode = "on";
    // Only control that really started counts as use: a helper that keeps failing
    // does not keep an old grant alive.
    if (outcome === "allowed_by_grant") this.deps.store.touchControlGrant(thumbprint);
    this.sendControl(session, {
      mode: "controlling",
      ...(control.blocked === null ? {} : { blocked: control.blocked }),
    });
    this.deps.changed();
  }

  private input(session: Session, body: Record<string, unknown>): void {
    const control = session.control;
    // A viewer that never asked for control has nothing to send here.
    if (!control.requested) return this.end(session, "protocol_error");
    const record = parseInputRecord(body);
    if (record === null) return this.end(session, "protocol_error");
    const now = this.deps.now();
    session.lastHeard = now;
    // Events that crossed the end of control on the way are dropped, not an error.
    if (control.mode !== "on" || control.link === undefined) return;
    if (!takeInputTurn(control.inputTimes, now)) return;
    if (session.showingLocked || record.displayId !== session.displayId) return;
    const bounds = this.deps.control?.bounds(record.displayId) ?? null;
    if (bounds === null) return;
    const events = toHelperEvents(bounds, record.events);
    control.held.note(events);
    control.link.post(events);
    control.cancelHeld?.();
    delete control.cancelHeld;
    // A viewer that goes quiet with a key down does not leave it down.
    if (control.held.any)
      control.cancelHeld = this.deps.after(SCREEN_SHARE_HELD_SILENCE_MS, () =>
        this.releaseHeld(session),
      );
  }

  /** Lets go of every key and button held, and stays in control. */
  private releaseHeld(session: Session): void {
    const control = session.control;
    control.cancelHeld?.();
    delete control.cancelHeld;
    if (control.mode !== "on" || control.link === undefined || !control.held.any) return;
    void this.track(control.link.release(control.held.take()));
  }

  private controlBlocked(session: Session, blocked: ScreenShareTypingBlock | null): void {
    if (this.session !== session) return;
    const control = session.control;
    if (control.blocked === blocked) return;
    control.blocked = blocked;
    if (control.mode === "on")
      this.sendControl(session, {
        mode: "controlling",
        ...(blocked === null ? {} : { blocked }),
      });
  }

  /** The helper went away on its own: a fresh one lets go of what it held, and control ends. */
  private helperGone(session: Session): void {
    if (this.session !== session || session.control.mode !== "on") return;
    delete session.control.link;
    this.stopControl(session, "unavailable");
  }

  /** Back to viewing, and the viewer is told why. */
  private stopControl(session: Session, reason: ScreenShareControlReason): void {
    const control = session.control;
    if (control.mode === "off") return;
    if (control.mode === "asking" || control.mode === "authenticating")
      return this.refuseControl(session, reason, false);
    this.endControl(session);
    if (!this.deps.banner.show(this.bannerView(session, false)))
      return this.end(session, "banner_lost");
    this.auditLive(session);
    this.sendControl(session, { mode: "viewing", reason });
    this.deps.changed();
  }

  /**
   * Ends control at once, saying nothing to anyone: every held key and button
   * let go, the helper gone, computer use here back.
   */
  private endControl(session: Session): void {
    const control = session.control;
    control.cancelAsk?.();
    delete control.cancelAsk;
    control.cancelHeld?.();
    delete control.cancelHeld;
    if (control.mode === "asking" || control.mode === "authenticating") {
      control.mode = "off";
      this.deps.prompt.hide();
      return;
    }
    if (control.mode === "off") return;
    const link = control.link;
    delete control.link;
    const held = control.held.take();
    if (link !== undefined) {
      // The release goes down the pipe before it closes; the helper also lets go as it exits.
      void this.track(link.release(held));
      link.stop();
    } else if (held.keys.length > 0 || held.buttons.length > 0)
      this.deps.control?.releaseOrphaned(held);
    control.mode = "off";
    control.blocked = null;
    if (control.startedAt !== undefined && control.endedAt === undefined)
      control.endedAt = this.deps.now();
    this.deps.control?.controlled(false);
  }

  private audit(input: {
    readonly id: string;
    readonly device: ScreenShareViewerDevice;
    readonly outcome: ScreenShareAuditOutcome;
    readonly reason?: ScreenShareEndReason;
    readonly startedAt?: number;
    readonly endedAt?: number;
    readonly frames?: number;
    readonly control?: ScreenShareAuditEntry["control"];
  }): boolean {
    const iso = (at: number) => new Date(at).toISOString();
    const previous = this.deps.store.audit.find((entry) => entry.id === input.id);
    const entry: ScreenShareAuditEntry = {
      id: input.id,
      at: previous?.at ?? iso(this.deps.now()),
      label: input.device.label,
      shortId: input.device.shortId,
      mode: "view",
      outcome: input.outcome,
      ...(input.startedAt === undefined ? {} : { startedAt: iso(input.startedAt) }),
      ...(input.endedAt === undefined ? {} : { endedAt: iso(input.endedAt) }),
      ...(input.reason === undefined ? {} : { reason: input.reason }),
      ...(input.frames === undefined ? {} : { frames: input.frames }),
      ...(input.control === undefined ? {} : { control: input.control }),
    };
    return this.deps.store.recordAudit(entry);
  }
}
