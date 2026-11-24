import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { expect, it, vi } from "vite-plus/test";

import type { LimitHopsRow } from "./limitHopGroups";
import { LimitHopsTimelineRow } from "./LimitHopsTimelineRow";

vi.mock("../studio/shell/ModelBadge", () => ({
  useProviderEntries: () =>
    new Map([
      [
        "copilot-work",
        { instanceId: "copilot-work", driverKind: "githubCopilot", displayName: "GitHub Copilot" },
      ],
      ["cursor", { instanceId: "cursor", driverKind: "cursor", displayName: "Cursor" }],
    ]),
}));

const row = (overrides: Partial<LimitHopsRow> = {}): LimitHopsRow => ({
  kind: "limit-hops",
  id: "limit-hops:limit-1",
  createdAt: "2026-11-01T10:00:00.000Z",
  groupId: "limit-hops:limit-1",
  expanded: false,
  hopCount: 14,
  sourceInstanceIds: ["copilot-work", "cursor"],
  runIds: [],
  ...overrides,
});

const render = (props: Parameters<typeof LimitHopsTimelineRow>[0]) => {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(<LimitHopsTimelineRow {...props} />);
  });
  return renderer;
};

it("names each provider once and toggles the group (1460 AC-06)", () => {
  const onToggle = vi.fn();
  const renderer = render({
    row: row(),
    runs: [],
    environmentId: "local",
    onToggle,
    timestamp: null,
  });
  const button = renderer.root.findByType("button");
  const text = button.props["aria-label"] as string;
  expect(text).toBe("Usage limits · switched 14 times between Copilot and Cursor");
  expect(button.props["aria-expanded"]).toBe(false);
  act(() => button.props.onClick());
  expect(onToggle).toHaveBeenCalledOnce();
});

it("names sources from the runs when no switch row does", () => {
  const renderer = render({
    row: row({ sourceInstanceIds: [], runIds: ["run-1", "run-2"], hopCount: 3, expanded: true }),
    runs: [
      { id: "run-1", modelSelection: { instanceId: "cursor", model: "gemini-4-neon" } },
      { id: "run-2", modelSelection: { instanceId: "cursor", model: "gemini-4-neon" } },
    ],
    environmentId: "local",
    onToggle: () => undefined,
    timestamp: null,
  });
  const button = renderer.root.findByType("button");
  expect(button.props["aria-label"]).toBe("Usage limits · 3 stops on Cursor");
  expect(button.props["aria-expanded"]).toBe(true);
});
