import { DESKTOP_AWAY_BACK_ACTION, DESKTOP_AWAY_START_ACTION } from "@specweave-studio/contracts";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { awayIntentForMenuAction, readAwayRequest, requestAway } from "./awayRequest";

describe("awayRequest", () => {
  afterEach(() => requestAway("away"));

  it("keeps the last intent an entry point asked for", () => {
    requestAway("back");
    expect(readAwayRequest()).toBe("back");
    requestAway("away");
    expect(readAwayRequest()).toBe("away");
  });

  it("maps the desktop menu and tray actions to an intent", () => {
    expect(awayIntentForMenuAction(DESKTOP_AWAY_START_ACTION)).toBe("away");
    expect(awayIntentForMenuAction(DESKTOP_AWAY_BACK_ACTION)).toBe("back");
    expect(awayIntentForMenuAction("open-settings")).toBeNull();
  });
});
