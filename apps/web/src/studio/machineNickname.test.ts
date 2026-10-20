import type { ServerConfig } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  machineNicknamePatch,
  mergeServerNicknames,
  renameMachineLockText,
  resolveMachineNickname,
} from "./machineNickname";

const config = (machineNicknames: Record<string, { name: string; updatedAt: string }>) =>
  ({ settings: { machineNicknames } }) as unknown as ServerConfig;

describe("resolveMachineNickname", () => {
  it("shows the nickname, else the host label without its owner, else the id", () => {
    const nicknames = { "env-m4": { name: "M4", updatedAt: "2026-10-20T21:00:00.000Z" } };
    expect(resolveMachineNickname(nicknames, "env-m4", "Anton's MacBook M4MAX")).toBe("M4");
    expect(resolveMachineNickname(nicknames, "env-mini", "Anton's Mac mini")).toBe("Mac mini");
    expect(resolveMachineNickname(nicknames, "env-mini")).toBe("env-mini");
  });

  it("keeps an owner-like nickname whole and treats a blank one as the default", () => {
    const nicknames = {
      a: { name: "Anton's Mac", updatedAt: "2026-10-20T21:00:00.000Z" },
      b: { name: "  ", updatedAt: "2026-10-20T21:00:00.000Z" },
    };
    expect(resolveMachineNickname(nicknames, "a", "Host A")).toBe("Anton's Mac");
    expect(resolveMachineNickname(nicknames, "b", "Anna's MacBook Air")).toBe("MacBook Air");
  });
});

describe("mergeServerNicknames", () => {
  it("keeps the newest name for each machine across servers", () => {
    const merged = mergeServerNicknames([
      config({
        m4: { name: "Old", updatedAt: "2026-10-20T20:00:00.000Z" },
        mini: { name: "Mini", updatedAt: "2026-10-20T20:00:00.000Z" },
      }),
      config({ m4: { name: "M4", updatedAt: "2026-10-20T21:00:00.000Z" } }),
    ]);
    expect(merged.m4?.name).toBe("M4");
    expect(merged.mini?.name).toBe("Mini");
  });
});

describe("machineNicknamePatch", () => {
  it("clamps the name to 16 characters and stamps it after the previous rename", () => {
    const previous = { m4: { name: "M4", updatedAt: "2026-10-20T21:00:00.000Z" } };
    const patch = machineNicknamePatch(
      previous,
      "m4",
      "  A very long machine name  ",
      Date.parse("2026-10-20T20:00:00.000Z"),
    );
    expect(patch.machineNicknames.m4?.name).toBe("A very long mach");
    expect(patch.machineNicknames.m4!.updatedAt > previous.m4.updatedAt).toBe(true);
  });

  it("restores the default with an empty name", () => {
    const patch = machineNicknamePatch({}, "m4", "", Date.parse("2026-10-20T21:00:00.000Z"));
    expect(patch.machineNicknames.m4).toEqual({ name: "", updatedAt: "2026-10-20T21:00:00.000Z" });
  });
});

it("explains why a rename is unavailable", () => {
  expect(renameMachineLockText("unsupported")).toMatch(/Update SpecWithCode/);
  expect(renameMachineLockText("no-access")).toMatch(/can't change settings/);
  expect(renameMachineLockText(null)).toBeNull();
});
