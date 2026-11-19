import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { macAppsRowState, MacAppsRowView } from "./MacAppsRow";

const off = { screenRecording: false, accessibility: false };
const both = { screenRecording: true, accessibility: true };

describe("macAppsRowState", () => {
  it.each([
    ["both allowed", both, null, false, "allowed", null],
    ["neither", off, null, false, "not-allowed", null],
    [
      "Accessibility missing",
      { screenRecording: true, accessibility: false },
      null,
      false,
      "partly",
      "Accessibility",
    ],
    [
      "Screen Recording missing",
      { screenRecording: false, accessibility: true },
      null,
      false,
      "partly",
      "Screen Recording",
    ],
    ["Screen Recording asked for, still off", off, null, true, "needs-reopening", null],
    ["a failed check", both, "Could not check permissions.", false, "could-not-check", null],
  ] as const)("%s", (_name, status, error, screenRecordingRequested, kind, missing) => {
    expect(macAppsRowState({ status, error, screenRecordingRequested })).toEqual({ kind, missing });
  });
});

let renderer: ReactTestRenderer;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});
afterEach(async () => {
  await act(() => renderer?.unmount());
  vi.unstubAllGlobals();
});

const view = async (
  status: { screenRecording: boolean; accessibility: boolean },
  { error = null as string | null, requested = false, open = false } = {},
) => {
  const onOpenChange = vi.fn();
  const onRetry = vi.fn();
  await act(() => {
    renderer = create(
      <MacAppsRowView
        state={macAppsRowState({ status, error, screenRecordingRequested: requested })}
        open={open}
        onOpenChange={onOpenChange}
        onRetry={onRetry}
        checklist={<p>checklist</p>}
      />,
    );
  });
  return { onOpenChange, onRetry };
};
type TextNode = string | { readonly children: readonly TextNode[] };
const textOf = (node: TextNode): string =>
  typeof node === "string" ? node : node.children.map(textOf).join("");
const text = () => JSON.stringify(renderer.toJSON());
const buttons = () =>
  renderer.root.findAll((node) => typeof node.type !== "string" && node.props.onClick);
const button = (label: string) =>
  buttons().find((node) => [node.props.children].flat(2).includes(label))!;
const bodyHidden = () =>
  renderer.root.find(
    (node) => typeof node.type === "string" && node.props["data-slot"] === "access-row-body",
  ).props.hidden;

describe("MacAppsRowView", () => {
  it("allowed shows a chip and no button", async () => {
    await view(both, { open: true });
    expect(text()).toContain("Screen Recording and Accessibility are allowed.");
    expect(buttons()).toHaveLength(0);
    expect(bodyHidden()).toBe(true);
  });

  it("Allow opens the checklist", async () => {
    const { onOpenChange } = await view(off);
    expect(bodyHidden()).toBe(true);
    await act(() => button("Allow").props.onClick());
    expect(onOpenChange).toHaveBeenCalledWith(true);
  });

  it("not allowed says so in words beside Allow, and only then", async () => {
    const chips = () =>
      renderer.root.findAll(
        (node) => typeof node.type === "string" && node.props["data-slot"] === "access-row-chip",
      );
    await view(off);
    expect(chips().map((chip) => textOf(chip))).toEqual([expect.stringContaining("Not allowed")]);
    await act(() => renderer.unmount());
    await view(off, { requested: true });
    expect(chips()).toHaveLength(0);
  });

  it("open, it draws the existing checklist", async () => {
    await view(off, { open: true });
    expect(bodyHidden()).toBe(false);
    expect(text()).toContain("checklist");
  });

  it("partly allowed names the one still off", async () => {
    await view({ screenRecording: true, accessibility: false });
    expect(text()).toContain("Partly allowed: ");
    expect(text()).toContain("Accessibility");
  });

  it("needs reopening says why and offers Reopen", async () => {
    await view(off, { requested: true });
    expect(text()).toContain("Needs reopening");
    expect(button("Reopen")).toBeDefined();
  });

  it("could not check offers Retry", async () => {
    const { onRetry } = await view(off, { error: "Could not check permissions." });
    expect(text()).toContain("Could not check the Mac's permissions.");
    await act(() => button("Retry").props.onClick());
    expect(onRetry).toHaveBeenCalled();
  });
});
