// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  readSettingsOpener,
  rememberSettingsOpener,
  resolveSettingsReturnTarget,
  restoreSettingsFocus,
} from "./settingsReturnFocus";

function add(html: string): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = html;
  document.body.append(host);
  return host.firstElementChild as HTMLElement;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("settings opener", () => {
  it("keeps the trigger instead of menu items, dialogs and Settings itself", () => {
    const trigger = add(`<button aria-label="Account">A</button>`);
    rememberSettingsOpener(trigger);
    const menu = add(`<div role="menu"><button>Settings</button></div>`);
    rememberSettingsOpener(menu.querySelector("button"));
    const settings = add(`<div data-settings-dialog><input /></div>`);
    rememberSettingsOpener(settings.querySelector("input"));
    rememberSettingsOpener(document.body);
    expect(readSettingsOpener()).toBe(trigger);
  });

  it("finds a remounted opener by id or aria-label", () => {
    const byId = add(`<textarea id="composer"></textarea>`);
    const byLabel = add(`<button aria-label="New chat">+</button>`);
    byId.remove();
    byLabel.remove();
    const newId = add(`<textarea id="composer"></textarea>`);
    const newLabel = add(`<button aria-label="New chat">+</button>`);
    expect(resolveSettingsReturnTarget(byId)).toBe(newId);
    expect(resolveSettingsReturnTarget(byLabel)).toBe(newLabel);
  });

  it("does not return focus into inert content or Settings", () => {
    const inert = add(`<div inert><button aria-label="Hidden">x</button></div>`);
    expect(resolveSettingsReturnTarget(inert.querySelector("button"))).toBeNull();
    const inside = add(`<div data-settings-dialog><button>x</button></div>`);
    expect(resolveSettingsReturnTarget(inside.querySelector("button"))).toBeNull();
    expect(resolveSettingsReturnTarget(null)).toBeNull();
  });

  it("focuses the opener once it is back", async () => {
    const trigger = add(`<button aria-label="Account">A</button>`);
    restoreSettingsFocus(trigger);
    await new Promise((done) => setTimeout(done, 50));
    expect(document.activeElement).toBe(trigger);
  });
});
