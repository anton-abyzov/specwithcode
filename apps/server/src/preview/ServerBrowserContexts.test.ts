// @effect-diagnostics globalDate:off - Drives the idle sweep with explicit wall-clock instants.
import * as NodeEvents from "node:events";

import { INCOGNITO_BROWSER_PROFILE_ID } from "@specweave-studio/contracts";
import { chromium, type Browser, type BrowserContext, type BrowserType } from "playwright-core";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { ServerBrowserContexts } from "./ServerBrowserContexts.ts";

const launches = vi.hoisted(() => ({
  launch: vi.fn<BrowserType["launch"]>(),
  persistent: vi.fn<BrowserType["launchPersistentContext"]>(),
  mkdir: vi.fn().mockResolvedValue(undefined),
  rm: vi.fn().mockResolvedValue(undefined),
}));
vi.spyOn(chromium, "launch").mockImplementation(launches.launch);
vi.spyOn(chromium, "launchPersistentContext").mockImplementation(launches.persistent);
vi.mock("node:fs/promises", () => ({ mkdir: launches.mkdir, rm: launches.rm }));

const makeContext = () => {
  const events = new NodeEvents.EventEmitter();
  let closed = false;
  return {
    on: vi.fn((event: string, listener: () => void) => events.on(event, listener)),
    pages: vi.fn(() => []),
    close: vi.fn(async () => {
      if (!closed) {
        closed = true;
        events.emit("close");
      }
    }),
  };
};

const makeBrowser = () => {
  const events = new NodeEvents.EventEmitter();
  const contexts: ReturnType<typeof makeContext>[] = [];
  return {
    contexts,
    on: vi.fn((event: string, listener: () => void) => events.on(event, listener)),
    newContext: vi.fn(async () => {
      const context = makeContext();
      contexts.push(context);
      return context as unknown as BrowserContext;
    }),
    close: vi.fn(async () => {
      for (const context of contexts) await context.close();
      events.emit("disconnected");
    }),
  };
};

// The pool joins profile folders with the host's separator.
const profileDir = (name: string) =>
  ["", "test", "profiles", name].join(process.platform === "win32" ? "\\" : "/");
const workTeamProfile = profileDir("work%2Fteam");

const options = () => ({
  profilesDir: "/test/profiles",
  executable: vi.fn(async () => "/test/chromium"),
  env: {},
});

beforeEach(() => {
  launches.launch.mockReset();
  launches.persistent.mockReset();
  launches.mkdir.mockClear();
  launches.rm.mockClear();
});

describe("ServerBrowserContexts", () => {
  it("lazily shares one browser across concurrent isolated sessions and reuses each context", async () => {
    const browser = makeBrowser();
    const launch = Promise.withResolvers<Browser>();
    launches.launch.mockReturnValue(launch.promise);
    const configuration = options();
    const pool = new ServerBrowserContexts(configuration);
    expect(configuration.executable).not.toHaveBeenCalled();
    const first = pool.contextFor("default", "agent-a");
    const again = pool.contextFor("default", "agent-a");
    const second = pool.contextFor("default", "agent-b");
    const incognito = pool.contextFor(INCOGNITO_BROWSER_PROFILE_ID);
    launch.resolve(browser as unknown as Browser);
    const [a, reused, b, privateContext] = await Promise.all([first, again, second, incognito]);
    expect(a).toBe(reused);
    expect(new Set([a, b, privateContext]).size).toBe(3);
    expect(launches.launch).toHaveBeenCalledTimes(1);
    expect(launches.persistent).not.toHaveBeenCalled();
    expect(browser.newContext).toHaveBeenCalledWith({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 2,
    });
    await pool.close();
    expect(browser.close).toHaveBeenCalledTimes(1);
    for (const context of browser.contexts) expect(context.close).toHaveBeenCalled();
  });

  it("keeps human profiles persistent without sharing their storage with agents", async () => {
    const human = makeContext();
    const browser = makeBrowser();
    launches.persistent.mockResolvedValue(human as unknown as BrowserContext);
    launches.launch.mockResolvedValue(browser as unknown as Browser);
    const pool = new ServerBrowserContexts(options());
    const persistent = await pool.contextFor("work/team");
    expect(await pool.contextFor("work/team")).toBe(persistent);
    expect(await pool.contextFor("work/team", "agent")).not.toBe(persistent);
    expect(launches.persistent).toHaveBeenCalledExactlyOnceWith(
      workTeamProfile,
      expect.objectContaining({ chromiumSandbox: true, executablePath: "/test/chromium" }),
    );
    expect(launches.mkdir).toHaveBeenCalledWith(workTeamProfile, { recursive: true });
    await pool.close();
    expect(human.close).toHaveBeenCalledTimes(1);
  });

  it("clears a profile by closing its open context before deleting its storage", async () => {
    const human = makeContext();
    const browser = makeBrowser();
    launches.persistent.mockResolvedValue(human as unknown as BrowserContext);
    launches.launch.mockResolvedValue(browser as unknown as Browser);
    const onContextClose = vi.fn();
    const pool = new ServerBrowserContexts({ ...options(), onContextClose });
    const persistent = await pool.contextFor("work/team");
    const agent = await pool.contextFor("work/team", "agent");
    launches.rm.mockImplementationOnce(async () => {
      expect(human.close).toHaveBeenCalledTimes(1);
    });
    await pool.clearProfile("work/team");
    expect(onContextClose).toHaveBeenCalledExactlyOnceWith(persistent);
    expect(launches.rm).toHaveBeenCalledExactlyOnceWith(workTeamProfile, {
      recursive: true,
      force: true,
    });
    expect(await pool.contextFor("work/team", "agent")).toBe(agent);
    expect(browser.contexts[0]?.close).not.toHaveBeenCalled();
    launches.persistent.mockResolvedValue(makeContext() as unknown as BrowserContext);
    expect(await pool.contextFor("work/team")).not.toBe(persistent);
    await pool.clearProfile("never-opened");
    expect(launches.rm).toHaveBeenLastCalledWith(profileDir("never-opened"), {
      recursive: true,
      force: true,
    });
    await pool.close();
  });

  it("opens a profile requested during its clear only after the storage is deleted", async () => {
    launches.persistent.mockImplementation(async () => makeContext() as unknown as BrowserContext);
    const configuration = options();
    const pool = new ServerBrowserContexts(configuration);
    await pool.contextFor("work/team");
    const removing = Promise.withResolvers<void>();
    const removed = Promise.withResolvers<void>();
    let deleted = false;
    launches.rm.mockImplementationOnce(async () => {
      removing.resolve();
      await removed.promise;
      deleted = true;
    });
    // Launching starts by resolving the executable; record whether storage was gone by then.
    const launchedAfterDelete: Array<boolean> = [];
    configuration.executable.mockImplementation(async () => {
      launchedAfterDelete.push(deleted);
      return "/test/chromium";
    });
    const clearing = pool.clearProfile("work/team");
    const reopening = pool.contextFor("work/team");
    await removing.promise;
    removed.resolve();
    await Promise.all([clearing, reopening]);
    expect(launchedAfterDelete).toEqual([true]);
    await pool.close();
  });

  it.each([undefined, "default"])(
    "never retries a failed %s launch with the sandbox disabled",
    async (profile) => {
      const launch = profile ? launches.persistent : launches.launch;
      launch.mockRejectedValue(new Error("sandbox unavailable"));
      const pool = new ServerBrowserContexts(options());
      await expect(pool.contextFor(profile ?? INCOGNITO_BROWSER_PROFILE_ID)).rejects.toThrow(
        "sandbox unavailable",
      );
      expect(launch).toHaveBeenCalledTimes(1);
      expect(
        profile ? launches.persistent.mock.calls[0]?.[1] : launches.launch.mock.calls[0]?.[0],
      ).toMatchObject({ chromiumSandbox: true });
      await pool.close();
    },
  );

  it("allows only an explicit sandbox opt-out", async () => {
    const browser = makeBrowser();
    launches.launch.mockResolvedValue(browser as unknown as Browser);
    const pool = new ServerBrowserContexts({
      ...options(),
      env: { STUDIO_SERVER_BROWSER_SANDBOX: "0" },
    });
    await pool.contextFor(INCOGNITO_BROWSER_PROFILE_ID);
    expect(launches.launch).toHaveBeenCalledWith(
      expect.objectContaining({ chromiumSandbox: false }),
    );
    await pool.close();
  });

  it("retries a failed startup on a later request with sandboxing still enabled", async () => {
    const browser = makeBrowser();
    launches.launch
      .mockRejectedValueOnce(new Error("executable unavailable"))
      .mockResolvedValue(browser as unknown as Browser);
    const pool = new ServerBrowserContexts(options());
    await expect(pool.contextFor("default", "agent")).rejects.toThrow("executable unavailable");
    await pool.contextFor("default", "agent");
    expect(launches.launch).toHaveBeenCalledTimes(2);
    expect(launches.launch).toHaveBeenLastCalledWith(
      expect.objectContaining({ chromiumSandbox: true }),
    );
    await pool.close();
  });

  it("evicts a closed context without closing other agents or relaunching chromium", async () => {
    const browser = makeBrowser();
    launches.launch.mockResolvedValue(browser as unknown as Browser);
    const onContextClose = vi.fn();
    const pool = new ServerBrowserContexts({ ...options(), onContextClose });
    const a = await pool.contextFor("default", "agent-a");
    const b = await pool.contextFor("default", "agent-b");
    await a.close();
    expect(onContextClose).toHaveBeenCalledWith(a);
    expect(await pool.contextFor("default", "agent-a")).not.toBe(a);
    expect(await pool.contextFor("default", "agent-b")).toBe(b);
    expect(browser.close).not.toHaveBeenCalled();
    expect(launches.launch).toHaveBeenCalledTimes(1);
    await pool.close();
  });

  it("ends every browser process once no page has been open for the idle period", async () => {
    const human = makeContext();
    const browser = makeBrowser();
    launches.persistent.mockResolvedValue(human as unknown as BrowserContext);
    launches.launch.mockResolvedValue(browser as unknown as Browser);
    const onContextClose = vi.fn();
    const pool = new ServerBrowserContexts({ ...options(), onContextClose });
    await pool.contextFor("default");
    const agent = await pool.contextFor("default", "agent");
    const idleMs = 60_000;
    const start = Date.now();
    // A page in any context keeps both processes and restarts the idle clock.
    human.pages.mockReturnValue([{}] as never);
    expect(await pool.closeIfIdle(idleMs, start + 10 * idleMs)).toBe(false);
    human.pages.mockReturnValue([]);
    expect(await pool.closeIfIdle(idleMs, start + 10 * idleMs + idleMs / 2)).toBe(false);
    expect(human.close).not.toHaveBeenCalled();
    expect(browser.close).not.toHaveBeenCalled();
    expect(await pool.closeIfIdle(idleMs, start + 11 * idleMs + 1)).toBe(true);
    expect(human.close).toHaveBeenCalledTimes(1);
    expect(browser.close).toHaveBeenCalledTimes(1);
    expect(onContextClose).toHaveBeenCalledWith(agent);
    // Nothing left to close; the next tab launches both again.
    expect(await pool.closeIfIdle(idleMs, Date.now() + 100 * idleMs)).toBe(false);
    const reopened = makeContext();
    launches.persistent.mockResolvedValue(reopened as unknown as BrowserContext);
    expect(await pool.contextFor("default")).toBe(reopened);
    expect(await pool.contextFor("default", "agent")).not.toBe(agent);
    expect(launches.persistent).toHaveBeenCalledTimes(2);
    expect(launches.launch).toHaveBeenCalledTimes(2);
    await pool.close();
  });

  it("keeps the browser while a context is opening or a scratch page is open", async () => {
    const browser = makeBrowser();
    const launch = Promise.withResolvers<Browser>();
    launches.launch.mockReturnValue(launch.promise);
    const pool = new ServerBrowserContexts(options());
    const opening = pool.contextFor("default", "agent");
    expect(await pool.closeIfIdle(0, Date.now() + 3_600_000)).toBe(false);
    launch.resolve(browser as unknown as Browser);
    await opening;
    const scratchClosed = new NodeEvents.EventEmitter();
    const scratch = {
      once: (name: string, listener: () => void) => scratchClosed.once(name, listener),
    };
    browser.newContext.mockImplementationOnce(async () => {
      const context = makeContext();
      browser.contexts.push(context);
      return { ...context, newPage: async () => scratch } as unknown as BrowserContext;
    });
    await pool.scratchPage();
    expect(await pool.closeIfIdle(0, Date.now() + 3_600_000)).toBe(false);
    expect(browser.close).not.toHaveBeenCalled();
    scratchClosed.emit("close");
    expect(await pool.closeIfIdle(0, Date.now() + 3_600_000)).toBe(true);
    expect(browser.close).toHaveBeenCalledTimes(1);
    await pool.close();
  });

  it("reopens a profile requested during an idle close only after its process is gone", async () => {
    const first = makeContext();
    const closed = Promise.withResolvers<void>();
    let gone = false;
    first.close.mockImplementationOnce(async () => {
      await closed.promise;
      gone = true;
    });
    launches.persistent.mockResolvedValueOnce(first as unknown as BrowserContext);
    const configuration = options();
    const pool = new ServerBrowserContexts(configuration);
    await pool.contextFor("default");
    const launchedAfterClose: Array<boolean> = [];
    configuration.executable.mockImplementation(async () => {
      launchedAfterClose.push(gone);
      return "/test/chromium";
    });
    const second = makeContext();
    launches.persistent.mockResolvedValueOnce(second as unknown as BrowserContext);
    const idle = pool.closeIfIdle(0, Date.now() + 1);
    // A second sweep while the first close runs does nothing.
    expect(await pool.closeIfIdle(0, Date.now() + 2)).toBe(false);
    const reopening = pool.contextFor("default");
    closed.resolve();
    expect(await idle).toBe(true);
    expect(await reopening).toBe(second);
    expect(launchedAfterClose).toEqual([true]);
    await pool.close();
  });

  const hungProfile = async () => {
    const stuck = makeContext();
    const released = Promise.withResolvers<void>();
    const state = { gone: false };
    stuck.close.mockImplementationOnce(async () => {
      await released.promise;
      state.gone = true;
    });
    launches.persistent.mockResolvedValueOnce(stuck as unknown as BrowserContext);
    launches.launch.mockResolvedValue(makeBrowser() as unknown as Browser);
    const pool = new ServerBrowserContexts({ ...options(), idleCloseTimeoutMs: 20 });
    await pool.contextFor("default");
    expect(await pool.closeIfIdle(0, Date.now() + 1)).toBe(true);
    return { pool, released, state };
  };
  const settle = async () => {
    for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
  };

  it("after a hung idle close times out, agents proceed but that profile waits for its process", async () => {
    const { pool, released, state } = await hungProfile();
    // An agent's isolated context does not wait for the hung profile process.
    await pool.contextFor("default", "agent-1");
    const reopenedAfterClose: Array<boolean> = [];
    launches.persistent.mockImplementationOnce(async () => {
      reopenedAfterClose.push(state.gone);
      return makeContext() as unknown as BrowserContext;
    });
    const reopening = pool.contextFor("default");
    await settle();
    expect(reopenedAfterClose).toEqual([]);
    released.resolve();
    await reopening;
    expect(reopenedAfterClose).toEqual([true]);
    await pool.close();
  });

  it("deletes a hung profile only after its process ends, even after the idle close timed out", async () => {
    const { pool, released, state } = await hungProfile();
    const deletedAfterClose: Array<boolean> = [];
    launches.rm.mockImplementationOnce(async () => {
      deletedAfterClose.push(state.gone);
    });
    const clearing = pool.clearProfile("default");
    await settle();
    expect(deletedAfterClose).toEqual([]);
    released.resolve();
    await clearing;
    expect(deletedAfterClose).toEqual([true]);
    await pool.close();
  });

  it("a tab requested while a hung profile is being cleared opens after the clear", async () => {
    const { pool, released, state } = await hungProfile();
    const order: Array<string> = [];
    launches.rm.mockImplementationOnce(async () => {
      order.push(`deleted:${state.gone}`);
    });
    launches.persistent.mockImplementationOnce(async () => {
      order.push("opened");
      return makeContext() as unknown as BrowserContext;
    });
    const clearing = pool.clearProfile("default");
    const reopening = pool.contextFor("default");
    await settle();
    released.resolve();
    await Promise.all([clearing, reopening]);
    expect(order).toEqual(["deleted:true", "opened"]);
    await pool.close();
  });

  it("a second clear of a profile waits for the first to end its process", async () => {
    const first = makeContext();
    const closed = Promise.withResolvers<void>();
    let gone = false;
    first.close.mockImplementationOnce(async () => {
      await closed.promise;
      gone = true;
    });
    launches.persistent.mockResolvedValueOnce(first as unknown as BrowserContext);
    const pool = new ServerBrowserContexts(options());
    await pool.contextFor("work");
    const deletedAfterClose: Array<boolean> = [];
    launches.rm.mockImplementation(async () => {
      deletedAfterClose.push(gone);
    });
    const clears = [pool.clearProfile("work"), pool.clearProfile("work")];
    await settle();
    expect(deletedAfterClose).toEqual([]);
    closed.resolve();
    await Promise.all(clears);
    expect(deletedAfterClose).toEqual([true, true]);
    launches.rm.mockReset();
    launches.rm.mockResolvedValue(undefined);
    await pool.close();
  });

  it("shuts down while a tab still waits on a hung profile process", async () => {
    const { pool } = await hungProfile();
    const waiting = pool.contextFor("default");
    const clearing = pool.clearProfile("work");
    await settle();
    await pool.close();
    await expect(waiting).rejects.toThrow("closed");
    await clearing;
    expect(launches.persistent).toHaveBeenCalledTimes(1);
  });

  it("deletes a profile only after an idle close has ended its process", async () => {
    const first = makeContext();
    const closed = Promise.withResolvers<void>();
    let gone = false;
    first.close.mockImplementationOnce(async () => {
      await closed.promise;
      gone = true;
    });
    launches.persistent.mockResolvedValueOnce(first as unknown as BrowserContext);
    const pool = new ServerBrowserContexts(options());
    await pool.contextFor("work");
    const deletedAfterClose: Array<boolean> = [];
    launches.rm.mockImplementationOnce(async () => {
      deletedAfterClose.push(gone);
    });
    const idle = pool.closeIfIdle(0, Date.now() + 1);
    const clearing = pool.clearProfile("work");
    closed.resolve();
    await Promise.all([idle, clearing]);
    expect(deletedAfterClose).toEqual([true]);
    await pool.close();
  });

  it("cleans up a browser whose launch finishes during shutdown and rejects future work", async () => {
    const browser = makeBrowser();
    const launch = Promise.withResolvers<Browser>();
    launches.launch.mockReturnValue(launch.promise);
    const pool = new ServerBrowserContexts(options());
    const opening = expect(pool.contextFor("default", "agent")).rejects.toThrow("closed");
    const closing = pool.close();
    launch.resolve(browser as unknown as Browser);
    await Promise.all([opening, closing]);
    await expect(pool.contextFor("default", "agent")).rejects.toThrow("closed");
    await pool.close();
    expect(browser.close).toHaveBeenCalledTimes(1);
    expect(browser.contexts[0]?.close).toHaveBeenCalled();
  });
});
