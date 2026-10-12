import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

interface PressableProps {
  readonly children?: ReactNode;
  readonly accessibilityLabel?: string;
  readonly accessibilityRole?: string;
  readonly accessibilityState?: { readonly busy?: boolean; readonly disabled?: boolean };
  readonly disabled?: boolean;
  readonly onPress?: () => void;
  readonly onLongPress?: () => void;
  readonly onAccessibilityAction?: (event: {
    readonly nativeEvent: { readonly actionName: string };
  }) => void;
  readonly accessibilityHint?: string;
  readonly accessibilityActions?: ReadonlyArray<{ readonly name: string }>;
  readonly className?: string;
}

interface ViewProps {
  readonly children?: ReactNode;
  readonly accessible?: boolean;
  readonly accessibilityLabel?: string;
  readonly className?: string;
}

const mocks = vi.hoisted(() => ({
  pressables: [] as Array<PressableProps>,
  alert: vi.fn(),
  copy: vi.fn(),
}));

vi.mock("react-native", () => ({
  ActivityIndicator: () => <progress data-testid="spinner" />,
  Alert: { alert: mocks.alert },
  Pressable: (props: PressableProps) => {
    mocks.pressables.push(props);
    return (
      <button
        aria-label={props.accessibilityLabel}
        className={props.className}
        disabled={props.disabled}
      >
        {props.children}
      </button>
    );
  },
  View: (props: ViewProps) => (
    <div
      aria-label={props.accessibilityLabel}
      className={props.className}
      data-accessible={props.accessible ? "true" : undefined}
    >
      {props.children}
    </div>
  ),
}));
vi.mock("../../components/AppSymbol", () => ({
  SymbolView: (props: { readonly name: string }) => <i data-symbol={props.name} />,
}));
vi.mock("../../components/AppText", () => ({
  AppText: (props: { readonly className?: string; readonly children?: ReactNode }) => (
    <span className={props.className}>{props.children}</span>
  ),
}));
vi.mock("../../lib/copyTextWithHaptic", () => ({ copyTextWithHaptic: mocks.copy }));

import { BackgroundWorkPillContent, showBackgroundWorkDetails } from "./background-work-pill";
import type { BackgroundFloatingStatus } from "./background-work-status";

const FULL_COMMAND = "ID=$(gh run list -R octo-org/example-api -L 1)";

function commandStatus(
  overrides: Partial<BackgroundFloatingStatus> = {},
): BackgroundFloatingStatus {
  return {
    kind: "background",
    workKind: "command",
    label: "gh run list -R octo-org/example-api -L 1",
    code: true,
    accessibilityLabel: `Running: ${FULL_COMMAND}`,
    details: FULL_COMMAND,
    detailsTitle: "Running in the background",
    stop: { stopping: false, onStop: vi.fn() },
    ...overrides,
  };
}

beforeEach(() => {
  mocks.pressables.length = 0;
  mocks.alert.mockReset();
  mocks.copy.mockReset();
});

describe("BackgroundWorkPillContent", () => {
  it("shows the kind icon and the short command in monospace, with no Running label", () => {
    const html = renderToStaticMarkup(<BackgroundWorkPillContent status={commandStatus()} />);
    expect(html).toContain('data-symbol="terminal"');
    expect(html).toContain(
      '<span class="shrink font-mono text-xs text-foreground">gh run list -R octo-org/example-api -L 1</span>',
    );
    expect(html).not.toContain(">Running");
    // The full command stays reachable for screen readers.
    expect(html).toContain(`aria-label="Running: ${FULL_COMMAND}"`);
  });

  it("shows names and counts in the regular face", () => {
    const html = renderToStaticMarkup(
      <BackgroundWorkPillContent
        status={commandStatus({ workKind: "subagent", label: "Review src/math.ts", code: false })}
      />,
    );
    expect(html).toContain('data-symbol="person.2"');
    expect(html).toContain('class="shrink font-studio-medium text-xs text-foreground"');
  });

  it("stops background work from an icon button", () => {
    const onStop = vi.fn();
    const html = renderToStaticMarkup(
      <BackgroundWorkPillContent status={commandStatus({ stop: { stopping: false, onStop } })} />,
    );
    expect(html).toContain('aria-label="Stop background work"');
    expect(html).toContain('data-symbol="stop.fill"');
    expect(html).not.toContain(">Stop<");
    const button = mocks.pressables.find((props) => props.accessibilityRole === "button");
    expect(button?.disabled).toBe(false);
    button?.onPress?.();
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("shows a spinner and blocks repeat presses while stopping", () => {
    const html = renderToStaticMarkup(
      <BackgroundWorkPillContent
        status={commandStatus({ stop: { stopping: true, onStop: vi.fn() } })}
      />,
    );
    expect(html).toContain('aria-label="Stopping background work"');
    expect(html).toContain('data-testid="spinner"');
    expect(html).not.toContain('data-symbol="stop.fill"');
    const button = mocks.pressables.find((props) => props.accessibilityRole === "button");
    expect(button).toMatchObject({ disabled: true, accessibilityState: { busy: true } });
  });

  it("leaves out the stop button when this device may not operate the thread", () => {
    const html = renderToStaticMarkup(
      <BackgroundWorkPillContent status={commandStatus({ stop: null })} />,
    );
    expect(html).not.toContain("Stop background work");
  });

  it("shows the full command on a long press anywhere on the icon and label", () => {
    const html = renderToStaticMarkup(<BackgroundWorkPillContent status={commandStatus()} />);
    const summary = mocks.pressables.find((props) => props.onLongPress !== undefined);
    // The long-press target is the full-height row holding the icon, not only the text line.
    expect(summary?.className).toContain("h-11");
    expect(html).toMatch(/<button[^>]*class="h-11[^"]*"[^>]*><i data-symbol="terminal">/);
    summary?.onLongPress?.();
    expect(mocks.alert).toHaveBeenCalledWith(
      "Running in the background",
      FULL_COMMAND,
      expect.any(Array),
    );
  });

  it("shows the full command from the screen reader's long press action", () => {
    renderToStaticMarkup(<BackgroundWorkPillContent status={commandStatus()} />);
    const summary = mocks.pressables.find((props) => props.onLongPress !== undefined);
    expect(summary?.accessibilityActions).toEqual([{ name: "longpress", label: "Show all of it" }]);
    summary?.onAccessibilityAction?.({ nativeEvent: { actionName: "activate" } });
    expect(mocks.alert).not.toHaveBeenCalled();
    summary?.onAccessibilityAction?.({ nativeEvent: { actionName: "longpress" } });
    expect(mocks.alert).toHaveBeenCalledWith(
      "Running in the background",
      FULL_COMMAND,
      expect.any(Array),
    );
  });

  it("offers no long press when unnamed work has nothing more to show", () => {
    const html = renderToStaticMarkup(
      <BackgroundWorkPillContent
        status={commandStatus({
          label: "Running a command",
          code: false,
          accessibilityLabel: "Running a command",
          details: null,
        })}
      />,
    );
    expect(mocks.pressables.some((props) => props.onLongPress !== undefined)).toBe(false);
    expect(mocks.pressables.some((props) => props.accessibilityHint !== undefined)).toBe(false);
    expect(html).toContain('<div aria-label="Running a command"');
    expect(html).toContain('data-accessible="true"');
    // The stop button is still there.
    expect(html).toContain('aria-label="Stop background work"');
  });
});

describe("showBackgroundWorkDetails", () => {
  it("offers to copy the full command", () => {
    showBackgroundWorkDetails("Running in the background", FULL_COMMAND);
    const buttons = mocks.alert.mock.calls[0]?.[2] as ReadonlyArray<{
      readonly text: string;
      readonly onPress?: () => void;
    }>;
    expect(buttons.map((button) => button.text)).toEqual(["Copy", "Done"]);
    buttons[0]?.onPress?.();
    expect(mocks.copy).toHaveBeenCalledWith(FULL_COMMAND, { target: "background work" });
  });
});
