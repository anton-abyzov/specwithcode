// @vitest-environment jsdom
import type { EnvironmentId, ProjectId } from "@specweave-studio/contracts";
import { act, type PropsWithChildren } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  groups: [] as { projectKey: string; memberProjects: { environmentId: string; id: string }[] }[],
  responseStyle: "concise" as "concise" | "detailed",
  mixed: false,
  writable: true,
  update: vi.fn(),
  scopes: [] as (string | undefined)[],
}));
const client = vi.hoisted(() => ({
  settings: {
    timelineDetail: "normal" as "concise" | "normal" | "verbose",
    threadTimelineDetail: {} as Record<string, "concise" | "normal" | "verbose">,
  },
  persist: vi.fn(),
}));
vi.mock("~/hooks/useSettings", () => ({
  useClientSettings: (select: (settings: typeof client.settings) => unknown) =>
    select(client.settings),
  getClientSettings: () => client.settings,
  persistClientSettingsPatch: async (patch: Partial<typeof client.settings>) => {
    client.persist(patch);
    client.settings = { ...client.settings, ...patch };
  },
}));
vi.mock("../settings/useSettingsProjectGroups", () => ({
  useSettingsProjectGroups: () => state.groups,
}));
vi.mock("../settings/SettingsScopeContext", () => ({
  SettingsScopeProvider: ({
    search,
    children,
  }: PropsWithChildren<{ search: { project?: string | undefined } }>) => {
    state.scopes.push(search.project);
    return children;
  },
}));
vi.mock("../settings/useScopedSettings", () => ({
  useScopedSettings: (select: (settings: { responseStyle: string }) => unknown) =>
    select({ responseStyle: state.responseStyle }),
  useScopedSettingsMixed: () => state.mixed,
  useScopedSettingsWriteAllowed: () => state.writable,
  useUpdateScopedSettings: () => state.update,
}));

import { useCycleTimelineDetail } from "~/timelineDetail";
import { findLogicalProjectKey, TimelineDetailMenu } from "./TimelineDetailMenu";

const project = { environmentId: "host" as EnvironmentId, projectId: "atlas" as ProjectId };
const ATLAS = { projectKey: "atlas-key", memberProjects: [{ environmentId: "host", id: "atlas" }] };

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  state.groups = [ATLAS];
  state.responseStyle = "concise";
  state.mixed = false;
  state.writable = true;
  state.scopes = [];
  state.update.mockClear();
  client.settings = { timelineDetail: "normal", threadTimelineDetail: {} };
  client.persist.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

const trigger = () => container.querySelector<HTMLButtonElement>("[data-timeline-detail]")!;
const radio = (text: string) =>
  [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find((element) =>
    element.textContent?.startsWith(text),
  );
async function open(props: Parameters<typeof TimelineDetailMenu>[0]) {
  await act(async () => root.render(<TimelineDetailMenu {...props} />));
  await act(async () => trigger().click());
}

const checked = () =>
  [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"][aria-checked="true"]')].map(
    (element) => element.textContent,
  );

describe("the header reply and view menu", () => {
  it("names the project's reply style and saves a change to that project", async () => {
    await open({ appearance: "project", threadKey: "host:worker", project });
    expect(trigger().textContent).toBe("Concise · Folded steps");
    expect(trigger().getAttribute("aria-label")).toBe("Agent replies: Concise. Show: Folded steps");
    expect(state.scopes.at(-1)).toBe("atlas-key");
    await act(async () => radio("Detailed")!.click());
    await vi.waitFor(() =>
      expect(state.update).toHaveBeenCalledWith({ responseStyle: "detailed" }),
    );
  });

  it("lists each setting once, with what a Show choice applies to", async () => {
    await open({ threadKey: "host:worker", project });
    const labels = [...document.querySelectorAll('[data-slot="menu-label"]')].map(
      (label) => label.textContent,
    );
    expect(labels).toEqual(["Agent replies in this project", "Conversation shows", "Applies to"]);
    expect(document.querySelectorAll('[role="menuitemradio"]')).toHaveLength(7);
    for (const level of ["Results only", "Folded steps", "Everything"]) {
      expect(radio(level)?.textContent?.length).toBeGreaterThan(level.length);
    }
    expect(checked()).toEqual([
      expect.stringMatching(/^Concise/),
      expect.stringMatching(/^Folded steps/),
      "Every thread",
    ]);
  });

  it("sets the default for every thread while the thread follows it", async () => {
    await open({ threadKey: "host:worker", project });
    await act(async () => radio("Everything")!.click());
    expect(client.persist).toHaveBeenCalledExactlyOnceWith({ timelineDetail: "verbose" });
  });

  it("pins the level on screen to this thread, then changes only that thread", async () => {
    client.settings.timelineDetail = "concise";
    await open({ threadKey: "host:worker", project });
    await act(async () => radio("This thread")!.click());
    expect(client.persist).toHaveBeenLastCalledWith({
      threadTimelineDetail: { "host:worker": "concise" },
    });
    // The menu stays open on a scope change, so the next choice is one more click.
    expect(radio("Everything")).toBeDefined();
    await act(async () => root.render(<TimelineDetailMenu threadKey="host:worker" project={project} />));
    expect(document.body.textContent).toContain("Other threads show Results only.");
    await act(async () => radio("Everything")!.click());
    expect(client.persist).toHaveBeenLastCalledWith({
      threadTimelineDetail: { "host:worker": "verbose" },
    });
    expect(client.settings.timelineDetail).toBe("concise");
  });

  it("drops the thread's own level when the choice applies to every thread again", async () => {
    client.settings.threadTimelineDetail = { "host:worker": "verbose" };
    await open({ threadKey: "host:worker", project });
    expect(trigger().dataset.timelineDetailOwn).toBe("true");
    expect(trigger().getAttribute("aria-label")).toBe(
      "Agent replies: Concise. Show: Everything (this thread)",
    );
    expect(checked()).toContain("This thread");
    await act(async () => radio("Every thread")!.click());
    expect(client.persist).toHaveBeenLastCalledWith({ threadTimelineDetail: {} });
  });

  it("keeps the reply style and view level in the wide chip", async () => {
    state.responseStyle = "detailed";
    await open({ appearance: "project", threadKey: "host:worker", project });
    expect(trigger().textContent).toBe("Detailed · Folded steps");
    expect(trigger().querySelector("svg")).not.toBeNull();
  });

  it("cycles the visible worker without changing the hidden coordinator's default", async () => {
    client.settings.threadTimelineDetail = { "host:worker": "normal" };
    function CycleButton() {
      const cycle = useCycleTimelineDetail();
      return <button data-cycle onClick={cycle}>Cycle</button>;
    }

    await act(async () => {
      root.render(
        <>
          <TimelineDetailMenu active={false} threadKey="host:coordinator" />
          <TimelineDetailMenu threadKey="host:worker" />
          <CycleButton />
        </>,
      );
    });
    await act(async () => container.querySelector<HTMLButtonElement>("[data-cycle]")!.click());
    expect(client.persist).toHaveBeenCalledWith({
      threadTimelineDetail: { "host:worker": "verbose" },
    });
  });

  it("says Mixed when the project's checkouts disagree", async () => {
    state.mixed = true;
    await open({ project });
    expect(trigger().textContent).toBe("Replies mixed · Folded steps");
    expect(trigger().getAttribute("aria-label")).toBe("Agent replies: Mixed. Show: Folded steps");
    expect(trigger().dataset.responseStyle).toBe("mixed");
  });

  it("offers the reply style read-only when this connection cannot change settings", async () => {
    state.writable = false;
    await open({ project });
    expect(radio("Detailed")?.getAttribute("aria-disabled")).toBe("true");
    expect(document.body.textContent).toContain("This connection cannot change project settings.");
  });

  it("shows only the view levels without a project, and no scope without a thread", async () => {
    await open({ threadKey: "host:worker", project: null });
    expect(trigger().textContent).toBe("Folded steps");
    expect(trigger().getAttribute("aria-label")).toBe("Show: Folded steps");
    expect(radio("Concise")).toBeUndefined();
    expect(radio("This thread")).toBeDefined();
    expect(state.scopes).toEqual([]);
    await act(async () => root.render(<TimelineDetailMenu project={null} />));
    expect(radio("This thread")).toBeUndefined();
  });

  it("finds the logical project a checkout belongs to", () => {
    expect(findLogicalProjectKey([ATLAS] as never, project)).toBe("atlas-key");
    expect(
      findLogicalProjectKey([ATLAS] as never, {
        ...project,
        environmentId: "other" as EnvironmentId,
      }),
    ).toBeNull();
  });
});
