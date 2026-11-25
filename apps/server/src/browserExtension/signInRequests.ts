// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off -- plain async bookkeeping over SignInViews, driven by tests with a fake extension.
/**
 * Sign-in requests (1488): what an agent asked for with `chrome_sign_in_needed`,
 * tied to the view the person opens from its card.
 *
 * An agent names a page and a reason; the card in its thread carries only the
 * request id. The person's device starts the view with that id, so the page
 * comes from the request and not from the device, and one request opens one
 * view, on one device. The agent hears only how it ended: never an address,
 * a frame or a key.
 */
import * as NodeCrypto from "node:crypto";

import type { BrowserSignInOutcome } from "@specweave-studio/contracts";

import { BrowserRelayError, type BrowserRelayHub } from "./relayHub.ts";
import {
  checkSignInUrl,
  type SignInInput,
  type SignInViewEnd,
  SignInViews,
  type SignInViewsOptions,
  type SignInViewStarted,
} from "./signInView.ts";

/** A request nobody opened in this long ends as expired. */
export const SIGN_IN_REQUEST_START_MS = 15 * 60_000;
/** Ended requests kept so a late retry or a frame pull hears how they ended. */
const KEEP_ENDED = 100;
/** Sign-ins one thread may have waiting at once. */
export const MAX_OPEN_PER_THREAD = 5;
/** How long `start` waits for the card's Allow to reach the agent's call. */
export const ALLOW_WAIT_MS = 10_000;

interface SignInRequest {
  readonly id: string;
  readonly threadId: string;
  readonly url: string;
  readonly origin: string;
  readonly profile: string | undefined;
  viewId: string | null;
  /** The person allowed it on the card; a retry of the tool waits without a new card. */
  allowed: boolean;
  readonly allowWaiters: Set<() => void>;
  outcome: BrowserSignInOutcome | null;
  timer: ReturnType<typeof setTimeout> | null;
  readonly waiters: Set<(outcome: BrowserSignInOutcome) => void>;
}

export interface SignInRequestsOptions extends Omit<SignInViewsOptions, "onEnd"> {
  readonly startMs?: number;
  readonly allowWaitMs?: number;
}

/** The request id a thread's own id for a sign-in maps to; a retry finds the same request. */
export function signInRequestId(threadId: string, clientRequestId: string): string {
  return `sign-in-${NodeCrypto.createHash("sha256")
    .update(`${threadId}\u0000${clientRequestId}`)
    .digest("hex")
    .slice(0, 24)}`;
}

const tokenRefused = () =>
  new BrowserRelayError(
    "invalid_request",
    "This window is not the one showing that sign-in. Use the window that opened it.",
  );

const notFound = () =>
  new BrowserRelayError("invalid_request", "That sign-in request does not exist any more.");

export class SignInRequests {
  readonly views: SignInViews;
  private readonly requests = new Map<string, SignInRequest>();
  private readonly byView = new Map<string, SignInRequest>();
  private readonly startMs: number;
  private readonly allowWaitMs: number;

  constructor(hub: BrowserRelayHub, options: SignInRequestsOptions = {}) {
    this.startMs = options.startMs ?? SIGN_IN_REQUEST_START_MS;
    this.allowWaitMs = options.allowWaitMs ?? ALLOW_WAIT_MS;
    this.views = new SignInViews(hub, {
      ...options,
      onEnd: (viewId, end) => this.viewEnded(viewId, end),
    });
  }

  async dispose() {
    for (const request of this.requests.values())
      if (request.viewId === null) this.finish(request, "expired");
    await this.views.dispose();
  }

  /** Records what a thread asks for, or finds it again on a retry with the same id. */
  ask(input: {
    threadId: string;
    clientRequestId: string;
    url: string;
    profile?: string | undefined;
  }): {
    requestId: string;
    origin: string;
    allowed: boolean;
    outcome: BrowserSignInOutcome | null;
  } {
    const url = checkSignInUrl(input.url);
    const id = signInRequestId(input.threadId, input.clientRequestId);
    const known = this.requests.get(id);
    if (known) {
      if (known.url !== url || known.profile !== input.profile)
        throw new BrowserRelayError(
          "invalid_request",
          "That clientRequestId was used for another page or profile. Use a new id for a new sign-in.",
        );
      return {
        requestId: id,
        origin: known.origin,
        allowed: known.allowed,
        outcome: known.outcome,
      };
    }
    const open = [...this.requests.values()].filter(
      (other) => other.threadId === input.threadId && other.outcome === null,
    ).length;
    if (open >= MAX_OPEN_PER_THREAD)
      throw new BrowserRelayError(
        "invalid_request",
        "This thread already has several sign-ins waiting. Wait for them to end first.",
      );
    const request: SignInRequest = {
      id,
      threadId: input.threadId,
      url,
      origin: new URL(url).origin,
      profile: input.profile,
      viewId: null,
      allowed: false,
      allowWaiters: new Set(),
      outcome: null,
      timer: null,
      waiters: new Set(),
    };
    request.timer = setTimeout(() => this.finish(request, "expired"), this.startMs);
    request.timer.unref?.();
    this.requests.set(id, request);
    this.trim();
    return { requestId: id, origin: request.origin, allowed: false, outcome: null };
  }

  /** The person pressed Allow on the card. */
  allow(requestId: string) {
    const request = this.requests.get(requestId);
    if (!request) return;
    request.allowed = true;
    for (const waiter of request.allowWaiters) waiter();
    request.allowWaiters.clear();
  }

  /** Waits for the card's Allow, which reaches the agent's call a moment after the person's click. */
  private allowedSoon(request: SignInRequest, timeoutMs: number) {
    if (request.allowed) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const waiter = () => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        request.allowWaiters.delete(waiter);
        resolve(request.allowed);
      }, timeoutMs);
      timer.unref?.();
      request.allowWaiters.add(waiter);
    });
  }

  /** The person said no on the card, or the card closed unanswered. */
  decline(requestId: string, outcome: "declined" | "expired") {
    const request = this.requests.get(requestId);
    if (!request || request.outcome !== null) return;
    // An open view ends as cancelled and reports that; one still opening is closed by start.
    if (request.viewId) {
      void this.views.cancel(request.viewId).catch(() => {});
      return;
    }
    this.finish(request, outcome);
  }

  /** How the request ended, or null within `timeoutMs` while it is still open. */
  waitForEnd(requestId: string, timeoutMs: number): Promise<BrowserSignInOutcome | null> {
    const request = this.requests.get(requestId);
    if (!request) return Promise.reject(notFound());
    if (request.outcome !== null) return Promise.resolve(request.outcome);
    return new Promise((resolve) => {
      const waiter = (outcome: BrowserSignInOutcome) => {
        clearTimeout(timer);
        resolve(outcome);
      };
      const timer = setTimeout(() => {
        request.waiters.delete(waiter);
        resolve(null);
      }, timeoutMs);
      timer.unref?.();
      request.waiters.add(waiter);
    });
  }

  /** Opens the view for a request, on the device that sent `viewerKey`. One view per request. */
  async start(
    requestId: string,
    viewerKey: string,
  ): Promise<SignInViewStarted & { readonly origin: string }> {
    const request = this.requests.get(requestId);
    if (!request) throw notFound();
    if (request.outcome !== null)
      throw new BrowserRelayError("invalid_request", "That sign-in has ended.");
    if (request.viewId !== null)
      throw new BrowserRelayError(
        "tab_in_use",
        "That sign-in is already open on another device. Finish or cancel it there.",
      );
    // Claimed before the tab opens, so a second device cannot start a second view meanwhile.
    request.viewId = "";
    try {
      // Nothing opens in the person's Chrome until they allowed it on the card.
      if (!(await this.allowedSoon(request, this.allowWaitMs)))
        throw new BrowserRelayError("invalid_request", "Allow the sign-in on its card first.");
      if (request.outcome !== null)
        throw new BrowserRelayError("invalid_request", "That sign-in has ended.");
      const started = await this.views.start({
        url: request.url,
        viewerKey,
        profile: request.profile,
      });
      if (request.outcome !== null) {
        await this.views.cancel(started.viewId).catch(() => {});
        throw new BrowserRelayError("invalid_request", "That sign-in has ended.");
      }
      if (request.timer) clearTimeout(request.timer);
      request.timer = null;
      request.viewId = started.viewId;
      this.byView.set(started.viewId, request);
      return { ...started, origin: request.origin };
    } catch (error) {
      if (request.viewId === "") request.viewId = null;
      throw error;
    }
  }

  /** The newest sealed frame, or how the view ended. */
  async frame(viewId: string): Promise<{ sealed?: string; ended?: BrowserSignInOutcome }> {
    const request = this.byView.get(viewId);
    if (!request) throw notFound();
    if (request.outcome !== null) return { ended: request.outcome };
    try {
      return await this.views.frame(viewId);
    } catch (error) {
      // The view may have ended while the frame was taken.
      if (request.outcome !== null) return { ended: request.outcome };
      throw error;
    }
  }

  /** Input needs the view's token, which only the device that opens its frames has. */
  input(viewId: string, token: string, input: SignInInput) {
    if (!this.byView.has(viewId)) throw notFound();
    if (!this.views.tokenMatches(viewId, token)) throw tokenRefused();
    return this.views.input(viewId, input);
  }

  /** Done releases the tab to threads, so it needs the token; Cancel only closes it. */
  end(viewId: string, end: "done" | "cancel", token?: string) {
    const request = this.byView.get(viewId);
    if (!request) throw notFound();
    if (request.outcome !== null) return Promise.resolve();
    if (end === "cancel") return this.views.cancel(viewId);
    if (!this.views.tokenMatches(viewId, token)) throw tokenRefused();
    return this.views.done(viewId);
  }

  private viewEnded(viewId: string, end: SignInViewEnd) {
    const request = this.byView.get(viewId);
    if (request) this.finish(request, end);
  }

  private finish(request: SignInRequest, outcome: BrowserSignInOutcome) {
    if (request.outcome !== null) return;
    request.outcome = outcome;
    if (request.timer) clearTimeout(request.timer);
    request.timer = null;
    for (const waiter of request.waiters) waiter(outcome);
    request.waiters.clear();
  }

  /** Forgets the oldest ended requests; open ones are always kept. */
  private trim() {
    const ended = [...this.requests.values()].filter((request) => request.outcome !== null);
    for (const request of ended.slice(0, Math.max(0, ended.length - KEEP_ENDED))) {
      this.requests.delete(request.id);
      if (request.viewId) this.byView.delete(request.viewId);
    }
  }
}
