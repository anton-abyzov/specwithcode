/**
 * Which of this app's windows show another machine's screen right now (1490,
 * 1519). While any does, computer use on this machine holds off: its
 * screenshots would carry the other machine's screen into a thread.
 *
 * Counted per view, not per window: a window can show two views, and closing
 * one must not resume computer use while the other is still on screen. Each
 * view has a token its page chose; starting or ending it twice changes
 * nothing. A page that reloads, crashes or closes loses its views. A viewer
 * window of its own counts from creation to close, whatever its page says.
 *
 * It also keeps one view per machine across the app: a second view of the
 * same machine would only get "busy" from that machine, so the one already
 * open is brought forward instead.
 */

/** Tokens a page may name a view by: short, plain, never empty. */
const TOKEN = /^[A-Za-z0-9_-]{8,64}$/;
/** Machine ids as the app writes them. */
const ENVIRONMENT_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export const isScreenViewToken = (value: unknown): value is string =>
  typeof value === "string" && TOKEN.test(value);

export const isScreenViewEnvironmentId = (value: unknown): value is string =>
  typeof value === "string" && ENVIRONMENT_ID.test(value);

/** What a page hears when it asks to start a view. */
export type ScreenViewBegin =
  | { readonly kind: "ok" }
  /** Another window already shows this machine; that window is brought forward. */
  | { readonly kind: "elsewhere"; readonly owner: number }
  | { readonly kind: "invalid" };

export class ScreenViewingRegistry {
  /** owner (a renderer's id) → token → machine */
  private readonly views = new Map<number, Map<string, string>>();
  /** owner → machine, for viewer windows of their own */
  private readonly windows = new Map<number, string>();

  /** True while any window shows another machine's screen. */
  active(): boolean {
    if (this.windows.size > 0) return true;
    for (const tokens of this.views.values()) if (tokens.size > 0) return true;
    return false;
  }

  /** The window that shows this machine now, if any. */
  ownerOf(environmentId: string): number | undefined {
    for (const [owner, machine] of this.windows) if (machine === environmentId) return owner;
    for (const [owner, tokens] of this.views)
      for (const machine of tokens.values()) if (machine === environmentId) return owner;
    return undefined;
  }

  begin(owner: number, token: unknown, environmentId: unknown): ScreenViewBegin {
    if (!isScreenViewToken(token) || !isScreenViewEnvironmentId(environmentId))
      return { kind: "invalid" };
    const tokens = this.views.get(owner);
    const same = tokens?.get(token);
    if (same !== undefined) return same === environmentId ? { kind: "ok" } : { kind: "invalid" };
    const holder = this.ownerOf(environmentId);
    if (holder !== undefined && holder !== owner) return { kind: "elsewhere", owner: holder };
    // One view of a machine per window too: the second would only hear "busy".
    if (holder === owner && tokens !== undefined && [...tokens.values()].includes(environmentId))
      return { kind: "elsewhere", owner };
    const next = tokens ?? new Map<string, string>();
    next.set(token, environmentId);
    this.views.set(owner, next);
    return { kind: "ok" };
  }

  end(owner: number, token: unknown): void {
    if (!isScreenViewToken(token)) return;
    const tokens = this.views.get(owner);
    if (tokens === undefined) return;
    tokens.delete(token);
    if (tokens.size === 0) this.views.delete(owner);
  }

  /** The page was replaced or its process ended: its views are gone. Its own window, if any, stays counted. */
  dropViews(owner: number): void {
    this.views.delete(owner);
  }

  /** A viewer window of its own, counted until `release`. */
  holdWindow(owner: number, environmentId: string): void {
    this.windows.set(owner, environmentId);
  }

  /** The window closed: nothing of it counts any more. */
  release(owner: number): void {
    this.windows.delete(owner);
    this.views.delete(owner);
  }
}

/** The one registry of this app's main process. */
export const screenViewing = new ScreenViewingRegistry();
