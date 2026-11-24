import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ServerSettings,
  ServerSettingsPatch,
  type PersonalAssistantShared,
} from "@specweave-studio/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { applyServerSettingsPatch, withoutOwnerOnlySettings } from "./serverSettings.ts";

const desktop = EnvironmentId.make("env-desktop");
const turnedOn: PersonalAssistantShared = { enabled: true, machines: [desktop], start: true };

describe("the Percy switch is not a settings patch (1448 AC-15)", () => {
  it("is off by default, with no machines confirmed", () => {
    expect(DEFAULT_SERVER_SETTINGS.personalAssistantShared).toEqual({
      enabled: false,
      machines: [],
    });
    expect(Schema.decodeUnknownSync(ServerSettings)({}).personalAssistantShared).toEqual({
      enabled: false,
      machines: [],
    });
  });

  it("survives a settings file written before and after it existed", () => {
    const stored = Schema.decodeUnknownSync(ServerSettings)({
      aideEnabled: true,
      personalAssistantShared: { enabled: true, machines: ["env-desktop"], name: "Percy" },
    });
    expect(stored.personalAssistantShared).toEqual({
      enabled: true,
      machines: [desktop],
      name: "Percy",
    });
  });

  it("is dropped when the settings update request is decoded", () => {
    const decoded = Schema.decodeUnknownSync(ServerSettingsPatch)({
      aideEnabled: false,
      personalAssistantShared: turnedOn,
    });
    expect(decoded).toEqual({ aideEnabled: false });
    expect(Object.hasOwn(decoded, "personalAssistantShared")).toBe(false);
  });

  it("is ignored by a patch that carries it anyway, whoever built it", () => {
    const smuggled = { aideEnabled: false, personalAssistantShared: turnedOn } as never;
    const next = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, smuggled);
    expect(next.aideEnabled).toBe(false);
    expect(next.personalAssistantShared).toEqual({ enabled: false, machines: [] });
    expect(withoutOwnerOnlySettings(smuggled)).toEqual({ aideEnabled: false });
  });

  it("cannot be turned off by a patch either", () => {
    const on = { ...DEFAULT_SERVER_SETTINGS, personalAssistantShared: turnedOn };
    const next = applyServerSettingsPatch(on, {
      personalAssistantShared: { enabled: false, machines: [] },
    } as never);
    expect(next.personalAssistantShared).toEqual(turnedOn);
  });

  it("keeps at most 32 machines", () => {
    const machines = Array.from({ length: 33 }, (_, index) => `env-${index}`);
    expect(() =>
      Schema.decodeUnknownSync(ServerSettings)({
        personalAssistantShared: { enabled: true, machines },
      }),
    ).toThrow();
  });
});
