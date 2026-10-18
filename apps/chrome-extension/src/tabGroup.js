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
 * Modified for SpecWithCode: derived from packages/extension/src/connectedTabGroup.ts
 * in https://github.com/microsoft/playwright. Changes: plain JavaScript, one
 * group per window titled after the paired profile, and no connect page. See NOTICE.
 */

export const GROUP_TITLE_PREFIX = "SpecWithCode";

export function groupTitle(label) {
  return label ? `${GROUP_TITLE_PREFIX} · ${label}` : GROUP_TITLE_PREFIX;
}

const isOurTitle = (title) =>
  title === GROUP_TITLE_PREFIX || (title ?? "").startsWith(`${GROUP_TITLE_PREFIX} · `);

/**
 * Keeps every tab an agent controls in one visible tab group per window, so
 * the user always sees which tabs agents are using. Dragging a tab out of the
 * group hands it back to the user: the agent's debugger detaches from it.
 */
export class AgentTabGroups {
  constructor({ chrome: chromeApi = globalThis.chrome, label, onTabReleased } = {}) {
    this._chrome = chromeApi;
    this._label = label;
    this._onTabReleased = onTabReleased;
    this._tabs = new Set();
    /** Tabs being grouped now; their group may not carry its title yet. */
    this._adding = new Set();
    /** Adds run one at a time, so tabs opened together share one group per window. */
    this._queue = Promise.resolve();
    this._onUpdated = (tabId, changeInfo) => {
      if (!this._tabs.has(tabId) || changeInfo.groupId === undefined) return;
      if (this._adding.has(tabId)) return;
      void this._checkStillGrouped(tabId, changeInfo.groupId);
    };
    this._chrome.tabs.onUpdated.addListener(this._onUpdated);
  }

  dispose() {
    this._chrome.tabs.onUpdated.removeListener(this._onUpdated);
    const tabs = [...this._tabs];
    this._tabs.clear();
    if (tabs.length) Promise.resolve(this._chrome.tabs.ungroup(tabs)).catch(() => {});
  }

  add(tabId) {
    this._tabs.add(tabId);
    this._adding.add(tabId);
    const run = () => this._group(tabId).finally(() => this._adding.delete(tabId));
    const next = this._queue.then(run, run);
    this._queue = next.catch(() => {});
    return next;
  }

  async _group(tabId) {
    try {
      const tab = await this._chrome.tabs.get(tabId);
      const existing = await this._chrome.tabGroups.query({
        windowId: tab.windowId,
        title: groupTitle(this._label),
      });
      const groupId = await this._chrome.tabs.group(
        existing[0]
          ? { tabIds: [tabId], groupId: existing[0].id }
          : { tabIds: [tabId], createProperties: { windowId: tab.windowId } },
      );
      if (!existing[0])
        await this._chrome.tabGroups.update(groupId, {
          title: groupTitle(this._label),
          color: "blue",
        });
    } catch {
      // Tab groups are a courtesy; a tab that cannot be grouped is still controlled.
    }
  }

  remove(tabId) {
    if (!this._tabs.delete(tabId)) return;
    Promise.resolve(this._chrome.tabs.ungroup([tabId])).catch(() => {});
  }

  async _checkStillGrouped(tabId, groupId) {
    if (groupId !== -1) {
      try {
        const group = await this._chrome.tabGroups.get(groupId);
        if (isOurTitle(group.title)) return;
      } catch {
        return;
      }
    }
    this._tabs.delete(tabId);
    this._onTabReleased?.(tabId);
  }
}

/** Ungroup agent groups a previous service worker left behind. */
export async function cleanupStaleGroups(chromeApi = globalThis.chrome) {
  try {
    const groups = await chromeApi.tabGroups.query({});
    const stale = groups.filter((group) => isOurTitle(group.title));
    const tabs = (
      await Promise.all(stale.map((group) => chromeApi.tabs.query({ groupId: group.id })))
    )
      .flat()
      .map((tab) => tab.id)
      .filter((id) => id !== undefined);
    if (tabs.length) await chromeApi.tabs.ungroup(tabs);
  } catch {
    // Nothing to clean.
  }
}
