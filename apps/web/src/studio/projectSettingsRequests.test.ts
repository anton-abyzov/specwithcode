import { describe, expect, it } from "vite-plus/test";

import {
  PROJECT_SETTINGS_REQUEST_TTL_MS,
  requestProjectSettings,
  takeProjectSettingsRequest,
} from "./projectSettingsRequests";

describe("project settings requests", () => {
  it("is taken once, by the requested project only", () => {
    requestProjectSettings("host:/a", 1_000);
    expect(takeProjectSettingsRequest("host:/b", 1_000)).toBe(false);
    expect(takeProjectSettingsRequest("host:/a", 1_500)).toBe(true);
    expect(takeProjectSettingsRequest("host:/a", 1_500)).toBe(false);
  });
  it("drops a request the page never took in time", () => {
    requestProjectSettings("host:/a", 0);
    expect(takeProjectSettingsRequest("host:/a", PROJECT_SETTINGS_REQUEST_TTL_MS + 1)).toBe(false);
  });
});
