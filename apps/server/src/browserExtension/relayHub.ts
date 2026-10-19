// @effect-diagnostics globalDate:off globalTimers:off -- plain TypeScript with no Effect services; see the header.
/**
 * The SpecWithCode side of the SpecWithCode Browser extension: every paired
 * Chrome profile keeps one WebSocket open to this hub, proves itself with the
 * machine's pairing token, and then answers allow-listed chrome.* calls (see
 * apps/chrome-extension/src/relayConnection.js). Threads share a profile:
 * each tab belongs to the thread that opened or last drove it, so many threads
 * work side by side in their own tabs and never in each other's. The hub keeps
 * a short audit of what agents did.
 *
 * Plain TypeScript with no Effect services, so tests can drive it with a fake
 * extension and the route, the RPCs and the MCP tools share one instance.
 */
import type { BrowserExtensionAction, BrowserExtensionProfile } from "@specweave-studio/contracts";

export const RELAY_PROTOCOL_VERSION = 1;
/** Close codes the extension understands. */
export const CLOSE_REJECTED = 4401;
export const CLOSE_REPLACED = 4409;
export const CLOSE_BAD_HELLO = 4400;

const HELLO_TIMEOUT_MS = 10_000;
const DEFAULT_CALL_TIMEOUT_MS = 30_000;
/** A thread keeps a tab while it acts in it at least this often. */
export const TAB_IDLE_MS = 120_000;
const MAX_AUDIT = 50;
const MAX_THREAD_NAMES = 200;

export type BrowserRelayErrorCode =
  | "not_connected"
  | "choose_profile"
  | "profile_not_found"
  | "tab_in_use"
  | "needs_approval"
  | "tab_not_found"
  | "element_not_found"
  | "page_error"
  | "timeout"
  | "invalid_request";

export class BrowserRelayError extends Error {
  readonly code: BrowserRelayErrorCode;
  constructor(code: BrowserRelayErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "BrowserRelayError";
  }
}

/** The socket as the hub needs it; the HTTP route adapts the real WebSocket. */
export interface RelaySocket {
  send(text: string): void;
  close(code: number, reason: string): void;
}

export interface RelayHello {
  readonly protocol: number;
  readonly token: string;
  readonly label: string;
  readonly extensionVersion: string;
  readonly extensionId: string;
  /** One id per Chrome profile install (1.0.3+); empty from older versions. */
  readonly instanceId: string;
  readonly userAgent: string;
}

interface PendingCall {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export interface RelayDialog {
  readonly type: string;
  readonly message: string;
}

export interface TabOwner {
  readonly threadId: string;
  readonly since: number;
  lastActionAt: number;
}

export interface RemoteThreadName {
  readonly title: string;
  readonly machine: string;
}

export interface RelayThreadUse {
  readonly threadId: string;
  readonly tabs: number;
  readonly since: number;
  readonly lastActionAt: number;
}

export interface RelayProfile {
  readonly id: string;
  readonly label: string;
  readonly extensionVersion: string;
  readonly extensionId: string;
  readonly instanceId: string;
  readonly browser: string;
  readonly connectedAt: number;
  readonly attachedTabs: Set<number>;
  /** Tabs agents opened, newest last. */
  readonly agentTabs: Set<number>;
  readonly lastTabByThread: Map<string, number>;
  /** Dialogs Chrome showed and the hub answered, reported with the next result. */
  readonly dialogs: Map<number, RelayDialog>;
  /** Which thread drives each tab; a thread never acts in another thread's live tab. */
  readonly tabOwners: Map<number, TabOwner>;
}

interface Connection {
  readonly socket: RelaySocket;
  readonly pending: Map<number, PendingCall>;
  nextId: number;
  profile: RelayProfile | null;
  helloTimer: ReturnType<typeof setTimeout> | null;
  closed: boolean;
}

export interface RelaySession {
  /** Feed one text frame from the extension. */
  readonly receive: (text: string) => void;
  /** The socket closed. */
  readonly closed: () => void;
}

export interface BrowserRelayHubOptions {
  /** Constant-time check of the token a profile presents. */
  readonly verifyToken: (token: string) => boolean;
  /** The name shown in the extension's popup. */
  readonly machineName: () => string;
  readonly now?: () => number;
  /** Lets the hub answer CDP events (dialogs) without a caller waiting. */
  readonly onProfilesChanged?: () => void;
}

/** "Chrome 141" from a user agent; Edge and Brave report their own names. */
export function browserFromUserAgent(userAgent: string): string {
  const edge = /Edg\/(\d+)/.exec(userAgent);
  if (edge) return `Edge ${edge[1]}`;
  const chrome = /(?:HeadlessChrome|Chrome)\/(\d+)/.exec(userAgent);
  if (chrome) return `Chrome ${chrome[1]}`;
  return "Chromium";
}

/** Parse and bound the extension's first frame; null when it is not a hello. */
export function parseHello(text: string): RelayHello | null {
  let message: unknown;
  try {
    message = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof message !== "object" || message === null) return null;
  const { method, params } = message as { method?: unknown; params?: unknown };
  if (method !== "hello" || typeof params !== "object" || params === null) return null;
  const p = params as Record<string, unknown>;
  const str = (value: unknown, max: number) =>
    typeof value === "string" ? value.trim().slice(0, max) : "";
  return {
    protocol: typeof p.protocol === "number" ? p.protocol : 0,
    token: typeof p.token === "string" ? p.token : "",
    label: str(p.label, 60) || "Chrome",
    extensionVersion: str(p.extensionVersion, 20) || "unknown",
    extensionId: str(p.extensionId, 64),
    instanceId: str(p.instanceId, 64),
    userAgent: str(p.userAgent, 400),
  };
}

export class BrowserRelayHub {
  private readonly options: BrowserRelayHubOptions;
  private readonly connections = new Set<Connection>();
  private readonly audit: BrowserExtensionAction[] = [];
  private readonly threadNames = new Map<string, RemoteThreadName>();
  private readonly now: () => number;
  private profileSeq = 0;
  private readonly waiters = new Set<() => void>();

  constructor(options: BrowserRelayHubOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
  }

  /** A new socket from an extension. It must say hello with the right token first. */
  open(socket: RelaySocket): RelaySession {
    const connection: Connection = {
      socket,
      pending: new Map(),
      nextId: 1,
      profile: null,
      helloTimer: null,
      closed: false,
    };
    connection.helloTimer = setTimeout(
      () => this.reject(connection, CLOSE_BAD_HELLO, "no hello"),
      HELLO_TIMEOUT_MS,
    );
    this.connections.add(connection);
    return {
      receive: (text) => this.receive(connection, text),
      closed: () => this.dropConnection(connection, "The extension disconnected."),
    };
  }

  private reject(connection: Connection, code: number, reason: string) {
    try {
      connection.socket.close(code, reason);
    } catch {
      // Already gone.
    }
    this.dropConnection(connection, reason);
  }

  private receive(connection: Connection, text: string) {
    if (connection.closed) return;
    if (connection.profile === null) {
      const hello = parseHello(text);
      if (hello === null) return this.reject(connection, CLOSE_BAD_HELLO, "expected hello");
      if (!this.options.verifyToken(hello.token))
        return this.reject(connection, CLOSE_REJECTED, "pairing code rejected");
      if (connection.helloTimer) clearTimeout(connection.helloTimer);
      connection.helloTimer = null;
      // The same profile reconnecting replaces its stale socket. Store installs share one
      // extension id across Chrome profiles, so the install's own id decides when both sent one.
      for (const other of this.connections) {
        if (other === connection || other.profile === null) continue;
        const sameProfile =
          hello.instanceId && other.profile.instanceId
            ? other.profile.instanceId === hello.instanceId
            : other.profile.extensionId === hello.extensionId &&
              other.profile.label === hello.label;
        if (sameProfile) this.reject(other, CLOSE_REPLACED, "replaced by a newer connection");
      }
      connection.profile = {
        id: `p${++this.profileSeq}`,
        label: this.uniqueLabel(hello.label),
        extensionVersion: hello.extensionVersion,
        extensionId: hello.extensionId,
        instanceId: hello.instanceId,
        browser: browserFromUserAgent(hello.userAgent),
        connectedAt: this.now(),
        attachedTabs: new Set(),
        agentTabs: new Set(),
        lastTabByThread: new Map(),
        dialogs: new Map(),
        tabOwners: new Map(),
      };
      this.send(connection, {
        method: "welcome",
        params: { protocol: RELAY_PROTOCOL_VERSION, machine: this.options.machineName() },
      });
      this.changed();
      return;
    }
    let message: {
      id?: unknown;
      result?: unknown;
      error?: unknown;
      method?: unknown;
      params?: unknown;
    };
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (typeof message.id === "number") {
      const pending = connection.pending.get(message.id);
      if (!pending) return;
      connection.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error !== undefined && message.error !== null)
        pending.reject(new BrowserRelayError("page_error", chromeErrorText(message.error)));
      else pending.resolve(message.result);
      return;
    }
    if (typeof message.method === "string")
      this.onEvent(connection.profile, message.method, message.params);
  }

  private onEvent(profile: RelayProfile, method: string, params: unknown) {
    const args = Array.isArray(params) ? params : [];
    switch (method) {
      case "chrome.debugger.onEvent": {
        const tabId = (args[0] as { tabId?: number } | undefined)?.tabId;
        if (tabId === undefined) return;
        if (args[1] === "Page.javascriptDialogOpening") this.answerDialog(profile, tabId, args[2]);
        return;
      }
      case "chrome.debugger.onDetach": {
        const tabId = (args[0] as { tabId?: number } | undefined)?.tabId;
        if (tabId !== undefined) profile.attachedTabs.delete(tabId);
        this.changed();
        return;
      }
      case "chrome.tabs.onRemoved": {
        const tabId = typeof args[0] === "number" ? args[0] : undefined;
        if (tabId === undefined) return;
        profile.attachedTabs.delete(tabId);
        profile.agentTabs.delete(tabId);
        profile.tabOwners.delete(tabId);
        for (const [thread, tab] of profile.lastTabByThread)
          if (tab === tabId) profile.lastTabByThread.delete(thread);
        this.changed();
        return;
      }
    }
  }

  /**
   * A dialog blocks every script in its tab, so the hub answers at once:
   * alerts and leave-page prompts are accepted, confirm and prompt dismissed
   * (never agreeing to something on the user's behalf). The agent hears
   * about it with its next result.
   */
  private answerDialog(profile: RelayProfile, tabId: number, params: unknown) {
    const dialog = (params ?? {}) as { type?: unknown; message?: unknown };
    const type = typeof dialog.type === "string" ? dialog.type : "alert";
    const accept = type === "alert" || type === "beforeunload";
    profile.dialogs.set(tabId, {
      type,
      message: typeof dialog.message === "string" ? dialog.message.slice(0, 500) : "",
    });
    void this.call(profile.id, "chrome.debugger.sendCommand", [
      { tabId },
      "Page.handleJavaScriptDialog",
      { accept },
    ]).catch(() => {});
  }

  private uniqueLabel(label: string) {
    const taken = new Set(
      [...this.connections].flatMap((c) => (c.profile ? [c.profile.label] : [])),
    );
    if (!taken.has(label)) return label;
    for (let i = 2; ; i++) if (!taken.has(`${label} (${i})`)) return `${label} (${i})`;
  }

  private dropConnection(connection: Connection, reason: string) {
    if (connection.closed) return;
    connection.closed = true;
    if (connection.helloTimer) clearTimeout(connection.helloTimer);
    for (const pending of connection.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new BrowserRelayError("not_connected", reason));
    }
    connection.pending.clear();
    this.connections.delete(connection);
    if (connection.profile) this.changed();
  }

  /** This computer's name, as the extension's popup shows it. */
  machineName() {
    return this.options.machineName();
  }

  /** Tells Settings › Chrome to refresh. */
  changed() {
    this.options.onProfilesChanged?.();
    for (const wake of this.waiters) wake();
  }

  private send(connection: Connection, message: unknown) {
    connection.socket.send(JSON.stringify(message));
  }

  private connectionFor(profileId: string): Connection {
    for (const connection of this.connections)
      if (connection.profile?.id === profileId) return connection;
    throw new BrowserRelayError("not_connected", "That Chrome profile disconnected.");
  }

  /** Paired profiles, oldest first. */
  profiles(): ReadonlyArray<RelayProfile> {
    return [...this.connections].flatMap((c) => (c.profile ? [c.profile] : []));
  }

  /**
   * Threads on other machines have no record here, so the title and machine
   * their machine sent are kept for Settings › Chrome.
   */
  nameThread(threadId: string, name: RemoteThreadName) {
    this.threadNames.delete(threadId);
    this.threadNames.set(threadId, name);
    if (this.threadNames.size > MAX_THREAD_NAMES)
      this.threadNames.delete(this.threadNames.keys().next().value!);
  }

  private nameOf(threadId: string) {
    const name = this.threadNames.get(threadId);
    return name ? { title: name.title, machine: name.machine } : {};
  }

  profileSummaries(): Array<BrowserExtensionProfile & { readonly extensionId: string }> {
    const iso = (ms: number) => new Date(ms).toISOString();
    return this.profiles().map((profile) => {
      const threads = this.threadsUsing(profile).map((use) => ({
        threadId: use.threadId,
        tabs: use.tabs,
        since: iso(use.since),
        lastActionAt: iso(use.lastActionAt),
        ...this.nameOf(use.threadId),
      }));
      const latest = threads[0];
      return {
        id: profile.id,
        label: profile.label,
        extensionVersion: profile.extensionVersion,
        extensionId: profile.extensionId,
        browser: profile.browser,
        connectedAt: iso(profile.connectedAt),
        attachedTabs: profile.attachedTabs.size,
        // Older apps show one thread; give them the most recent.
        lease: latest
          ? { threadId: latest.threadId, since: latest.since, lastActionAt: latest.lastActionAt }
          : null,
        threads,
      };
    });
  }

  recentActions(): ReadonlyArray<BrowserExtensionAction> {
    return [...this.audit].reverse();
  }

  /** Call one allow-listed chrome.* method in a profile. */
  call(
    profileId: string,
    method: string,
    params: ReadonlyArray<unknown>,
    timeoutMs = DEFAULT_CALL_TIMEOUT_MS,
  ): Promise<unknown> {
    let connection: Connection;
    try {
      connection = this.connectionFor(profileId);
    } catch (error) {
      return Promise.reject(error);
    }
    const id = connection.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        connection.pending.delete(id);
        reject(new BrowserRelayError("timeout", `Chrome did not answer ${method} in time.`));
      }, timeoutMs);
      connection.pending.set(id, { resolve, reject, timer });
      try {
        this.send(connection, { id, method, params });
      } catch {
        clearTimeout(timer);
        connection.pending.delete(id);
        reject(new BrowserRelayError("not_connected", "That Chrome profile disconnected."));
      }
    });
  }

  /** Pick the profile a tool targets: by name, or the only one connected. */
  resolveProfile(name: string | undefined): RelayProfile {
    const profiles = this.profiles();
    if (profiles.length === 0)
      throw new BrowserRelayError(
        "not_connected",
        "The SpecWithCode Browser extension is not connected on this machine. Ask the user to open Chrome, then pair the extension in Settings › Chrome (it shows a Connect Chrome card in this thread).",
      );
    const wanted = name?.trim().toLowerCase();
    if (wanted) {
      const match =
        profiles.find((p) => p.label.toLowerCase() === wanted) ??
        profiles.find((p) => p.label.toLowerCase().includes(wanted));
      if (match) return match;
      throw new BrowserRelayError(
        "profile_not_found",
        `No connected Chrome profile is named "${name}". Connected: ${profiles.map((p) => p.label).join(", ")}.`,
      );
    }
    if (profiles.length === 1) return profiles[0]!;
    throw new BrowserRelayError(
      "choose_profile",
      `Several Chrome profiles are connected (${profiles.map((p) => p.label).join(", ")}). Pass profile with one of these names.`,
    );
  }

  private ownerLive(owner: TabOwner | undefined): owner is TabOwner {
    return owner !== undefined && this.now() - owner.lastActionAt < TAB_IDLE_MS;
  }

  /** The thread driving a tab right now, if any. */
  tabOwner(profile: RelayProfile, tabId: number): string | null {
    const owner = profile.tabOwners.get(tabId);
    return this.ownerLive(owner) ? owner.threadId : null;
  }

  /**
   * Give a tab to a thread, or refresh its hold. Refuses while another thread
   * acted in that tab in the last two minutes; other tabs stay free.
   */
  claimTab(profile: RelayProfile, threadId: string, tabId: number) {
    const now = this.now();
    const owner = profile.tabOwners.get(tabId);
    if (owner && owner.threadId !== threadId && this.ownerLive(owner))
      throw new BrowserRelayError(
        "tab_in_use",
        `Tab ${tabId} in the Chrome profile "${profile.label}" belongs to another SpecWithCode thread. Open your own tab with chrome_open; threads share the profile, each in its own tabs.`,
      );
    if (owner && owner.threadId === threadId) owner.lastActionAt = now;
    else profile.tabOwners.set(tabId, { threadId, since: now, lastActionAt: now });
  }

  releaseTab(profile: RelayProfile, tabId: number) {
    profile.tabOwners.delete(tabId);
  }

  /** Threads acting in a profile now, most recent first. */
  threadsUsing(profile: RelayProfile): RelayThreadUse[] {
    const byThread = new Map<string, { tabs: number; since: number; lastActionAt: number }>();
    for (const owner of profile.tabOwners.values()) {
      if (!this.ownerLive(owner)) continue;
      const use = byThread.get(owner.threadId);
      if (!use)
        byThread.set(owner.threadId, {
          tabs: 1,
          since: owner.since,
          lastActionAt: owner.lastActionAt,
        });
      else {
        use.tabs += 1;
        use.since = Math.min(use.since, owner.since);
        use.lastActionAt = Math.max(use.lastActionAt, owner.lastActionAt);
      }
    }
    return [...byThread]
      .map(([threadId, use]) => ({ threadId, ...use }))
      .sort((a, b) => b.lastActionAt - a.lastActionAt);
  }

  record(profile: RelayProfile, threadId: string, tool: string, url?: string) {
    this.audit.push({
      at: new Date(this.now()).toISOString(),
      profile: profile.label,
      threadId,
      tool,
      ...(url ? { url: url.slice(0, 300) } : {}),
      ...this.nameOf(threadId),
    });
    if (this.audit.length > MAX_AUDIT) this.audit.splice(0, this.audit.length - MAX_AUDIT);
  }

  /**
   * Settings › Chrome › Stop: let go of the tabs one thread drives, or with no
   * thread, of every tab in the profile. The tabs stay open for the user.
   */
  async stop(profileId: string, threadId?: string) {
    const profile = this.profiles().find((p) => p.id === profileId);
    if (!profile) return;
    const tabs =
      threadId === undefined
        ? [...profile.attachedTabs]
        : [...profile.tabOwners].flatMap(([tabId, owner]) =>
            owner.threadId === threadId ? [tabId] : [],
          );
    if (threadId === undefined) {
      profile.tabOwners.clear();
      profile.lastTabByThread.clear();
    } else {
      for (const tabId of tabs) profile.tabOwners.delete(tabId);
      profile.lastTabByThread.delete(threadId);
    }
    await Promise.allSettled(
      tabs
        .filter((tabId) => profile.attachedTabs.has(tabId))
        .map((tabId) => this.call(profileId, "chrome.debugger.detach", [{ tabId }], 5_000)),
    );
    for (const tabId of tabs) profile.attachedTabs.delete(tabId);
    this.changed();
  }

  /**
   * Let go of every tab held by threads whose key starts with `prefix`, idle
   * or not, in every profile. The tabs stay open for the user.
   */
  async stopThreadsWithPrefix(prefix: string) {
    for (const profile of this.profiles()) {
      const threads = new Set<string>();
      for (const owner of profile.tabOwners.values())
        if (owner.threadId.startsWith(prefix)) threads.add(owner.threadId);
      for (const threadId of profile.lastTabByThread.keys())
        if (threadId.startsWith(prefix)) threads.add(threadId);
      for (const threadId of threads) await this.stop(profile.id, threadId);
    }
  }

  /** Ask every profile to reconnect; their sockets close and come back. */
  requestReconnect() {
    for (const connection of this.connections)
      if (connection.profile) this.send(connection, { method: "reconnect" });
  }

  /** The pairing code changed: drop every profile, which must pair again. */
  disconnectAll(reason: string) {
    for (const connection of [...this.connections]) this.reject(connection, CLOSE_REJECTED, reason);
  }

  /** Resolves once a profile is connected, or after `timeoutMs`. */
  waitForProfiles(timeoutMs: number, minimum = 1): Promise<void> {
    if (this.profiles().length >= minimum) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        if (this.profiles().length < minimum) return;
        cleanup();
      };
      const timer = setTimeout(() => cleanup(), timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.waiters.delete(done);
        resolve();
      };
      this.waiters.add(done);
    });
  }
}

function chromeErrorText(error: unknown): string {
  const text =
    typeof error === "string"
      ? error
      : typeof (error as { message?: unknown })?.message === "string"
        ? (error as { message: string }).message
        : "Chrome reported an error.";
  return text.slice(0, 500);
}
