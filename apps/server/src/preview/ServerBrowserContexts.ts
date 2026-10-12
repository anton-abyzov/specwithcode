// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off - Owns Playwright resources outside the Effect runtime.
import { INCOGNITO_BROWSER_PROFILE_ID } from "@specweave-studio/contracts";
import { constVoid } from "effect/Function";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import type { Browser, BrowserContext } from "playwright-core";

import { sandboxDisabled } from "./PreviewBrowserHost.ts";

// Playwright needs its files on disk. createRequire also resolves it from a Node SEA executable.
const requirePlaywright = NodeModule.createRequire(import.meta.url);
const loadPlaywright = () =>
  requirePlaywright("playwright-core") as typeof import("playwright-core");

interface Options {
  readonly profilesDir: string;
  /** The shared headless browser's executable, installing it on first use. */
  readonly executable: () => Promise<string>;
  /** Replaces a failed launch's error with the host setup it is missing, if any. */
  readonly diagnose?: (executable: string, cause: unknown) => Promise<unknown>;
  readonly env?: NodeJS.ProcessEnv;
  readonly onContextClose?: (context: BrowserContext) => void;
  /** How long an idle close waits for the browser to exit before letting new work proceed. */
  readonly idleCloseTimeoutMs?: number;
}

/** A browser that hangs while closing must not hold back every later tab or shutdown. */
export const IDLE_CLOSE_TIMEOUT_MS = 30_000;

/** Persistent human profiles keep their storage; isolated agents share a browser, never a context. */
export class ServerBrowserContexts {
  private readonly options: Options;
  private readonly contexts = new Map<string, Promise<BrowserContext>>();
  /** Profile clears in progress; a context for that profile opens after its storage is gone. */
  private readonly clearing = new Map<string, Promise<void>>();
  private browser: Promise<Browser> | undefined;
  private closing: Promise<void> | undefined;
  /** Contexts that finished opening; a key in `contexts` and not here is still opening. */
  private readonly opened = new Map<string, BrowserContext>();
  /** Scratch pages still open; each keeps the shared browser busy. */
  private scratchPages = 0;
  /** The last moment anything used, or was seen using, a browser. */
  private lastBusyAt = Date.now();
  /** An idle close in progress; new contexts open after its processes are gone. */
  private idleClosing: Promise<void> | undefined;
  /**
   * Persistent profiles an idle close is still ending, with no time limit: a profile's
   * directory is never reopened or deleted while an old process may still hold it.
   */
  private readonly profileClosing = new Map<string, Promise<void>>();
  /** Settles on shutdown, so nothing waiting on a hung profile holds shutdown back. */
  private readonly shutdown = Promise.withResolvers<void>();

  constructor(options: Options) {
    this.options = options;
  }

  private async launchOptions() {
    const executablePath = await this.options.executable();
    const env = this.options.env ?? process.env;
    return {
      executablePath,
      env,
      args: ["--disable-gpu", "--force-device-scale-factor=2"],
      headless: true,
      // Only an explicit operator opt-out disables sandboxing. Launch errors never do.
      chromiumSandbox: !sandboxDisabled(env),
    };
  }

  private async launch<A>(options: { readonly executablePath: string }, start: () => Promise<A>) {
    try {
      return await start();
    } catch (cause) {
      throw (await this.options.diagnose?.(options.executablePath, cause)) ?? cause;
    }
  }

  private sharedBrowser() {
    if (!this.browser) {
      const launched = this.launchOptions().then(async (options) => {
        const { chromium } = loadPlaywright();
        const browser = await this.launch(options, () => chromium.launch(options));
        browser.on("disconnected", () => {
          if (this.browser === launched) this.browser = undefined;
        });
        return browser;
      });
      this.browser = launched;
      void launched.catch(() => {
        if (this.browser === launched) this.browser = undefined;
      });
    }
    return this.browser;
  }

  contextFor(profileId: string, isolationKey?: string): Promise<BrowserContext> {
    if (this.closing) return Promise.reject(new Error("The preview browser is closed."));
    const key = JSON.stringify([profileId, isolationKey ?? null]);
    this.lastBusyAt = Date.now();
    const cached = this.contexts.get(key);
    if (cached) return cached;
    // A persistent profile cannot open while its previous process still holds it.
    const cleared = Promise.all([
      this.clearing.get(key)?.catch(constVoid),
      this.idleClosing?.catch(constVoid),
      this.profileEnded(key),
    ]);
    const pending: Promise<BrowserContext> = cleared
      .then(() => this.createContext(profileId, isolationKey))
      .then(async (context) => {
        context.on("close", () => {
          if (this.contexts.get(key) === pending) this.contexts.delete(key);
          if (this.opened.get(key) === context) this.opened.delete(key);
          this.options.onContextClose?.(context);
        });
        for (const page of context.pages()) await page.close().catch(constVoid);
        if (this.closing) {
          await context.close().catch(constVoid);
          throw new Error("The preview browser is closed.");
        }
        if (this.contexts.get(key) === pending) this.opened.set(key, context);
        return context;
      });
    this.contexts.set(key, pending);
    void pending.catch(() => {
      if (this.contexts.get(key) === pending) this.contexts.delete(key);
    });
    return pending;
  }

  /** Until an idle close has ended this profile's old process; rejects on shutdown. */
  private profileEnded(key: string) {
    const ending = this.profileClosing.get(key);
    if (!ending) return undefined;
    const closed = this.shutdown.promise.then(() => {
      throw new Error("The preview browser is closed.");
    });
    return Promise.race([ending, closed]);
  }

  private async createContext(profileId: string, isolationKey?: string) {
    const contextOptions = { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 };
    if (isolationKey !== undefined || profileId === INCOGNITO_BROWSER_PROFILE_ID) {
      const browser = await this.sharedBrowser();
      return browser.newContext(contextOptions);
    }
    const directory = this.profileDirectory(profileId);
    const options = await this.launchOptions();
    const { chromium } = loadPlaywright();
    await NodeFSP.mkdir(directory, { recursive: true });
    return this.launch(options, () =>
      chromium.launchPersistentContext(directory, { ...options, ...contextOptions }),
    );
  }

  private profileDirectory(profileId: string) {
    const encoded = encodeURIComponent(profileId);
    return NodePath.join(
      this.options.profilesDir,
      profileId === "." || profileId === ".." ? encoded.replaceAll(".", "%2E") : encoded,
    );
  }

  /** A throwaway page in the shared browser, for work that must not touch a tab's own storage. */
  async scratchPage() {
    if (this.closing) throw new Error("The preview browser is closed.");
    this.scratchPages += 1;
    this.lastBusyAt = Date.now();
    try {
      await this.idleClosing?.catch(constVoid);
      const context = await (await this.sharedBrowser()).newContext();
      const page = await context.newPage();
      page.once("close", () => {
        this.scratchPages -= 1;
        this.lastBusyAt = Date.now();
        void context.close().catch(constVoid);
      });
      return page;
    } catch (cause) {
      this.scratchPages -= 1;
      throw cause;
    }
  }

  /** Whether any page is open, or any context, scratch page or profile clear is in flight. */
  private busy() {
    if (this.scratchPages > 0 || this.clearing.size > 0) return true;
    if (this.contexts.size !== this.opened.size) return true;
    for (const context of this.opened.values()) if (context.pages().length > 0) return true;
    return false;
  }

  /**
   * Ends every browser process once nothing has used one for `idleMs`: no page open in any
   * context and nothing opening. A headless browser left running after its last tab closed
   * keeps the server from ever being quiet (an update waits for that). The next tab
   * launches the browser again. Resolves whether it closed anything; never rejects.
   */
  closeIfIdle(idleMs: number, now = Date.now()): Promise<boolean> {
    if (this.closing || this.idleClosing) return Promise.resolve(false);
    if (this.busy()) {
      this.lastBusyAt = now;
      return Promise.resolve(false);
    }
    if (now - this.lastBusyAt < idleMs) return Promise.resolve(false);
    const browser = this.browser;
    const opened = [...this.opened.entries()];
    if (!browser && opened.length === 0) return Promise.resolve(false);
    this.browser = undefined;
    this.contexts.clear();
    this.opened.clear();
    const closes = opened.map(([key, context]) => {
      const closed = context.close().then(constVoid, constVoid);
      const [profileId, isolationKey] = JSON.parse(key) as [string, string | null];
      if (isolationKey === null && profileId !== INCOGNITO_BROWSER_PROFILE_ID) {
        const gate = closed.then(() => {
          if (this.profileClosing.get(key) === gate) this.profileClosing.delete(key);
        });
        this.profileClosing.set(key, gate);
      }
      return closed;
    });
    const ended = (async () => {
      await Promise.all(closes);
      const launched = await browser?.catch(() => undefined);
      await launched?.close().catch(constVoid);
    })();
    // After the timeout, isolated tabs use a new shared browser (a hung one exits with the
    // server, or is stopped by an update); persistent profiles still wait for their own close.
    // A tab waiting on such a profile when an update stops the hung process launches a new
    // browser then, which the update refuses as new work; the next update attempt proceeds.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, this.options.idleCloseTimeoutMs ?? IDLE_CLOSE_TIMEOUT_MS);
      timer.unref?.();
    });
    const closing = Promise.race([ended, timedOut]).finally(() => clearTimeout(timer));
    this.idleClosing = closing;
    // `closing` never rejects: every close above is settled or caught, and the timer resolves.
    return closing.then(() => {
      if (this.idleClosing === closing) this.idleClosing = undefined;
      this.lastBusyAt = Date.now();
      return true;
    });
  }

  /**
   * Drives a page the desktop app renders, through the CDP endpoint its relay
   * serves. The page keeps the desktop's storage, size, and window.
   */
  async connectDesktopPage(endpoint: string) {
    const { chromium } = loadPlaywright();
    const browser = await chromium.connectOverCDP(endpoint, { timeout: 15_000 });
    const page = browser.contexts().flatMap((context) => context.pages())[0];
    if (!page) {
      await browser.close().catch(constVoid);
      throw new Error("The desktop tab has no page.");
    }
    return { browser, page };
  }

  /** Closes a human profile's persistent context, ending its tabs, then deletes its storage. */
  async clearProfile(profileId: string) {
    if (profileId === INCOGNITO_BROWSER_PROFILE_ID) return;
    const key = JSON.stringify([profileId, null]);
    const clearing = (async () => {
      // Taken out of the cache before any await: a tab opened from here on waits for
      // this clear, and this clear never waits for such a tab.
      const previous = this.clearing.get(key);
      const pending = this.contexts.get(key);
      if (pending) this.contexts.delete(key);
      // An earlier clear may still be ending this profile's process.
      await previous?.catch(constVoid);
      // An idle close may still be ending this profile's process.
      if (this.idleClosing) await this.idleClosing.catch(constVoid);
      const ending = this.profileEnded(key);
      if (ending) await ending;
      if (pending) {
        const context = await pending.catch(() => undefined);
        await context?.close();
      }
      await NodeFSP.rm(this.profileDirectory(profileId), { recursive: true, force: true });
    })();
    this.clearing.set(key, clearing);
    try {
      await clearing;
    } finally {
      if (this.clearing.get(key) === clearing) this.clearing.delete(key);
    }
  }

  close() {
    this.closing ??= this.dispose();
    this.shutdown.resolve();
    return this.closing;
  }

  private async dispose() {
    await this.idleClosing?.catch(constVoid);
    await Promise.allSettled(
      [...this.contexts.values()].map(async (pending) => (await pending).close()),
    );
    const browser = await this.browser?.catch(() => undefined);
    await browser?.close().catch(constVoid);
    this.contexts.clear();
  }
}
