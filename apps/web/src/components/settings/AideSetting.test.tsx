import type { ReactNode } from "react";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  aideEnabled: false,
  available: true,
  update: vi.fn(),
}));

vi.mock("~/hooks/useSettings", () => ({
  usePrimarySettings: (selector: (settings: { aideEnabled: boolean }) => unknown) =>
    selector({ aideEnabled: mocks.aideEnabled }),
  usePrimarySettingsAvailable: () => mocks.available,
  useUpdatePrimarySettings: () => mocks.update,
}));
vi.mock("./settingsLayout", () => ({
  SettingsRow: ({ title, control }: { title: ReactNode; control: ReactNode }) => (
    <div>
      <span data-title>{title}</span>
      {control}
    </div>
  ),
}));
vi.mock("./settingsSearch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./settingsSearch")>();
  return { searchableSetting: actual.searchableSetting };
});
vi.mock("../ui/switch", () => ({
  Switch: (props: {
    checked: boolean;
    disabled?: boolean;
    onCheckedChange: (checked: boolean) => void;
    "aria-label": string;
  }) => (
    <button
      type="button"
      role="switch"
      aria-checked={props.checked}
      aria-label={props["aria-label"]}
      disabled={props.disabled}
      onClick={() => props.onCheckedChange(!props.checked)}
    />
  ),
}));

import { AideSetting } from "./AideSetting";

let renderer: ReactTestRenderer;
const render = () => act(() => void (renderer = create(<AideSetting />)));
const toggle = () => renderer.root.findByProps({ role: "switch" });

describe("AideSetting", () => {
  beforeEach(() => {
    mocks.aideEnabled = false;
    mocks.available = true;
    mocks.update.mockReset();
  });

  it("reads off by default and turns Aide on in this machine's server settings", () => {
    render();
    expect(renderer.root.findByProps({ "data-title": true }).children).toEqual([
      "Personal assistant (beta)",
    ]);
    expect(toggle().props["aria-checked"]).toBe(false);
    act(() => toggle().props.onClick());
    expect(mocks.update).toHaveBeenCalledWith({ aideEnabled: true });
  });

  it("turns it back off, and cannot be changed without a server to save it on", () => {
    mocks.aideEnabled = true;
    render();
    act(() => toggle().props.onClick());
    expect(mocks.update).toHaveBeenCalledWith({ aideEnabled: false });
    mocks.available = false;
    render();
    expect(toggle().props.disabled).toBe(true);
  });
});
