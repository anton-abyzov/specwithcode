import type { ProvisionItem, ProvisionReadback } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  canResumeProvision,
  failProvisionRun,
  IDLE_PROVISION_RUN,
  PROVISION_LOG_LINES,
  reduceProvisionEvent,
  startProvisionRun,
} from "./provisionRunState";

const item = (id: ProvisionItem["id"], status: ProvisionItem["status"]): ProvisionItem => ({
  id,
  label: id,
  wanted: "1",
  found: null,
  status,
  source: "pinned",
  detail: null,
  command: null,
});

const readback = (items: ProvisionItem[], ok: boolean) =>
  ({ items, ok, summary: "s" }) as unknown as ProvisionReadback;

describe("provision run state", () => {
  it("follows the plan, item updates and logs, then the final readback", () => {
    let state = startProvisionRun(IDLE_PROVISION_RUN);
    expect(state.status).toBe("running");
    state = reduceProvisionEvent(state, {
      type: "plan",
      readback: readback([item("git", "ok"), item("gh", "planned")], true),
    });
    state = reduceProvisionEvent(state, { type: "item", item: item("gh", "running") });
    state = reduceProvisionEvent(state, { type: "log", id: "gh", line: "downloading" });
    expect(state.items.map((entry) => entry.status)).toEqual(["ok", "running"]);
    expect(state.logs.gh).toEqual(["downloading"]);
    state = reduceProvisionEvent(state, {
      type: "done",
      readback: readback([item("git", "ok"), item("gh", "changed")], true),
    });
    expect(state.status).toBe("done");
    expect(canResumeProvision(state)).toBe(false);
  });

  it("keeps only the last log lines of a step", () => {
    let state = startProvisionRun(IDLE_PROVISION_RUN);
    for (let index = 0; index < PROVISION_LOG_LINES + 5; index += 1)
      state = reduceProvisionEvent(state, { type: "log", id: "node", line: String(index) });
    expect(state.logs.node).toHaveLength(PROVISION_LOG_LINES);
    expect(state.logs.node?.[0]).toBe("5");
  });

  it("offers Retry after a failed step, a root step or a lost connection", () => {
    const failed = reduceProvisionEvent(startProvisionRun(IDLE_PROVISION_RUN), {
      type: "done",
      readback: readback([item("server", "failed")], false),
    });
    expect(failed.status).toBe("failed");
    expect(canResumeProvision(failed)).toBe(true);
    const lost = failProvisionRun(startProvisionRun(IDLE_PROVISION_RUN), "connection lost");
    expect(canResumeProvision(lost)).toBe(true);
    expect(startProvisionRun(lost).error).toBeNull();
  });
});
