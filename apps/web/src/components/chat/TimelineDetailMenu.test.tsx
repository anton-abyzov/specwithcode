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

describe("the header reply and view menu", () => {
  it("names the project's reply style and saves a change to that project", async () => {
    await open({ appearance: "project", threadKey: "host:worker", project });
    expect(trigger().textContent).toBe("Concise");
    expect(trigger().getAttribute("aria-label")).toBe("Agent replies: Concise. Show: Folded steps");
    expect(state.scopes.at(-1)).toBe("atlas-key");
    await act(async () => radio("Detailed")!.click());
    await vi.waitFor(() =>
      expect(state.update).toHaveBeenCalledWith({ responseStyle: "detailed" }),
    );
  });

  it("keeps the view levels under Show with names that differ from the reply style", async () => {
    await open({ threadKey: "host:worker", project });
    const labels = [...document.querySelectorAll('[data-slot="menu-label"]')].map(
      (label) => label.textContent,
    );
    expect(labels).toEqual([
      "Agent replies in this project",
      "Show in this thread",
      "Show in every thread",
    ]);
    expect(radio("Results only")).toBeDefined();
    expect(radio("Everything")).toBeDefined();
    expect(radio("Concise")).toBeDefined();
  });

  it("says Mixed when the project's checkouts disagree", async () => {
    state.mixed = true;
    await open({ project });
    expect(trigger().textContent).toBe("Mixed");
    expect(trigger().dataset.responseStyle).toBe("mixed");
  });

  it("offers the reply style read-only when this connection cannot change settings", async () => {
    state.writable = false;
    await open({ project });
    expect(radio("Detailed")?.getAttribute("aria-disabled")).toBe("true");
    expect(document.body.textContent).toContain("This connection cannot change project settings.");
  });

  it("shows only the view levels without a project", async () => {
    await open({ threadKey: "host:worker", project: null });
    expect(trigger().textContent).toBe("Folded steps");
    expect(trigger().getAttribute("aria-label")).toBe("Show: Folded steps");
    expect(radio("Concise")).toBeUndefined();
    expect(state.scopes).toEqual([]);
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
