// @vitest-environment jsdom
import { EnvironmentId, ProjectId } from "@specweave-studio/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const navigate = vi.fn(async () => undefined);
vi.mock("@tanstack/react-router", () => ({ useRouter: () => ({ navigate }) }));
const host = EnvironmentId.make("host");
vi.mock("../../../state/entities", () => ({
  useServerConfigs: () => new Map([[host, { scratchWorkspaceRoot: "/home/user/scratch" }]]),
}));

import type { ArtifactNewEntry } from "./ArtifactNewMenu";
import { type DesignEntryProject, useNewDesignEntries } from "./newDesignEntries";

const atlas = ProjectId.make("atlas-web");
let entries: ArtifactNewEntry[] = [];
function Probe(props: {
  project: DesignEntryProject | undefined;
  features?: { slides: boolean; designSystems: boolean };
}) {
  entries = useNewDesignEntries(props.project, props.features);
  return null;
}

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  navigate.mockClear();
  entries = [];
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const render = (props: Parameters<typeof Probe>[0]) =>
  act(async () => root.render(<Probe {...props} />));
const project = (workspaceRoot: string): DesignEntryProject => ({
  environmentId: host,
  id: atlas,
  workspaceRoot,
});

describe("useNewDesignEntries", () => {
  it("offers Design, Slides and Design system for a project on this machine", async () => {
    await render({ project: project("/work/atlas") });
    expect(entries.map((entry) => entry.label)).toEqual(["Design", "Slides", "Design system"]);
  });

  it("opens the Design studio's New dialogs preset to the project, and opens no file", async () => {
    await render({ project: project("/work/atlas") });
    const [design, slides, system] = entries;
    expect(await design!.create()).toBeNull();
    expect(await slides!.create()).toBeNull();
    expect(await system!.create()).toBeNull();
    expect(navigate.mock.calls).toEqual([
      [{ to: "/design", search: { new: "design", owner: atlas } }],
      [{ to: "/design", search: { new: "slides", owner: atlas } }],
      [{ to: "/settings/design-systems", search: { project: atlas } }],
    ]);
  });

  it("offers nothing for a project on another machine or a scratch folder", async () => {
    await render({ project: undefined });
    expect(entries).toEqual([]);
    await render({ project: project("/home/user/scratch") });
    expect(entries).toEqual([]);
  });

  it("leaves out a kind this build has turned off", async () => {
    await render({
      project: project("/work/atlas"),
      features: { slides: false, designSystems: false },
    });
    expect(entries.map((entry) => entry.label)).toEqual(["Design"]);
  });
});
