import * as Schema from "effect/Schema";
import { Rpc } from "effect/rpc";

import { EnvironmentAuthorizationError } from "./auth.ts";

/**
 * A person signs in on a machine's Chrome from another device (1488). An
 * agent asks with `chrome_sign_in_needed`; the card in its thread opens a
 * live view of a tab only the person can see or drive. Frames come sealed to
 * the viewer's key and typed text goes sealed to the view's key, so the
 * relay and every log carry ciphertext. The agent hears only how it ended.
 */

export const BROWSER_SIGN_IN_RPC_METHODS = {
  browserSignInStart: "browserExtension.signInStart",
  browserSignInFrame: "browserExtension.signInFrame",
  browserSignInInput: "browserExtension.signInInput",
  browserSignInEnd: "browserExtension.signInEnd",
} as const;

/** How a sign-in ended, as the agent hears it. */
export const BrowserSignInOutcome = Schema.Literals([
  "done",
  "cancelled",
  "timed_out",
  "tab_closed",
  "declined",
  "expired",
]);
export type BrowserSignInOutcome = typeof BrowserSignInOutcome.Type;

export class BrowserSignInError extends Schema.TaggedError<BrowserSignInError>()(
  "BrowserSignInError",
  {
    code: Schema.Literals([
      "not_found",
      "already_open",
      "ended",
      "not_connected",
      "invalid_request",
      "page_changed",
      "failed",
    ]),
    reason: Schema.String,
  },
) {
  override get message(): string {
    return this.reason;
  }
}

const RpcError = Schema.Union([BrowserSignInError, EnvironmentAuthorizationError]);
const ViewId = Schema.String.check(Schema.isMaxLength(100));
const FrameRef = Schema.String.check(Schema.isMaxLength(100));
const Coordinate = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 20_000 }));

export const BrowserSignInStartInput = Schema.Struct({
  requestId: Schema.String.check(Schema.isMaxLength(100)),
  /** Base64 SPKI of the viewer's X25519 key; frames are sealed to it. */
  viewerKey: Schema.String.check(Schema.isMaxLength(200)),
});
export const BrowserSignInStarted = Schema.Struct({
  viewId: Schema.String,
  profile: Schema.String,
  /** The address the agent asked for; the frames carry the one Chrome shows. */
  origin: Schema.String,
  /** The view's key; typed text is sealed to it. */
  publicKey: Schema.String,
  fingerprint: Schema.String,
});
export type BrowserSignInStarted = typeof BrowserSignInStarted.Type;

export const BrowserSignInFrameResult = Schema.Struct({
  /** The newest frame, sealed to the viewer's key; absent once the view ended. */
  sealed: Schema.optional(Schema.String),
  ended: Schema.optional(BrowserSignInOutcome),
});
export type BrowserSignInFrameResult = typeof BrowserSignInFrameResult.Type;

export const BrowserSignInInput = Schema.Union([
  Schema.Struct({ type: Schema.Literal("click"), frame: FrameRef, x: Coordinate, y: Coordinate }),
  Schema.Struct({
    type: Schema.Literal("scroll"),
    frame: FrameRef,
    x: Coordinate,
    y: Coordinate,
    deltaX: Schema.Number.check(Schema.isBetween({ minimum: -5_000, maximum: 5_000 })),
    deltaY: Schema.Number.check(Schema.isBetween({ minimum: -5_000, maximum: 5_000 })),
  }),
  Schema.Struct({
    type: Schema.Literal("key"),
    frame: FrameRef,
    key: Schema.String.check(Schema.isMaxLength(20)),
  }),
  /** Characters, sealed to the view's key with the frame and a growing seq inside. */
  Schema.Struct({
    type: Schema.Literal("text"),
    sealed: Schema.String.check(Schema.isMaxLength(16_384)),
  }),
]);
export type BrowserSignInInput = typeof BrowserSignInInput.Type;

export const browserSignInRpcs = [
  /** Opens the tab for a pending request; one device per request. Owner only. */
  Rpc.make(BROWSER_SIGN_IN_RPC_METHODS.browserSignInStart, {
    payload: BrowserSignInStartInput,
    success: BrowserSignInStarted,
    error: RpcError,
  }),
  Rpc.make(BROWSER_SIGN_IN_RPC_METHODS.browserSignInFrame, {
    payload: Schema.Struct({ viewId: ViewId }),
    success: BrowserSignInFrameResult,
    error: RpcError,
  }),
  Rpc.make(BROWSER_SIGN_IN_RPC_METHODS.browserSignInInput, {
    payload: Schema.Struct({ viewId: ViewId, input: BrowserSignInInput }),
    success: Schema.Struct({}),
    error: RpcError,
  }),
  /** Done keeps the signed-in tab and hands it back; cancel closes it. */
  Rpc.make(BROWSER_SIGN_IN_RPC_METHODS.browserSignInEnd, {
    payload: Schema.Struct({ viewId: ViewId, end: Schema.Literals(["done", "cancel"]) }),
    success: Schema.Struct({}),
    error: RpcError,
  }),
] as const;

// ── chrome_sign_in_needed ───────────────────────────────────────────────────

export const ChromeSignInNeededInput = Schema.Struct({
  url: Schema.String.check(Schema.isMaxLength(2_000)).annotate({
    description: "The https sign-in page to open, e.g. https://app.squareup.com/login.",
  }),
  reason: Schema.String.check(Schema.isMaxLength(300)).annotate({
    description: "One sentence the user sees on the card: why the task needs this sign-in.",
  }),
  clientRequestId: Schema.String.check(Schema.isMaxLength(200)).annotate({
    description:
      "Your id for this sign-in. Call again with the same id to keep waiting after signing_in.",
  }),
  profile: Schema.optional(
    Schema.String.annotate({
      description:
        "Chrome profile name from chrome_profiles. Omit when only one profile is connected.",
    }),
  ),
});
export type ChromeSignInNeededInput = typeof ChromeSignInNeededInput.Type;

export const ChromeSignInNeededResult = Schema.Struct({
  status: Schema.Union([BrowserSignInOutcome, Schema.Literal("signing_in")]),
  message: Schema.String,
});
export type ChromeSignInNeededResult = typeof ChromeSignInNeededResult.Type;
