/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * Modified for SpecWithCode: derived from packages/extension/src/relayConnection.ts
 * in https://github.com/microsoft/playwright. Changes: plain JavaScript, a
 * pairing handshake, a connection that stays open with no tabs attached, a few
 * more allow-listed tab calls, and agent tabs kept in one tab group. See NOTICE.
 */

/** Allow-listed chrome.* calls the SpecWithCode service may make. Positional params are spread into the call. */
export const ALLOWED_CHROME_COMMANDS = new Set([
  "chrome.debugger.attach",
  "chrome.debugger.detach",
  "chrome.debugger.sendCommand",
  "chrome.tabs.create",
  "chrome.tabs.get",
  "chrome.tabs.query",
  "chrome.tabs.remove",
  "chrome.tabs.update",
]);

/** chrome.* events forwarded to the service, only for tabs it attached to. */
export const CHROME_EVENT_METHODS = [
  "chrome.debugger.onEvent",
  "chrome.debugger.onDetach",
  "chrome.tabs.onCreated",
  "chrome.tabs.onRemoved",
];

/** Pages Chrome never lets an extension debug. */
const NON_DEBUGGABLE_SCHEMES = ["chrome:", "edge:", "devtools:", "chrome-extension:"];

export function isNonDebuggableUrl(url) {
  return typeof url === "string" && NON_DEBUGGABLE_SCHEMES.some((scheme) => url.startsWith(scheme));
}

export class RelayConnection {
  /**
   * @param {WebSocket} ws an open socket that already passed the pairing handshake
   * @param {{ chrome?: any, onTabAttached?: (tabId: number) => void, onTabDetached?: (tabId: number) => void }} [options]
   */
  constructor(ws, options = {}) {
    this._ws = ws;
    this._chrome = options.chrome ?? globalThis.chrome;
    this._attachedTabs = new Set();
    this._eventListeners = [];
    this._closed = false;
    this.onclose = undefined;
    this.ontabattached = options.onTabAttached;
    this.ontabdetached = options.onTabDetached;
    this._installEventForwarders();
    this._ws.addEventListener("message", (event) => this._onMessage(event));
    this._ws.addEventListener("close", () => this._onClose());
  }

  get attachedTabs() {
    return this._attachedTabs;
  }

  get closed() {
    return this._closed;
  }

  close(reason) {
    try {
      this._ws.close(1000, reason);
    } catch {
      // Already closing.
    }
    // The socket's close event is asynchronous; stop forwarding now.
    this._onClose();
  }

  /** Detach one tab on the user's request (the tab left the agents' group). */
  detachTab(tabId) {
    if (this._closed || !this._attachedTabs.has(tabId)) return;
    this._detachDebugger(tabId);
    this._attachedTabs.delete(tabId);
    this.ontabdetached?.(tabId);
    // chrome.debugger.detach does not fire onDetach for the caller.
    this._send({ method: "chrome.debugger.onDetach", params: [{ tabId }, "canceled_by_user"] });
  }

  _installEventForwarders() {
    for (const fullMethod of CHROME_EVENT_METHODS) {
      const target = resolveChromeMember(this._chrome, fullMethod);
      const listener = (...args) => this._onChromeEvent(fullMethod, args);
      target.obj[target.name].addListener(listener);
      this._eventListeners.push(() => target.obj[target.name].removeListener(listener));
    }
  }

  _onClose() {
    if (this._closed) return;
    this._closed = true;
    for (const remove of this._eventListeners) remove();
    this._eventListeners = [];
    for (const tabId of [...this._attachedTabs]) {
      this._detachDebugger(tabId);
      this._attachedTabs.delete(tabId);
      this.ontabdetached?.(tabId);
    }
    this.onclose?.();
  }

  _onChromeEvent(fullMethod, args) {
    const tabId = tabIdForEventArgs(fullMethod, args);
    if (tabId === undefined || !this._attachedTabs.has(tabId)) return;
    this._send({ method: fullMethod, params: args });
    if (fullMethod === "chrome.debugger.onDetach" || fullMethod === "chrome.tabs.onRemoved") {
      this._attachedTabs.delete(tabId);
      this.ontabdetached?.(tabId);
    }
  }

  async _onMessage(event) {
    let message;
    try {
      message = JSON.parse(typeof event.data === "string" ? event.data : "");
    } catch (error) {
      this._send({ error: { code: -32700, message: `Error parsing message: ${error.message}` } });
      return;
    }
    // Notifications from the service (welcome, pong) carry no id.
    if (typeof message?.id !== "number") return;
    const response = { id: message.id };
    try {
      response.result = await this._handleCommand(message);
    } catch (error) {
      response.error = error?.message ?? String(error);
    }
    this._send(response);
  }

  async _handleCommand(message) {
    if (!ALLOWED_CHROME_COMMANDS.has(message.method))
      throw new Error(`Unknown method: ${message.method}`);
    const args = Array.isArray(message.params) ? message.params : [];
    if (message.method === "chrome.debugger.attach") {
      const tab = await this._chrome.tabs.get(args[0]?.tabId);
      if (isNonDebuggableUrl(tab?.url))
        throw new Error("Chrome does not let extensions control this page.");
    }
    const result = await invokeChromeMethod(this._chrome, message.method, args);
    if (message.method === "chrome.debugger.attach") {
      const tabId = args[0]?.tabId;
      if (tabId !== undefined) {
        if (this._closed) this._detachDebugger(tabId);
        else {
          this._attachedTabs.add(tabId);
          this.ontabattached?.(tabId);
        }
      }
    }
    if (message.method === "chrome.debugger.detach") {
      const tabId = args[0]?.tabId;
      if (tabId !== undefined && this._attachedTabs.delete(tabId)) this.ontabdetached?.(tabId);
    }
    return result ?? {};
  }

  _detachDebugger(tabId) {
    Promise.resolve(this._chrome.debugger.detach({ tabId })).catch(() => {});
  }

  _send(message) {
    if (this._ws.readyState === 1) this._ws.send(JSON.stringify(message));
  }
}

/** The tab an event is about, used to forward only events for attached tabs. */
export function tabIdForEventArgs(fullMethod, args) {
  switch (fullMethod) {
    case "chrome.debugger.onEvent":
    case "chrome.debugger.onDetach":
      return args[0]?.tabId;
    case "chrome.tabs.onCreated":
      // Popups opened by an attached tab, reported against their opener.
      return args[0]?.openerTabId;
    case "chrome.tabs.onRemoved":
      return args[0];
  }
  return undefined;
}

function resolveChromeMember(chromeApi, fullMethod) {
  const parts = fullMethod.split(".");
  if (parts[0] !== "chrome" || parts.length < 3)
    throw new Error(`Invalid chrome method: ${fullMethod}`);
  let obj = chromeApi;
  for (let i = 1; i < parts.length - 1; i++) {
    obj = obj?.[parts[i]];
    if (obj === undefined)
      throw new Error(`Unknown chrome path: ${parts.slice(0, i + 1).join(".")}`);
  }
  return { obj, name: parts[parts.length - 1] };
}

async function invokeChromeMethod(chromeApi, fullMethod, args) {
  const { obj, name } = resolveChromeMember(chromeApi, fullMethod);
  const fn = obj[name];
  if (typeof fn !== "function") throw new Error(`Not a function: ${fullMethod}`);
  return await fn.apply(obj, args);
}
