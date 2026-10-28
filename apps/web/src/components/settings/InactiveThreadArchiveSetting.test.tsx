import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
const state = vi.hoisted(() => ({ days: 30 as number | null, mixed: false, update: vi.fn() }));
vi.mock("./useScopedSettings", () => ({
  useScopedSettings: () => ({ archiveInactiveThreadsAfterDays: state.days }),
  useScopedSettingsMixed: () => state.mixed,
  useUpdateScopedSettings: () => state.update,
}));
vi.mock("./settingsLayout", () => ({
  SettingsRow: ({
    title,
    description,
    control,
    resetAction,
  }: {
    title: string;
    description: string;
    control: ReactNode;
    resetAction: ReactNode;
  }) => (
    <div>
      <h3>{title}</h3>
      <p>{description}</p>
      {control}
      {resetAction}
    </div>
  ),
  SettingResetButton: ({ onClick }: { onClick: () => void }) => (
    <button onClick={onClick}>Reset</button>
  ),
}));
vi.mock("../ui/input", () => ({ Input: (props: object) => <input {...props} /> }));
vi.mock("../ui/select", () => ({
  Select: ({
    children,
    value,
    onValueChange,
  }: {
    children: ReactNode;
    value: string;
    onValueChange: (value: string) => void;
  }) => (
    <select value={value} onChange={(e) => onValueChange(e.target.value)}>
      {children}
    </select>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectPopup: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectItem: ({ children, value }: { children: ReactNode; value: string }) => (
    <option value={value}>{children}</option>
  ),
}));
import { InactiveThreadArchiveSetting } from "./InactiveThreadArchiveSetting";
let view: ReactTestRenderer;
beforeEach(() => {
  state.days = 30;
  state.mixed = false;
  state.update.mockClear();
});
afterEach(async () => {
  await act(async () => view?.unmount());
});
const render = async () => {
  await act(async () => {
    view = create(<InactiveThreadArchiveSetting />);
  });
};
const choose = async (value: string) => {
  await act(async () => view.root.findByType("select").props.onChange({ target: { value } }));
};
it("shows the 30-day default, Never and separate history/worktree policies", async () => {
  await render();
  expect(view.root.findByType("select").props.value).toBe("30");
  expect(view.root.findByType("p").children.join(" ")).toContain(
    "Worktree cleanup is a separate policy",
  );
  await choose("never");
  expect(state.update).toHaveBeenCalledWith({ archiveInactiveThreadsAfterDays: null });
});
it("saves a valid custom duration and rejects invalid days", async () => {
  state.days = 90;
  await render();
  const input = view.root.findByType("input");
  expect(input.props.defaultValue).toBe(90);
  for (const value of ["", "0", "-3", "1.5", "3651"]) {
    await act(async () => input.props.onBlur({ target: { value } }));
  }
  expect(state.update).not.toHaveBeenCalled();
  await act(async () => input.props.onBlur({ target: { value: "45" } }));
  expect(state.update).toHaveBeenCalledWith({ archiveInactiveThreadsAfterDays: 45 });
});
it("offers Custom from Never, preserves mixed state and resets to 30 days", async () => {
  state.days = null;
  state.mixed = true;
  await render();
  expect(view.root.findByType("select").props.value).toBe("mixed");
  await choose("custom");
  expect(state.update).toHaveBeenCalledWith({ archiveInactiveThreadsAfterDays: 30 });
  await act(async () => view.root.findByType("button").props.onClick());
  expect(state.update).toHaveBeenLastCalledWith({ archiveInactiveThreadsAfterDays: 30 });
});
