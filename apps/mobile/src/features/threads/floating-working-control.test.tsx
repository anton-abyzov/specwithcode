import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

interface HostProps {
  readonly children?: ReactNode;
  readonly accessible?: boolean;
  readonly accessibilityLabel?: string;
  readonly accessibilityRole?: string;
  readonly className?: string;
  readonly pointerEvents?: string;
  readonly isInteractive?: boolean;
}

// Every native host renders as an element carrying the props these tests read.
function host(tag: "div" | "button" | "span") {
  return function Host(props: HostProps) {
    const Tag = tag;
    return (
      <Tag
        aria-label={props.accessibilityLabel}
        className={props.className}
        data-accessible={props.accessible ? "true" : undefined}
        data-interactive={
          props.isInteractive === undefined ? undefined : String(props.isInteractive)
        }
        data-pointer-events={props.pointerEvents}
        data-role={props.accessibilityRole}
      >
        {props.children}
      </Tag>
    );
  };
}

// A declaration, not a const: the hoisted mocks below run before the module body.
function fade() {
  const animation = {
    duration: () => animation,
    delay: () => animation,
    reduceMotion: () => animation,
  };
  return animation;
}

vi.mock("react-native", () => ({
  ActivityIndicator: () => <progress />,
  Alert: { alert: vi.fn() },
  Pressable: host("button"),
  Text: host("span"),
  View: host("div"),
  useWindowDimensions: () => ({ width: 390, height: 844 }),
}));
vi.mock("react-native-reanimated", () => ({
  default: { View: host("div"), createAnimatedComponent: (component: unknown) => component },
  Easing: { out: () => () => 0, cubic: () => 0 },
  FadeIn: fade(),
  FadeOut: fade(),
  ReduceMotion: { System: "system" },
  useAnimatedStyle: (style: () => unknown) => style(),
  useSharedValue: (value: unknown) => ({ value }),
  withTiming: (value: unknown) => value,
}));
vi.mock("expo-glass-effect", () => ({ GlassContainer: host("div"), GlassView: host("div") }));
vi.mock("uniwind", () => ({ withUniwind: (component: unknown) => component }));
vi.mock("../../native/native-glass", () => ({ NATIVE_LIQUID_GLASS_SUPPORTED: false }));
vi.mock("../../components/AppText", () => ({ AppText: host("span") }));
vi.mock("../../components/AppSymbol", () => ({
  SymbolView: (props: { readonly name: unknown }) => <i data-symbol={String(props.name)} />,
}));
vi.mock("../../components/ControlPill", () => ({ ControlPill: host("button") }));
vi.mock("../../lib/copyTextWithHaptic", () => ({ copyTextWithHaptic: vi.fn() }));
vi.mock("../browser/browser-preview-button", () => ({ BrowserPreviewButton: host("button") }));
vi.mock("../devices/device-preview-button", () => ({ DevicePreviewButton: host("button") }));
vi.mock("./thread-work-log", () => ({ ShimmeringWorkContent: host("span") }));

import type { BackgroundFloatingStatus } from "./background-work-status";
import { FloatingWorkingControl } from "./floating-working-control";
import type { FloatingWorkingStatus } from "./floating-working-status";

const BACKGROUND: BackgroundFloatingStatus = {
  kind: "background",
  workKind: "command",
  label: "gh run watch 123",
  code: true,
  accessibilityLabel: "Running: gh run watch 123",
  details: "gh run watch 123",
  detailsTitle: "Running in the background",
  stop: { stopping: false, onStop: () => {} },
};

function render(status: FloatingWorkingStatus): string {
  return renderToStaticMarkup(
    <FloatingWorkingControl
      colorScheme="light"
      status={status}
      devicePreview={null}
      browserPreview={null}
      showScrollToEnd={false}
      onScrollToEnd={() => {}}
      agents={null}
      onOpenAgents={() => {}}
      queuedCount={0}
      onOpenQueue={() => {}}
    />,
  );
}

const STATUS_HOST = /<div class="(?:absolute )?h-11 items-center justify-center"[^>]*>/g;
const CAPSULE =
  /<div class="h-11 items-center justify-center overflow-hidden rounded-full[^"]*"[^>]*>/;
const ROW = /<div class="h-11 flex-row items-center px-4 gap-2"[^>]*>/;

describe("FloatingWorkingControl with background work", () => {
  it("lets touches reach the stop button and the long press", () => {
    const html = render(BACKGROUND);
    const hosts = html.match(STATUS_HOST) ?? [];
    expect(hosts).toHaveLength(2);
    for (const element of hosts) expect(element).toContain('data-pointer-events="box-none"');
    expect(html.match(CAPSULE)?.[0]).toContain('data-pointer-events="box-none"');
  });

  it("keeps the stop button its own accessibility element", () => {
    const html = render(BACKGROUND);
    const row = html.match(ROW)?.[0];
    expect(row).toBeDefined();
    // A grouped row would fold the stop button into one element screen readers cannot press.
    expect(row).not.toContain("data-accessible");
    expect(html).toContain('aria-label="Stop background work"');
    expect(html).toContain('data-role="button"');
    expect(html).toContain('aria-label="Running: gh run watch 123"');
  });

  it("keeps a plain working timer out of the touch path", () => {
    const html = render({ kind: "working", startedAt: "2026-10-11T00:00:00Z" });
    for (const element of html.match(STATUS_HOST) ?? []) {
      expect(element).toContain('data-pointer-events="none"');
    }
    expect(html.match(CAPSULE)?.[0]).toContain('data-pointer-events="none"');
  });
});
