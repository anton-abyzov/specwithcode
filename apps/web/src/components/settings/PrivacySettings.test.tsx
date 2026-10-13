import { beforeEach, expect, it, vi } from "vite-plus/test";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";
import { visitElements } from "../../test/reactElementTree";

const effects = vi.hoisted(() => [] as (() => void)[]);
const state = vi.hoisted(() => ({
  environment: { environmentId: "host-a", serverConfig: null, connection: { phase: "connected" } },
  allowed: true,
  traceRequest: vi.fn(() => "trace-query"),
}));

vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useState: reactHookHarness.useState,
    useEffect: (effect: () => void) => effects.push(effect),
  };
});
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});
vi.mock("./SettingsScopeContext", () => ({
  useSettingsScope: () => ({ environment: state.environment }),
}));
vi.mock("@specweave-studio/client-runtime/state/usage-access", () => ({
  resolveUsageAccess: () => ({ canReadDiagnostics: state.allowed, error: null }),
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({ data: null, error: null, isPending: false, isSuccess: false }),
}));
vi.mock("../../state/session", () => ({
  environmentSession: { sessionStateAtom: () => "session-query" },
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: { traceDiagnostics: state.traceRequest },
}));
vi.mock("./settingsLayout", () => ({ SettingsPageContainer: "div", SettingsSection: "section" }));
import { DiagnosticsReportPreview, PrivacySettingsPanel } from "./PrivacySettings";
import { Checkbox } from "../ui/checkbox";
import { Button } from "../ui/button";
import type { PrivateDiagnosticsReport } from "./PrivacySettings.logic";

const report: PrivateDiagnosticsReport = {
  format: "specwithcode-private-diagnostics-v1",
  application: { version: "1.0.7", serverVersion: "1.0.7", os: "darwin", architecture: "arm64" },
  observability: {
    productUsageEnabled: false,
    productUsageDestinationConfigured: false,
    localTracingEnabled: true,
    externalTracesConfigured: false,
    externalMetricsConfigured: false,
    externalLogsConfigured: false,
  },
  traces: {
    records: 1,
    parseErrors: 0,
    failures: 0,
    interruptions: 0,
    slowSpans: 0,
    partial: false,
    readError: null,
    failureSampleCategories: {
      authentication: 0,
      "rate-limit": 0,
      "model-unavailable": 0,
      "provider-startup": 0,
      timeout: 0,
      other: 0,
    },
  },
  excluded: [],
};
beforeEach(() => {
  hooks.reset();
  effects.length = 0;
  state.environment.environmentId = "host-a";
  state.allowed = true;
  state.traceRequest.mockClear();
});
it("requires explicit review of the exact preview before saving", () => {
  const download = vi.fn();
  const render = () => {
    hooks.beginRender();
    return DiagnosticsReportPreview({ report, onDownload: download });
  };
  let tree = render();
  let save = visitElements(tree, (node) => node.type === Button)!;
  expect(save.props.disabled).toBe(true);
  (save.props.onClick as () => void)();
  expect(download).not.toHaveBeenCalled();
  expect(visitElements(tree, (node) => node.type === "pre")!.props.children).toBe(
    JSON.stringify(report, null, 2),
  );
  const checkbox = visitElements(tree, (node) => node.type === Checkbox)!;
  (checkbox.props.onCheckedChange as (value: boolean) => void)(true);
  tree = render();
  save = visitElements(tree, (node) => node.type === Button)!;
  expect(save.props.disabled).toBe(false);
  (save.props.onClick as () => void)();
  expect(download).toHaveBeenCalledExactlyOnceWith(report);
});
it("a new preview starts with consent unset", () => {
  hooks.beginRender();
  const tree = DiagnosticsReportPreview({ report });
  expect(visitElements(tree, (node) => node.type === Checkbox)!.props.checked).toBe(false);
  expect(visitElements(tree, (node) => node.type === Button)!.props.disabled).toBe(true);
});

function renderPage(runEffects = false) {
  hooks.beginRender();
  effects.length = 0;
  const tree = PrivacySettingsPanel();
  if (runEffects) for (const effect of effects.splice(0)) effect();
  return tree;
}
function previewButton(tree: ReturnType<typeof renderPage>) {
  return visitElements(
    tree,
    (node) => node.type === Button && node.props.children === "Preview diagnostic report",
  )!;
}
it("does not request trace diagnostics until Preview is clicked", () => {
  let tree = renderPage(true);
  expect(state.traceRequest).not.toHaveBeenCalled();
  expect(visitElements(tree, (node) => node.type === DiagnosticsReportPreview)).toBeNull();
  (previewButton(tree).props.onClick as () => void)();
  tree = renderPage();
  expect(state.traceRequest).toHaveBeenCalledExactlyOnceWith({
    environmentId: "host-a",
    input: {},
  });
  expect(visitElements(tree, (node) => node.type === DiagnosticsReportPreview)).toBeNull();
});
it("clears a pending preview when the environment changes, including switching back", () => {
  let tree = renderPage(true);
  (previewButton(tree).props.onClick as () => void)();
  renderPage();
  expect(state.traceRequest).toHaveBeenCalledTimes(1);
  state.environment.environmentId = "host-b";
  renderPage(true);
  state.environment.environmentId = "host-a";
  renderPage(true);
  expect(state.traceRequest).toHaveBeenCalledTimes(1);
});
it("keeps Preview disabled and makes no diagnostic request without read permission", () => {
  state.allowed = false;
  const tree = renderPage(true);
  expect(previewButton(tree).props.disabled).toBe(true);
  (previewButton(tree).props.onClick as () => void)();
  renderPage();
  expect(state.traceRequest).not.toHaveBeenCalled();
});
