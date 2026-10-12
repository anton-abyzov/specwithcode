// @vitest-environment jsdom
import type { ProjectIconOverride } from "@specweave-studio/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("lucide-react/dynamic", async (importOriginal) => ({
  ...(await importOriginal<typeof import("lucide-react/dynamic")>()),
  DynamicIcon: ({ name }: { readonly name: string }) => <span data-icon={name} />,
}));

import { deriveProjectIdentity } from "../../projectIdentity";
import { useLatestIconSave } from "./ProjectIconPicker";
import { ProjectIconPickerPanel } from "./ProjectIconPickerPanel";

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

function render(props: {
  current?: ProjectIconOverride | null;
  customized?: boolean;
  onChooseImage?: () => void;
}) {
  const onSelect = vi.fn();
  const onReset = vi.fn();
  act(() => {
    root.render(
      <ProjectIconPickerPanel
        current={props.current ?? null}
        customized={props.customized ?? false}
        projectName="Atlas Studio"
        onSelect={onSelect}
        onReset={onReset}
        onChooseImage={props.onChooseImage}
      />,
    );
  });
  return { onSelect, onReset };
}

const button = (label: string) => {
  // Compared directly: the selector engine mishandles emoji in attribute values.
  const found = [...container.querySelectorAll("button")].find(
    (element) => element.getAttribute("aria-label") === label,
  );
  if (!found) throw new Error(`No button labelled ${label}`);
  return found;
};
const buttonByText = (text: string) => {
  const found = [...container.querySelectorAll("button")].find(
    (element) => element.textContent?.trim() === text,
  );
  if (!found) throw new Error(`No button reading ${text}`);
  return found;
};
const typeInto = (input: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

describe("ProjectIconPickerPanel", () => {
  it("shows a dense icon grid, two rows of colors and the reset action", () => {
    render({});
    const icons = container.querySelectorAll('[aria-label="Icons"] button');
    expect(icons.length).toBeGreaterThanOrEqual(200);
    expect(container.querySelectorAll('[aria-label="Icon color"] button')).toHaveLength(18);
    expect(buttonByText("Reset icon and color").disabled).toBe(true);
    expect(container.querySelector('input[aria-label="Search icons"]')).not.toBeNull();
  });

  it("saves an icon the moment it is clicked, in the chosen color", () => {
    const { onSelect } = render({});
    act(() => button("Violet").click());
    act(() => button("Rocket").click());
    expect(onSelect).toHaveBeenLastCalledWith({ kind: "lucide", name: "rocket", color: "violet" });
  });

  it("recolors the saved icon from a swatch", () => {
    const { onSelect } = render({
      current: { kind: "lucide", name: "rocket", color: "blue" },
      customized: true,
    });
    expect(button("Rocket").getAttribute("aria-pressed")).toBe("true");
    act(() => button("Emerald").click());
    expect(onSelect).toHaveBeenCalledWith({ kind: "lucide", name: "rocket", color: "emerald" });
  });

  it("recolors the automatic monogram when nothing is chosen yet", () => {
    const { onSelect } = render({});
    act(() => button("Rose").click());
    expect(onSelect).toHaveBeenCalledWith({ kind: "monogram", text: "AS", color: "rose" });
  });

  it("searches every Lucide icon", () => {
    render({});
    typeInto(
      container.querySelector<HTMLInputElement>('input[aria-label="Search icons"]')!,
      "alarm",
    );
    expect(button("Alarm Clock")).toBeTruthy();
    expect(container.querySelector('[data-icon="rocket"]')).toBeNull();
  });

  it("saves emoji, including one pasted into the search box", () => {
    const { onSelect } = render({});
    act(() => buttonByText("Emoji").click());
    act(() => button("Rocket").click());
    expect(onSelect).toHaveBeenLastCalledWith({ kind: "emoji", emoji: "🚀" });
    typeInto(
      container.querySelector<HTMLInputElement>('input[aria-label="Search or paste an emoji"]')!,
      "🦖",
    );
    act(() => button("Use 🦖").click());
    expect(onSelect).toHaveBeenLastCalledWith({ kind: "emoji", emoji: "🦖" });
  });

  it("saves letters on Enter and caps them at two characters", () => {
    const { onSelect } = render({});
    act(() => buttonByText("Letters").click());
    const input = container.querySelector<HTMLInputElement>(
      'input[aria-label="Monogram letters"]',
    )!;
    typeInto(input, "xyz");
    expect(input.value).toBe("XY");
    act(() => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(onSelect).toHaveBeenLastCalledWith({
      kind: "monogram",
      text: "XY",
      color: deriveProjectIdentity("Atlas Studio").color,
    });
  });

  it("resets and opens the image chooser", () => {
    const onChooseImage = vi.fn();
    const { onReset } = render({ customized: true, onChooseImage });
    act(() => buttonByText("Reset icon and color").click());
    expect(onReset).toHaveBeenCalledOnce();
    act(() => buttonByText("Image…").click());
    expect(onChooseImage).toHaveBeenCalledOnce();
  });

  it("leaves the icon alone when untouched letters are tabbed through", () => {
    const { onSelect } = render({
      current: { kind: "lucide", name: "rocket", color: "blue" },
      customized: true,
    });
    act(() => buttonByText("Letters").click());
    const input = container.querySelector<HTMLInputElement>(
      'input[aria-label="Monogram letters"]',
    )!;
    act(() => input.focus());
    act(() => input.blur());
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("keeps the latest color while an earlier pick is still landing", () => {
    const onSelect = vi.fn();
    const draw = (current: ProjectIconOverride) =>
      act(() =>
        root.render(
          <ProjectIconPickerPanel
            current={current}
            customized
            projectName="Atlas Studio"
            onSelect={onSelect}
            onReset={() => {}}
          />,
        ),
      );
    draw({ kind: "lucide", name: "rocket", color: "blue" });
    act(() => button("Red").click());
    act(() => button("Emerald").click());
    // The red save lands while emerald is still queued.
    draw({ kind: "lucide", name: "rocket", color: "red" });
    act(() => button("Bot").click());
    expect(onSelect).toHaveBeenLastCalledWith({ kind: "lucide", name: "bot", color: "emerald" });
    // Once emerald lands, a change from elsewhere moves the controls again.
    draw({ kind: "lucide", name: "bot", color: "emerald" });
    draw({ kind: "lucide", name: "bot", color: "amber" });
    expect(button("Amber").getAttribute("aria-pressed")).toBe("true");
  });

  it("a quick second recolor back to the saved color still saves", () => {
    const onSelect = vi.fn();
    act(() =>
      root.render(
        <ProjectIconPickerPanel
          current={{ kind: "lucide", name: "rocket", color: "red" }}
          customized
          projectName="Atlas Studio"
          onSelect={onSelect}
          onReset={() => {}}
        />,
      ),
    );
    act(() => button("Blue").click());
    // Back to red before the blue save lands: red must be saved, or blue would stick.
    act(() => button("Red").click());
    expect(onSelect.mock.calls.map(([icon]) => icon.color)).toEqual(["blue", "red"]);
  });

  it("a recolor right after an icon pick keeps the new icon", () => {
    const { onSelect } = render({
      current: { kind: "lucide", name: "rocket", color: "blue" },
      customized: true,
    });
    act(() => button("Bot").click());
    act(() => button("Emerald").click());
    expect(onSelect).toHaveBeenLastCalledWith({ kind: "lucide", name: "bot", color: "emerald" });
  });

  it("an earlier recolor landing does not drop a newer icon pick", () => {
    const onSelect = vi.fn();
    const draw = (current: ProjectIconOverride) =>
      act(() =>
        root.render(
          <ProjectIconPickerPanel
            current={current}
            customized
            projectName="Atlas Studio"
            onSelect={onSelect}
            onReset={() => {}}
          />,
        ),
      );
    draw({ kind: "lucide", name: "rocket", color: "red" });
    act(() => button("Blue").click());
    act(() => button("Bot").click());
    // The blue rocket lands while the blue bot is still saving: same color, other icon.
    draw({ kind: "lucide", name: "rocket", color: "blue" });
    act(() => button("Emerald").click());
    expect(onSelect).toHaveBeenLastCalledWith({ kind: "lucide", name: "bot", color: "emerald" });
  });

  it("after a failed save the controls and the next pick start from the saved icon", async () => {
    const onSelect = vi.fn(async (_icon: ProjectIconOverride) => false);
    act(() =>
      root.render(
        <ProjectIconPickerPanel
          current={{ kind: "lucide", name: "rocket", color: "blue" }}
          customized
          projectName="Atlas Studio"
          onSelect={onSelect}
          onReset={() => {}}
        />,
      ),
    );
    act(() => button("Red").click());
    await act(async () => {});
    expect(button("Blue").getAttribute("aria-pressed")).toBe("true");
    act(() => button("Bot").click());
    await act(async () => {});
    act(() => button("Emerald").click());
    expect(onSelect).toHaveBeenLastCalledWith({ kind: "lucide", name: "rocket", color: "emerald" });
  });

  it("keeps letters typed while a recolor is saving when that save lands", () => {
    const onSelect = vi.fn();
    const draw = (current: ProjectIconOverride) =>
      act(() =>
        root.render(
          <ProjectIconPickerPanel
            current={current}
            customized
            projectName="Atlas Studio"
            onSelect={onSelect}
            onReset={() => {}}
          />,
        ),
      );
    draw({ kind: "monogram", text: "AB", color: "red" });
    act(() => buttonByText("Letters").click());
    act(() => button("Blue").click());
    const input = container.querySelector<HTMLInputElement>(
      'input[aria-label="Monogram letters"]',
    )!;
    act(() => input.focus());
    typeInto(input, "cd");
    draw({ kind: "monogram", text: "AB", color: "blue" });
    expect(input.value).toBe("CD");
    act(() => input.blur());
    expect(onSelect).toHaveBeenLastCalledWith({ kind: "monogram", text: "CD", color: "blue" });
  });

  it("after Reset lands the controls show the automatic icon, not the old custom one", async () => {
    const onReset = vi.fn(async () => true);
    const draw = (current: ProjectIconOverride | null, customized: boolean) =>
      act(() =>
        root.render(
          <ProjectIconPickerPanel
            current={current}
            customized={customized}
            projectName="Atlas Studio"
            onSelect={() => {}}
            onReset={onReset}
          />,
        ),
      );
    draw({ kind: "monogram", text: "XY", color: "red" }, true);
    act(() => buttonByText("Letters").click());
    act(() => buttonByText("Reset icon and color").click());
    await act(async () => {});
    draw(null, false);
    const automatic = deriveProjectIdentity("Atlas Studio");
    const input = container.querySelector<HTMLInputElement>(
      'input[aria-label="Monogram letters"]',
    )!;
    expect(input.value).toBe(automatic.monogram);
    const pressed = [...container.querySelectorAll("button[aria-pressed='true']")].map((element) =>
      element.getAttribute("aria-label"),
    );
    expect(pressed).not.toContain("Red");
  });

  it("keeps a color chosen on an emoji when the emoji save lands", () => {
    const onSelect = vi.fn();
    const draw = (current: ProjectIconOverride | null, customized: boolean) =>
      act(() =>
        root.render(
          <ProjectIconPickerPanel
            current={current}
            customized={customized}
            projectName="Atlas Studio"
            onSelect={onSelect}
            onReset={() => {}}
          />,
        ),
      );
    draw(null, false);
    act(() => buttonByText("Emoji").click());
    act(() => button("Rocket").click());
    act(() => buttonByText("Icons").click());
    act(() => button("Violet").click()); // An emoji has no color: nothing is saved yet.
    expect(onSelect).toHaveBeenCalledTimes(1);
    draw({ kind: "emoji", emoji: "🚀" }, true);
    act(() => button("Rocket").click());
    expect(onSelect).toHaveBeenLastCalledWith({ kind: "lucide", name: "rocket", color: "violet" });
  });

  it("keeps an unsent color across a second emoji pick", () => {
    const onSelect = vi.fn();
    const draw = (current: ProjectIconOverride) =>
      act(() =>
        root.render(
          <ProjectIconPickerPanel
            current={current}
            customized
            projectName="Atlas Studio"
            onSelect={onSelect}
            onReset={() => {}}
          />,
        ),
      );
    draw({ kind: "emoji", emoji: "🚀" });
    act(() => buttonByText("Icons").click());
    act(() => button("Violet").click());
    act(() => buttonByText("Emoji").click());
    act(() => button("Robot").click());
    draw({ kind: "emoji", emoji: "🤖" });
    act(() => buttonByText("Icons").click());
    act(() => button("Rocket").click());
    expect(onSelect).toHaveBeenLastCalledWith({ kind: "lucide", name: "rocket", color: "violet" });
  });

  it("persists the last of two quick recolors, never the middle one", async () => {
    // A server that applies saves in order and reports each one back to the panel.
    let persisted: ProjectIconOverride = { kind: "lucide", name: "rocket", color: "red" };
    const writes: string[] = [];
    const releases: Array<() => void> = [];
    let rerender: (() => void) | null = null;
    function Harness() {
      const save = useLatestIconSave(async (icon: ProjectIconOverride) => {
        await new Promise<void>((resolve) => releases.push(resolve));
        persisted = icon;
        writes.push(icon.kind === "emoji" ? icon.emoji : icon.color);
      });
      return (
        <ProjectIconPickerPanel
          current={persisted}
          customized
          projectName="Atlas Studio"
          onSelect={save}
          onReset={() => {}}
        />
      );
    }
    const draw = () => root.render(<Harness />);
    rerender = draw;
    act(draw);
    for (const [first, second] of [
      ["Blue", "Red"],
      ["Emerald", "Amber"],
    ] as const) {
      act(() => button(first).click());
      act(() => button(second).click());
      while (releases.length > 0) {
        await act(async () => releases.shift()!());
        act(rerender);
      }
      expect(persisted).toMatchObject({ name: "rocket", color: second.toLowerCase() });
      expect(button(second).getAttribute("aria-pressed")).toBe("true");
    }
    expect(writes).toEqual(["blue", "red", "emerald", "amber"]);
  });
});
