/**
 * The rules of viewing another machine's screen, on the viewing device (1490).
 * No socket, no canvas and no clock in here: `reduceScreenViewer` takes what
 * happened and answers with the next state and what to do about it, so every
 * rule runs in a plain test.
 *
 * - Nothing is drawn before the machine said `live`, and `live` is believed
 *   only from a machine this device can tell from a stand-in: its key matched
 *   the one saved here, or a person typed the code from its screen and it
 *   matched this device's own.
 * - A typed code is compared here first. One that does not match is never sent.
 * - The machine's key is saved only after that match and once the machine went
 *   live. A wrong code or an ended session saves nothing.
 * - One frame at a time: it is drawn, then confirmed. Nothing is queued.
 * - From the machine only two kinds of record are read. Anything else ends it.
 * - A record slice 1 did not have (1519) goes only to a machine whose sealed
 *   `live` state named it in its features: a slice-1 machine ends the session
 *   on a record it does not know.
 * - Control (1519) is asked for only from a live view of a machine that named
 *   `control`, and input goes only while the machine says it is controlling,
 *   and only for the display shown. The machine's control record is read only
 *   after this device asked.
 */
import {
  SCREEN_SHARE_CLOSE_ENDED,
  SCREEN_SHARE_CLOSE_REFUSED,
  SCREEN_SHARE_CODE_TRIES,
  SCREEN_SHARE_FEATURES,
  SCREEN_SHARE_NO_PICTURE_MS,
  SCREEN_SHARE_RECORD,
  ScreenShareControlState,
  ScreenShareEndReason,
  ScreenShareSessionState,
  decodeScreenShareFrame,
  type ScreenShareControlReason,
  type ScreenShareDisplay,
  type ScreenShareInputEvent,
  type ScreenShareTypingBlock,
  type ScreenShareFrameHeader,
  type ScreenSharePicture,
} from "@specweave-studio/contracts";
import { screenShareCodeMatches } from "@specweave-studio/shared/screenShareChannel";
import * as Schema from "effect/Schema";

/** How often the last "frame received" is repeated while nothing new arrives. */
export const SCREEN_VIEWER_HEARTBEAT_MS = 20_000;
/** The server's close for a sign-in that ended. */
export const SCREEN_VIEWER_CLOSE_SIGNED_OUT = 4401;

/** Why a view is over, when the machine did not say so in its own words. */
export type ScreenViewerEnd =
  | { readonly kind: "reason"; readonly reason: ScreenShareEndReason }
  /** The machine answered with another key than the one saved on this device. */
  | { readonly kind: "machine_key_changed" }
  /** The secure session could not be set up, or the other end broke its rules. */
  | { readonly kind: "handshake" }
  /** The codes typed here did not match this device's own, three times. */
  | { readonly kind: "code_mismatch" }
  | { readonly kind: "signed_out" }
  /** The socket never opened: this device is not let in, or the machine is unreachable. */
  | { readonly kind: "not_let_in" }
  | { readonly kind: "connection_lost" }
  /** This device holds no approved device key. */
  | { readonly kind: "no_device_key" }
  | { readonly kind: "ended_here" };

export type ScreenViewerPhase =
  | { readonly kind: "connecting" }
  | { readonly kind: "waiting_for_approval" }
  | {
      readonly kind: "needs_code";
      /** Tries the machine still allows. */
      readonly triesLeft: number;
      /** Tries left on this device before it gives up. */
      readonly triesHere: number;
      /** The last code typed here did not match. */
      readonly wrong: boolean;
      /** The right code was typed and sent; the machine has not answered yet. */
      readonly sent: boolean;
    }
  | {
      readonly kind: "live";
      readonly displays: ReadonlyArray<ScreenShareDisplay>;
      readonly displayId: string;
      /** Epoch milliseconds at which the machine ends the session. */
      readonly endsAt: number;
      readonly locked: boolean;
      /** Live for a while with nothing to show: the display may be asleep. */
      readonly noPicture: boolean;
      /** What the machine said it supports beyond slice 1; empty for a slice-1 machine. */
      readonly features: ReadonlyArray<string>;
    }
  | { readonly kind: "ended"; readonly end: ScreenViewerEnd };

export interface ScreenViewerModel {
  readonly phase: ScreenViewerPhase;
  /** This device's own first-use code, from the handshake. Never shown. */
  readonly code: string | null;
  /** The key the machine signed this session with. */
  readonly machineKey: string | null;
  /** A key for this machine was saved here before, and the machine's matched it. */
  readonly pinned: boolean;
  /** A person typed the code from the machine's screen here and it matched. */
  readonly codeMatched: boolean;
  /** The key was handed over to be saved. */
  readonly pinSaved: boolean;
  readonly lastSeq: number;
  /** A frame of the display now chosen is on screen. */
  readonly hasPicture: boolean;
  /** Since when there has been nothing to show while live. */
  readonly waitingSince: number;
  /** When this device last said anything about frames. */
  readonly lastSaidAt: number;
  /** The picture area and choice here (1519), sent once the machine supports it. */
  readonly viewport: ScreenViewerViewport | null;
  /** The viewport last sent, as `viewportKey` writes it. */
  readonly viewportSent: string | null;
  /** 1519: whether this device views or controls the machine. */
  readonly control: ScreenViewerControl;
}

export interface ScreenViewerControl {
  /** `requesting`: asked, no answer yet; `asking`: a person at the machine is being asked. */
  readonly mode: "viewing" | "requesting" | "asking" | "controlling";
  /** This device asked at least once, so it reads the machine's control records. */
  readonly requested: boolean;
  /** While controlling: why typing is off on the machine. */
  readonly blocked?: ScreenShareTypingBlock;
  /** Back to viewing: why. */
  readonly reason?: ScreenShareControlReason;
}

export interface ScreenViewerViewport {
  /** Device pixels: the picture area's size times the pixel ratio. */
  readonly width: number;
  readonly height: number;
  readonly picture: ScreenSharePicture;
}

const viewportKey = (viewport: ScreenViewerViewport) =>
  `${viewport.width}x${viewport.height}:${viewport.picture}`;

export type ScreenViewerEvent =
  /** The machine's challenge checked out and the proof was sent. */
  | {
      readonly t: "handshake";
      readonly code: string;
      readonly machineKey: string;
      readonly pinned: boolean;
    }
  | { readonly t: "handshake_failed"; readonly failure: string }
  | { readonly t: "no_device_key" }
  /** A sealed record from the machine, opened. */
  | { readonly t: "record"; readonly type: number; readonly data: Uint8Array; readonly now: number }
  | { readonly t: "typed_code"; readonly text: string }
  | { readonly t: "choose_display"; readonly displayId: string }
  /** The picture area changed size, or the picture choice changed. */
  | { readonly t: "viewport"; readonly viewport: ScreenViewerViewport }
  /** 1519: ask the machine for control, go back to viewing, or input while controlling. */
  | { readonly t: "request_control" }
  | { readonly t: "stop_control" }
  | {
      readonly t: "input";
      readonly displayId: string;
      readonly events: ReadonlyArray<ScreenShareInputEvent>;
    }
  | { readonly t: "end_here" }
  | {
      readonly t: "closed";
      readonly code: number;
      readonly reason: string;
      readonly opened: boolean;
    }
  | { readonly t: "tick"; readonly now: number };

export type ScreenViewerEffect =
  /** A sealed record for the machine. */
  | { readonly t: "send"; readonly type: number; readonly body: Record<string, unknown> }
  | {
      readonly t: "draw";
      readonly header: ScreenShareFrameHeader;
      readonly jpeg: Uint8Array;
    }
  | { readonly t: "save_machine_key"; readonly machineKey: string }
  | { readonly t: "clear_picture" }
  | { readonly t: "close" };

export interface ScreenViewerStep {
  readonly model: ScreenViewerModel;
  readonly effects: ReadonlyArray<ScreenViewerEffect>;
}

export const initialScreenViewer = (now: number): ScreenViewerModel => ({
  phase: { kind: "connecting" },
  code: null,
  machineKey: null,
  pinned: false,
  codeMatched: false,
  pinSaved: false,
  lastSeq: 0,
  hasPicture: false,
  waitingSince: now,
  lastSaidAt: now,
  viewport: null,
  viewportSent: null,
  control: { mode: "viewing", requested: false },
});

/** Whether a live view of this machine may ask for control now. */
export const screenViewerCanRequestControl = (model: ScreenViewerModel): boolean =>
  model.phase.kind === "live" &&
  !model.phase.locked &&
  model.phase.features.includes(SCREEN_SHARE_FEATURES.control) &&
  model.control.mode === "viewing";

/** The viewport record to send now, if the machine reads it and it is not the one already sent. */
const viewportToSend = (
  model: ScreenViewerModel,
  features: ReadonlyArray<string>,
): ScreenViewerEffect | null => {
  if (model.viewport === null || !features.includes(SCREEN_SHARE_FEATURES.viewport)) return null;
  if (model.viewportSent === viewportKey(model.viewport)) return null;
  return {
    t: "send",
    type: SCREEN_SHARE_RECORD.viewport,
    body: { ...model.viewport },
  };
};

const decoder = new TextDecoder("utf-8", { fatal: true });
const decodeState = Schema.decodeUnknownSync(ScreenShareSessionState);
const decodeControl = Schema.decodeUnknownSync(ScreenShareControlState);
const isEndReason = Schema.is(ScreenShareEndReason);

const stay = (model: ScreenViewerModel): ScreenViewerStep => ({ model, effects: [] });

const ended = (
  model: ScreenViewerModel,
  end: ScreenViewerEnd,
  effects: ReadonlyArray<ScreenViewerEffect> = [{ t: "close" }],
): ScreenViewerStep => ({
  model: { ...model, phase: { kind: "ended", end }, hasPicture: false },
  effects: [{ t: "clear_picture" }, ...effects],
});

const frameSeen = (seq: number): ScreenViewerEffect => ({
  t: "send",
  type: SCREEN_SHARE_RECORD.frameReceived,
  body: { seq },
});

function onState(
  model: ScreenViewerModel,
  state: ScreenShareSessionState,
  now: number,
): ScreenViewerStep {
  const { phase } = model;
  switch (state.phase) {
    case "ended":
      return ended(model, { kind: "reason", reason: state.reason });
    case "waiting_for_approval":
      return phase.kind === "connecting"
        ? stay({ ...model, phase: { kind: "waiting_for_approval" } })
        : ended(model, { kind: "handshake" });
    case "needs_code": {
      // The machine decides what a first time is, saved key here or not.
      if (phase.kind !== "connecting" && phase.kind !== "waiting_for_approval") {
        // Asked again after the right code went out: the two ends disagree about the
        // code, which they cannot unless something sits between them.
        if (phase.kind === "needs_code" && !phase.sent)
          return stay({ ...model, phase: { ...phase, triesLeft: state.triesLeft } });
        return ended(model, { kind: "handshake" });
      }
      return stay({
        ...model,
        phase: {
          kind: "needs_code",
          triesLeft: state.triesLeft,
          triesHere: SCREEN_SHARE_CODE_TRIES,
          wrong: false,
          sent: false,
        },
      });
    }
    case "locked":
      return phase.kind === "live"
        ? {
            model: {
              ...model,
              hasPicture: false,
              phase: { ...phase, locked: true, noPicture: false },
            },
            effects: [{ t: "clear_picture" }],
          }
        : ended(model, { kind: "handshake" });
    case "live": {
      // Believed only from a machine this device can tell from a stand-in.
      if (!model.pinned && !model.codeMatched) return ended(model, { kind: "handshake" });
      if (phase.kind === "needs_code" && !phase.sent) return ended(model, { kind: "handshake" });
      if (
        state.displays.length === 0 ||
        !state.displays.some((display) => display.id === state.displayId)
      )
        return ended(model, { kind: "handshake" });
      const sameDisplay =
        phase.kind === "live" && phase.displayId === state.displayId && !phase.locked;
      const save =
        model.codeMatched && !model.pinned && !model.pinSaved && model.machineKey !== null;
      const features = state.features ?? [];
      const viewport = viewportToSend(model, features);
      return {
        model: {
          ...model,
          viewportSent:
            viewport === null || model.viewport === null
              ? model.viewportSent
              : viewportKey(model.viewport),
          pinSaved: model.pinSaved || save,
          hasPicture: sameDisplay && model.hasPicture,
          waitingSince: sameDisplay ? model.waitingSince : now,
          lastSaidAt: phase.kind === "live" ? model.lastSaidAt : now,
          phase: {
            kind: "live",
            displays: state.displays,
            displayId: state.displayId,
            endsAt: state.endsAt,
            locked: false,
            noPicture: sameDisplay && phase.noPicture,
            features,
          },
        },
        effects: [
          ...(save ? [{ t: "save_machine_key", machineKey: model.machineKey! } as const] : []),
          ...(sameDisplay ? [] : [{ t: "clear_picture" } as const]),
          ...(viewport === null ? [] : [viewport]),
        ],
      };
    }
  }
}

function onRecord(
  model: ScreenViewerModel,
  type: number,
  data: Uint8Array,
  now: number,
): ScreenViewerStep {
  if (type === SCREEN_SHARE_RECORD.state) {
    let state: ScreenShareSessionState;
    try {
      state = decodeState(JSON.parse(decoder.decode(data)));
    } catch {
      return ended(model, { kind: "handshake" });
    }
    return onState(model, state, now);
  }
  if (type === SCREEN_SHARE_RECORD.control) {
    // Only an answer to this device's own request; and only while the view is live.
    if (!model.control.requested || model.phase.kind !== "live")
      return ended(model, { kind: "handshake" });
    let state: ScreenShareControlState;
    try {
      state = decodeControl(JSON.parse(decoder.decode(data)));
    } catch {
      return ended(model, { kind: "handshake" });
    }
    const control: ScreenViewerControl =
      state.mode === "asking"
        ? { mode: "asking", requested: true }
        : state.mode === "controlling"
          ? {
              mode: "controlling",
              requested: true,
              ...(state.blocked === undefined ? {} : { blocked: state.blocked }),
            }
          : {
              mode: "viewing",
              requested: true,
              ...(state.reason === undefined ? {} : { reason: state.reason }),
            };
    return stay({ ...model, control });
  }
  if (type === SCREEN_SHARE_RECORD.frame) {
    const { phase } = model;
    // No picture before live, none while locked, and none of a display not chosen.
    if (phase.kind !== "live" || phase.locked) return ended(model, { kind: "handshake" });
    let frame: ReturnType<typeof decodeScreenShareFrame>;
    try {
      frame = decodeScreenShareFrame(data);
    } catch {
      return ended(model, { kind: "handshake" });
    }
    const { header, jpeg } = frame;
    if (header.seq <= model.lastSeq || header.width <= 0 || header.height <= 0)
      return ended(model, { kind: "handshake" });
    // A frame of the display just left: confirmed so the machine moves on, not drawn.
    if (header.displayId !== phase.displayId)
      return {
        model: { ...model, lastSeq: header.seq, lastSaidAt: now },
        effects: [frameSeen(header.seq)],
      };
    return {
      model: {
        ...model,
        lastSeq: header.seq,
        hasPicture: true,
        lastSaidAt: now,
        phase: { ...phase, noPicture: false },
      },
      // Drawn first, confirmed after: the machine sends the next one only then.
      effects: [{ t: "draw", header, jpeg }, frameSeen(header.seq)],
    };
  }
  return ended(model, { kind: "handshake" });
}

/** What the close of the socket says, when the machine did not get to say it sealed. */
export const screenViewerEndOfClose = (
  code: number,
  reason: string,
  opened: boolean,
): ScreenViewerEnd => {
  if (code === SCREEN_VIEWER_CLOSE_SIGNED_OUT) return { kind: "signed_out" };
  if (
    (code === SCREEN_SHARE_CLOSE_REFUSED || code === SCREEN_SHARE_CLOSE_ENDED) &&
    isEndReason(reason)
  )
    return { kind: "reason", reason };
  return opened ? { kind: "connection_lost" } : { kind: "not_let_in" };
};

export function reduceScreenViewer(
  model: ScreenViewerModel,
  event: ScreenViewerEvent,
): ScreenViewerStep {
  const { phase } = model;
  // Over is over: nothing that arrives late brings a view back or draws.
  if (phase.kind === "ended") return stay(model);
  switch (event.t) {
    case "handshake":
      return phase.kind === "connecting" && model.machineKey === null
        ? stay({
            ...model,
            code: event.code,
            machineKey: event.machineKey,
            pinned: event.pinned,
          })
        : ended(model, { kind: "handshake" });
    case "handshake_failed":
      return ended(
        model,
        event.failure === "machine_key_changed"
          ? { kind: "machine_key_changed" }
          : { kind: "handshake" },
      );
    case "no_device_key":
      return ended(model, { kind: "no_device_key" });
    case "record":
      // Sealed records mean the handshake finished; before that there is no session to read.
      return model.machineKey === null
        ? ended(model, { kind: "handshake" })
        : onRecord(model, event.type, event.data, event.now);
    case "typed_code": {
      if (phase.kind !== "needs_code" || phase.sent || model.code === null) return stay(model);
      if (!screenShareCodeMatches(event.text, model.code)) {
        // Not sent. A typing slip, or the machine on the other end is not the one in front of them.
        const triesHere = phase.triesHere - 1;
        return triesHere <= 0
          ? ended(model, { kind: "code_mismatch" }, [
              { t: "send", type: SCREEN_SHARE_RECORD.end, body: {} },
              { t: "close" },
            ])
          : stay({ ...model, phase: { ...phase, triesHere, wrong: true } });
      }
      return {
        model: { ...model, codeMatched: true, phase: { ...phase, wrong: false, sent: true } },
        effects: [{ t: "send", type: SCREEN_SHARE_RECORD.confirmCode, body: { code: model.code } }],
      };
    }
    case "choose_display":
      return phase.kind === "live" &&
        event.displayId !== phase.displayId &&
        phase.displays.some((display) => display.id === event.displayId)
        ? {
            model,
            effects: [
              {
                t: "send",
                type: SCREEN_SHARE_RECORD.showDisplay,
                body: { displayId: event.displayId },
              },
            ],
          }
        : stay(model);
    case "viewport": {
      const next = { ...model, viewport: event.viewport };
      const send = phase.kind === "live" ? viewportToSend(next, phase.features) : null;
      return send === null
        ? stay(next)
        : { model: { ...next, viewportSent: viewportKey(event.viewport) }, effects: [send] };
    }
    case "request_control":
      return screenViewerCanRequestControl(model)
        ? {
            model: { ...model, control: { mode: "requesting", requested: true } },
            effects: [{ t: "send", type: SCREEN_SHARE_RECORD.controlRequest, body: {} }],
          }
        : stay(model);
    case "stop_control":
      return phase.kind === "live" && model.control.mode !== "viewing"
        ? {
            model: { ...model, control: { mode: "viewing", requested: true } },
            effects: [{ t: "send", type: SCREEN_SHARE_RECORD.controlEnd, body: {} }],
          }
        : stay(model);
    case "input":
      // Only while the machine says this device controls it, and only for the display shown.
      return phase.kind === "live" &&
        !phase.locked &&
        model.control.mode === "controlling" &&
        event.displayId === phase.displayId &&
        event.events.length > 0
        ? {
            model,
            effects: [
              {
                t: "send",
                type: SCREEN_SHARE_RECORD.input,
                body: { displayId: event.displayId, events: event.events },
              },
            ],
          }
        : stay(model);
    case "end_here":
      return ended(
        model,
        { kind: "ended_here" },
        model.machineKey === null
          ? [{ t: "close" }]
          : [{ t: "send", type: SCREEN_SHARE_RECORD.end, body: {} }, { t: "close" }],
      );
    case "closed":
      return ended(model, screenViewerEndOfClose(event.code, event.reason, event.opened), []);
    case "tick": {
      if (phase.kind !== "live") return stay(model);
      const noPicture =
        !phase.locked &&
        !model.hasPicture &&
        event.now - model.waitingSince >= SCREEN_SHARE_NO_PICTURE_MS;
      const say = event.now - model.lastSaidAt >= SCREEN_VIEWER_HEARTBEAT_MS;
      if (!say && noPicture === phase.noPicture) return stay(model);
      return {
        model: {
          ...model,
          lastSaidAt: say ? event.now : model.lastSaidAt,
          phase: { ...phase, noPicture },
        },
        // The same "seen" again: it tells the machine this device is still here.
        effects: say ? [frameSeen(model.lastSeq)] : [],
      };
    }
  }
}

/** The key under which this device keeps a machine's screen sharing key. It is a public key. */
export const screenShareMachineKeyStorageKey = (environmentId: string): string =>
  `specwithcode:screen-share:machine-key:${environmentId}`;

/** Six digits as a person reads them: "482 913". */
export const formatScreenShareCode = (digits: string): string =>
  digits.length > 3 ? `${digits.slice(0, 3)} ${digits.slice(3)}` : digits;

/** What was typed, down to at most six digits. */
export const screenShareCodeDigits = (typed: string): string =>
  typed.replace(/\D/g, "").slice(0, 6);

/** "1 h 59 min", "12 min", "under a minute". */
export const screenViewerTimeLeft = (endsAt: number, now: number): string => {
  const minutes = Math.floor(Math.max(0, endsAt - now) / 60_000);
  if (minutes < 1) return "under a minute";
  const hours = Math.floor(minutes / 60);
  return hours > 0 ? `${hours} h ${minutes % 60} min` : `${minutes} min`;
};

const REASON_WORDS: Readonly<Record<ScreenShareEndReason, string>> = {
  off: "Screen sharing is off on {machine}. It can only be turned on at that machine, in SpecWithCode under Settings > Machines.",
  busy: "{machine} is already being viewed, or someone there is being asked. Try again in a moment.",
  cooldown: "{machine} was asked too often from this device. Wait 10 minutes, then try again.",
  unsupported:
    "{machine} cannot show its screen yet. Screen sharing needs the SpecWithCode app on a Mac.",
  no_host:
    "The SpecWithCode app is not open on {machine}. Its screen can be viewed only while the app runs there.",
  no_permission:
    "SpecWithCode is not allowed to record the screen on {machine}. Allow it at that machine in System Settings > Privacy & Security > Screen & System Audio Recording.",
  denied: "The request was denied at {machine}.",
  prompt_timeout: "Nobody answered at {machine}. The request ran out after a minute.",
  stopped_at_machine: "Someone at {machine} pressed Stop.",
  viewer_ended: "You ended the view.",
  viewer_silent: "{machine} stopped hearing from this device and ended the view.",
  time_limit: "The view reached its 2 hour limit. You can start another.",
  device_removed: "This device was removed from the devices that can use {machine}.",
  handshake_failed: "The secure session with {machine} could not be set up. Try again.",
  protocol_error: "Something unexpected arrived, so the view was ended to be safe.",
  banner_lost:
    "{machine} could not keep its notice that the screen is being viewed on screen, so it stopped showing it.",
  app_quit: "The SpecWithCode app on {machine} was closed.",
  turned_off: "Screen sharing was turned off at {machine}.",
  wrong_code:
    "The code did not match three times. Start again and read the code from the screen of {machine}.",
  grant_removed: "This device was removed from the always allowed devices at {machine}.",
  host_refused:
    "Another program holds the screen sharing link of {machine}. Check at that machine.",
  host_replaced:
    "Another program took over the screen sharing link of {machine}. Check at that machine.",
};

/** Why the view is over, in words. `{machine}` stands for the machine's name. */
export const screenViewerEndWords = (
  end: ScreenViewerEnd,
): { readonly title: string; readonly detail: string } => {
  switch (end.kind) {
    case "reason":
      return {
        title:
          end.reason === "viewer_ended" || end.reason === "stopped_at_machine"
            ? "The view has ended"
            : "The screen is not being shown",
        detail: REASON_WORDS[end.reason],
      };
    case "machine_key_changed":
      return {
        title: "This is not the key {machine} used before",
        detail:
          "{machine} answered with a different screen sharing key than the one this device saved. Nothing was shown. If screen sharing was set up again on that machine, forget the saved key and view again: you will be asked for the code on its screen. If it was not, something between this device and that machine may be answering in its place.",
      };
    case "code_mismatch":
      return {
        title: "The code did not match",
        detail:
          "What was typed here did not match three times, so nothing was sent or shown. If the code was read from the screen of {machine} without a slip, the machine that answered may not be yours.",
      };
    case "handshake":
      return {
        title: "The screen is not being shown",
        detail:
          "The secure session with {machine} could not be set up or broke its rules. Nothing more is shown. Try again.",
      };
    case "signed_out":
      return {
        title: "You are signed out",
        detail: "Your sign-in on this device ended. Sign in again, then view the screen.",
      };
    case "not_let_in":
      return {
        title: "The screen could not be opened",
        detail:
          "{machine} did not let this device in, or cannot be reached. A device can view a screen when it is signed in to SpecWithCode Connect and is on that machine's list of devices that can use it.",
      };
    case "connection_lost":
      return {
        title: "The connection dropped",
        detail: "The connection to {machine} was lost. View again to continue.",
      };
    case "no_device_key":
      return {
        title: "This device is not set up for it",
        detail:
          "This device has no device key. Sign in to SpecWithCode Connect here and approve this device on {machine} first.",
      };
    case "ended_here":
      return { title: "The view has ended", detail: "You ended the view." };
  }
};

/** One line under the picture area for every phase that is not over. */
export const screenViewerPhaseWords = (phase: ScreenViewerPhase): string => {
  switch (phase.kind) {
    case "connecting":
      return "Connecting to {machine}…";
    case "waiting_for_approval":
      return "Waiting for someone at {machine} to allow it. A request is on its screen for one minute.";
    case "needs_code":
      return phase.sent
        ? "Checking the code with {machine}…"
        : "Allowed at {machine}. Type the 6-digit code its screen shows.";
    case "live":
      return phase.locked
        ? "{machine} is locked. Its screen is shown again once someone unlocks it there."
        : phase.noPicture
          ? "No picture yet. The display of {machine} may be asleep."
          : "";
    case "ended":
      return "";
  }
};

/** Whether "View again" makes sense after this end. */
export const screenViewerCanRetry = (end: ScreenViewerEnd): boolean =>
  end.kind !== "no_device_key" &&
  end.kind !== "signed_out" &&
  end.kind !== "machine_key_changed" &&
  !(end.kind === "reason" && (end.reason === "unsupported" || end.reason === "device_removed"));

/** What the viewer counts about the frames it drew (1519). */
export interface ScreenViewerStats {
  /** `performance.now()` of each frame drawn in the last 5 seconds. */
  drawnAt: Array<number>;
  /** Size of the last frame's JPEG. */
  bytes: number;
  header?: ScreenShareFrameHeader;
}

/**
 * "4.8 fps · 212 KB · 140 ms": frames drawn per second over the last 5
 * seconds, the last frame's size, and the machine's capture-to-confirm time
 * for the frame before it, on the machine's own clock.
 */
export const screenViewerStatsLine = (stats: ScreenViewerStats, now: number): string => {
  const recent = stats.drawnAt.filter((at) => now - at < 5_000);
  const fps = recent.length / 5;
  const parts = [`${fps.toFixed(1)} fps`, `${Math.round(stats.bytes / 1024)} KB`];
  const machine = stats.header?.stats;
  if (machine?.confirmMs !== undefined) parts.push(`${Math.round(machine.confirmMs)} ms`);
  if (stats.header !== undefined) parts.push(`${stats.header.width}x${stats.header.height}`);
  if (machine !== undefined)
    parts.push(
      `capture ${machine.grabMs} ms`,
      `encode ${machine.encodeMs} ms`,
      `q${machine.quality}`,
    );
  return parts.join(" · ");
};

/** What the viewer says about control, in words; null when there is nothing to say. */
export const screenViewerControlWords = (control: ScreenViewerControl): string | null => {
  if (control.mode === "requesting" || control.mode === "asking")
    return "Waiting for a person at {machine} to allow control…";
  if (control.mode === "controlling")
    switch (control.blocked) {
      case "secure_input":
        return "Typing is off: a password field has focus on {machine}.";
      case "system_prompt":
        return "Typing and clicks are off: a system prompt is open on {machine}. Answer it at the machine.";
      case "browser":
        return "Typing is off while a browser is in front on {machine}. Clicks and scrolling still work.";
      case "locked":
        return "{machine} is locked. Unlock it at the machine.";
      default:
        return null;
    }
  switch (control.reason) {
    case "denied":
      return "Control was not allowed at {machine}.";
    case "prompt_timeout":
      return "Nobody answered at {machine}, so control was not allowed.";
    case "no_permission":
      return "{machine} cannot be controlled yet: turn on Accessibility for SpecWithCode there, in System Settings.";
    case "unavailable":
      return "Control is not available on {machine} right now.";
    case "asked_too_often":
      return "Control was asked for too often. Try again later.";
    default:
      return null;
  }
};
