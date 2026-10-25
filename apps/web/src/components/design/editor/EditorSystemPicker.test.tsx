// @vitest-environment jsdom
import type {
  DesignReuse,
  DesignSystemId,
  DesignSystemSummary,
  ProjectId,
} from "@specweave-studio/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { systemKey } from "../systems/reviewModel";
import {
  SYSTEM_COPY,
  SYSTEM_FOUND,
  SYSTEM_FRESH,
  SYSTEM_MANAGE,
  SYSTEM_OPEN,
} from "./editorSystem";
import { EditorMoreMenu } from "./EditorMoreMenu";
import {
  EditorSystemPicker,
  useEditorSystem,
  type EditorSystemControl,
  type EditorSystemInput,
} from "./EditorSystemPicker";

const ec = { kind: "project", projectId: "p_ec" as ProjectId } as const;
const reuse: DesignReuse = {
  name: "ec-uikit",
  paths: ["src/styles/entry.css"],
  tokens: 283,
  components: 321,
  modes: ["light", "dark"],
  proposalId: "prop_1",
  foundAt: "2026-10-24T12:00:00.000Z",
};
const imported = {
  ref: { owner: ec, systemId: "s_ec" as DesignSystemId },
  name: "ec-uikit",
  ownerLabel: "EasyChamp UI Kit",
  tokenCount: 283,
  componentCount: 321,
  sources: [],
} as unknown as DesignSystemSummary;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function harness(overrides: Partial<EditorSystemInput>) {
  const input: EditorSystemInput = {
    owner: ec,
    systems: [],
    projects: [{ id: "p_ec" as ProjectId, title: "EasyChamp UI Kit" } as never],
    value: null,
    reuse: null,
    onChange: vi.fn(),
    onCopy: null,
    onOpen: vi.fn(),
    onManage: vi.fn(),
    disabled: false,
    ...overrides,
  };
  let control: EditorSystemControl | null = null;
  function Probe() {
    control = useEditorSystem(input);
    return <EditorSystemPicker control={control} />;
  }
  act(() => root.render(<Probe />));
  return { input, control: () => control! };
}

describe("EditorSystemPicker", () => {
  it("shows the found system in the trigger for a found-system design", () => {
    harness({ reuse });
    const trigger = container.querySelector(
      '[data-testid="design-system-picker"] [role="combobox"]',
    );
    expect(trigger?.textContent).toContain("ec-uikit");
    expect(trigger?.textContent).not.toContain("None");
  });

  it("opens the system page through Open design system", () => {
    const { input, control } = harness({ systems: [imported], value: "s_ec" as DesignSystemId });
    act(() => control().pick(SYSTEM_OPEN));
    expect(input.onOpen).toHaveBeenCalledExactlyOnceWith({ owner: ec, systemId: "s_ec" });
    expect(input.onChange).not.toHaveBeenCalled();
  });

  describe("another project's system", () => {
    const target = { kind: "project", projectId: "p_target" as ProjectId } as const;
    const kitOwner = { kind: "project", environmentId: "m4", projectId: "p_kit" } as const;
    const kit = {
      ref: { owner: kitOwner, systemId: "ec-uikit" as DesignSystemId },
      name: "ec-uikit",
      ownerLabel: "EasyChamp UI Kit",
      revision: 3,
      tokenCount: 283,
      componentCount: 0,
      sources: [],
    } as unknown as DesignSystemSummary;
    const copyOf = (revision: number) =>
      ({
        ref: {
          owner: { ...kitOwner, projectId: "p_target" },
          systemId: "ec-uikit-2" as DesignSystemId,
        },
        name: "ec-uikit 2",
        ownerLabel: "Copy Target",
        revision: 0,
        tokenCount: 283,
        componentCount: 0,
        sources: [],
        copiedFrom: {
          owner: kitOwner,
          id: "ec-uikit",
          revision,
          copiedAt: "2026-10-24T12:00:00.000Z",
        },
      }) as unknown as DesignSystemSummary;
    const setup = (copy: DesignSystemSummary) =>
      harness({
        owner: target,
        projects: [{ id: "p_target" as ProjectId, title: "Copy Target" } as never],
        systems: [kit, copy],
        onCopy: vi.fn(async () => ({
          ok: true as const,
          systemId: "ec-uikit-3" as DesignSystemId,
          name: "ec-uikit 3",
        })),
      });

    it("uses the copy already here instead of writing another", () => {
      const { input, control } = setup(copyOf(3));
      act(() => control().pick(`${SYSTEM_COPY}${systemKey(kit)}`));
      expect(input.onChange).toHaveBeenCalledExactlyOnceWith("ec-uikit-2");
      expect(input.onCopy).not.toHaveBeenCalled();
    });

    it("makes a fresh copy only when asked, once the copy here predates the source", async () => {
      const { input, control } = setup(copyOf(2));
      await act(async () => control().pick(`${SYSTEM_FRESH}${systemKey(kit)}`));
      expect(input.onCopy).toHaveBeenCalledExactlyOnceWith(kit, { fresh: true });
      expect(input.onChange).toHaveBeenCalledExactlyOnceWith("ec-uikit-3");
    });
  });

  it("goes to the system list through Manage design systems", () => {
    const { input, control } = harness({});
    act(() => control().pick(SYSTEM_MANAGE));
    expect(input.onManage).toHaveBeenCalledOnce();
    expect(input.onChange).not.toHaveBeenCalled();
  });

  it("links the imported copy when the found system is picked", () => {
    const { input, control } = harness({ systems: [imported], reuse });
    act(() => control().pick(SYSTEM_FOUND));
    expect(input.onChange).toHaveBeenCalledExactlyOnceWith("s_ec");
  });

  it("changes nothing when the found system is picked before any import", () => {
    const { input, control } = harness({ reuse });
    act(() => control().pick(SYSTEM_FOUND));
    act(() => control().pick(SYSTEM_OPEN));
    expect(input.onChange).not.toHaveBeenCalled();
    expect(input.onOpen).not.toHaveBeenCalled();
  });
});

describe("EditorMoreMenu", () => {
  const control = {
    choices: {
      own: [],
      others: [],
      found: null,
      value: "__none__",
      label: "None",
      open: null,
    },
    target: "Playground",
    copying: null,
    error: null,
    pick: () => undefined,
    disabled: false,
  } satisfies EditorSystemControl;
  const places = [
    { kind: "project", label: "EasyChamp UI Kit", go: () => undefined },
    { kind: "designs", label: "Designs in EasyChamp UI Kit", go: () => undefined },
  ] as const;
  const props = (
    narrow: boolean,
    crumbs: boolean,
    onConnect: (() => void) | null,
    withPlaces = false,
  ) => ({
    narrow,
    crumbs,
    places: withPlaces ? places : [],
    system: control,
    onConnect,
    onHistory: () => undefined,
    exportItems: null,
    onImplement: null,
    implementDisabled: true,
    onPresent: () => undefined,
    onPresenterView: null,
  });
  const itemsOf = async (
    narrow: boolean,
    crumbs: boolean,
    onConnect: (() => void) | null,
    withPlaces = false,
  ) => {
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    act(() => root.render(<EditorMoreMenu {...props(narrow, crumbs, onConnect, withPlaces)} />));
    const trigger = host.querySelector<HTMLElement>('[aria-label="More"]');
    if (trigger !== null) await act(async () => trigger.click());
    const items =
      trigger === null
        ? null
        : [...document.querySelectorAll('[role="menuitem"]')].map((item) =>
            (item.textContent ?? "").trim(),
          );
    act(() => root.unmount());
    host.remove();
    return items;
  };

  it("leaves the header when the header has room for its tools and breadcrumb", () => {
    expect(renderToStaticMarkup(<EditorMoreMenu {...props(false, true, () => undefined)} />)).toBe(
      "",
    );
    expect(renderToStaticMarkup(<EditorMoreMenu {...props(false, false, null)} />)).toBe("");
  });

  it("holds only Connect while the tools fit, so keys never land on a button shown elsewhere", async () => {
    expect(await itemsOf(false, false, () => undefined)).toEqual(["Connect to a project…"]);
  });

  it("holds the tools on a narrow header", async () => {
    expect(await itemsOf(true, false, () => undefined)).toEqual(
      expect.arrayContaining([
        "Connect to a project…",
        "Undo",
        "Redo",
        "Version history",
        "Present",
      ]),
    );
    expect(await itemsOf(true, true, null)).not.toContain("Connect to a project…");
  });

  it("carries a project design's location while the breadcrumb is hidden", async () => {
    expect(await itemsOf(false, false, null, true)).toEqual([
      "EasyChamp UI Kit",
      "Designs in EasyChamp UI Kit",
    ]);
    expect(await itemsOf(true, false, null, true)).toEqual(
      expect.arrayContaining(["EasyChamp UI Kit", "Designs in EasyChamp UI Kit", "Undo"]),
    );
    expect(renderToStaticMarkup(<EditorMoreMenu {...props(false, true, null, true)} />)).toBe("");
  });
});
