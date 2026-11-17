import type { MachineReachState } from "@specweave-studio/client-runtime/connection";
import { describe, expect, it } from "vite-plus/test";

import {
  ARCHIVED_HISTORY_FAILED_NAMED,
  ARCHIVED_HISTORY_FAILED_UNNAMED,
  archivedHistoryNotice,
} from "./archivedHistoryNotice";

const LABELS: Record<string, string> = { "m4-env": "M4", "mini-env": "linux-mini" };
const label = (environmentId: string) => LABELS[environmentId] ?? null;
const reach = (entries: Record<string, MachineReachState>) => new Map(Object.entries(entries));

describe("archivedHistoryNotice", () => {
  it("does not show when nothing failed", () => {
    expect(
      archivedHistoryNotice({ failedEnvironmentIds: [], reach: reach({}), label }),
    ).toBeNull();
  });

  it("does not show when every machine that failed is already shown down", () => {
    expect(
      archivedHistoryNotice({
        failedEnvironmentIds: ["mini-env"],
        reach: reach({ "m4-env": "connected", "mini-env": "offline" }),
        label,
      }),
    ).toBeNull();
    // Inside its reconnect grace the machine already says it is reconnecting.
    expect(
      archivedHistoryNotice({
        failedEnvironmentIds: ["mini-env"],
        reach: reach({ "mini-env": "reconnecting" }),
        label,
      }),
    ).toBeNull();
  });

  it("names the connected machine whose history failed, skipping the one shown down", () => {
    expect(
      archivedHistoryNotice({
        failedEnvironmentIds: ["m4-env", "mini-env"],
        reach: reach({ "m4-env": "connected", "mini-env": "cant-reach" }),
        label,
      }),
    ).toEqual({ phrase: ARCHIVED_HISTORY_FAILED_NAMED, params: { machines: "M4" } });
  });

  it("names every machine that failed while connected", () => {
    expect(
      archivedHistoryNotice({
        failedEnvironmentIds: ["m4-env", "mini-env"],
        reach: reach({ "m4-env": "connected", "mini-env": "catching-up" }),
        label,
      }),
    ).toEqual({ phrase: ARCHIVED_HISTORY_FAILED_NAMED, params: { machines: "M4, linux-mini" } });
  });

  it("never prints a raw id for a machine with no name", () => {
    expect(
      archivedHistoryNotice({
        failedEnvironmentIds: ["0f3c-raw-id"],
        reach: reach({ "0f3c-raw-id": "connected" }),
        label,
      }),
    ).toEqual({ phrase: ARCHIVED_HISTORY_FAILED_UNNAMED, params: {} });
    expect(
      archivedHistoryNotice({
        failedEnvironmentIds: ["m4-env", "0f3c-raw-id"],
        reach: reach({ "m4-env": "connected" }),
        label,
      }),
    ).toEqual({
      phrase: ARCHIVED_HISTORY_FAILED_NAMED,
      params: { machines: "M4, another machine" },
    });
  });
});
