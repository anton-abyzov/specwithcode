// @vitest-environment jsdom

import { EnvironmentId, type AuthEnvironmentScope } from "@specweave-studio/contracts";
import { type ComponentProps, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => null }));
vi.mock("../hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "dark" }) }));
vi.mock("../hooks/useSettings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../hooks/useSettings")>();
  const settings = { ...actual.getClientSettings(), timestampFormat: "24-hour" as const };
  return {
    ...actual,
    useClientSettings: (select?: (value: typeof settings) => unknown) =>
      select ? select(settings) : settings,
  };
});
vi.mock("./ui/tooltip", async () => {
  const { cloneElement, isValidElement } = await import("react");
  return {
    Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
    TooltipTrigger({
      render,
      children,
    }: ComponentProps<typeof import("./ui/tooltip").TooltipTrigger>) {
      if (!isValidElement(render)) return <>{children}</>;
      return children === undefined ? render : cloneElement(render, undefined, children);
    },
    TooltipPopup: () => null,
  };
});
vi.mock("../state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => vi.fn() }));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../state/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../state/session")>();
  const { AuthStandardClientScopes } = await import("@specweave-studio/contracts");
  const grantedScopes = new Set<AuthEnvironmentScope>(AuthStandardClientScopes);
  const hasScope = (environmentId: EnvironmentId | null, scope: AuthEnvironmentScope) =>
    environmentId !== null && grantedScopes.has(scope);
  return {
    ...actual,
    useEnvironmentScope: hasScope,
    readEnvironmentScope: hasScope,
    usePreparedConnection: () => ({ _tag: "Loading" }),
  };
});
vi.mock("../state/entities", () => ({
  readThreadShell: () => null,
  useProjects: () => [],
  useServerConfigs: () => new Map(),
}));
vi.mock("./StudioThreadLink", () => ({
  StudioThreadLink: (props: {
    environmentId: string | null;
    candidates: readonly string[];
    label: string;
  }) => (
    <button
      data-thread-target={props.candidates[0]}
      data-thread-candidates={props.candidates.join(" ")}
      data-environment={props.environmentId ?? ""}
    >
      {props.label}
    </button>
  ),
}));
vi.mock("../remoteOpen", () => ({
  useRemoteOpenResolution: () => ({ state: { mode: "local-exec" }, isResolved: true }),
}));
vi.mock("../editorPreferences", () => ({
  useOpenInPreferredEditor: () => vi.fn(),
  usePreferredEditor: () => [null, vi.fn()],
}));
vi.mock("~/lib/openPullRequestLink", () => ({
  findProjectOnChangeRequestHost: () => undefined,
  parseChangeRequestUrl: () => null,
  resolvePullRequestPreviewTarget: () => null,
  useOpenChangeRequestLink: () => vi.fn(),
}));

import ChatMarkdown from "./ChatMarkdown";
import { markdownTableCopyText } from "./MarkdownTable";
import { serializeRenderedMarkdownFragment } from "../markdown-clipboard";
import { formatDisplayDate } from "../lib/displayDates";

function renderOutput(text: string, formatDates = true) {
  return new DOMParser().parseFromString(
    renderToStaticMarkup(<ChatMarkdown cwd="/tmp/project" text={text} formatDates={formatDates} />),
    "text/html",
  );
}

describe("human-readable structured chat output", () => {
  it("formats dates in prose, lists and aligned table cells without changing their source", () => {
    const value = "2026-10-18T03:58:37.000Z";
    const document = renderOutput(
      `Reset: ${value}.\n\n98. ${value}\n99. **2026-10-13**\n\n| Date | Count |\n| :--- | ---: |\n| ${value} | 12,345 |`,
    );
    expect(document.querySelectorAll("time")).toHaveLength(4);
    expect(document.querySelector("time")?.textContent).toBe(formatDisplayDate(value, "24-hour"));
    expect(document.querySelector("time")?.getAttribute("datetime")).toBe(value);
    expect(document.querySelector("ol")?.getAttribute("start")).toBe("98");
    expect(document.querySelectorAll("li")).toHaveLength(2);
    expect(document.querySelectorAll("td")[1]?.style.textAlign).toBe("right");
    expect([...document.querySelectorAll("th")].every((cell) => cell.scope === "col")).toBe(true);
    const time = document.querySelector("time")!;
    const copied = document.createElement("div");
    copied.append(time.cloneNode(true));
    expect(serializeRenderedMarkdownFragment(copied)).toBe(value);
    const table = document.querySelector("table")!;
    expect(markdownTableCopyText(table, "markdown")).toContain(`| ${value} | 12,345 |`);
    expect(markdownTableCopyText(table, "csv")).toContain(`${value},"12,345"`);
    expect(table.querySelector("time")?.textContent).toBe(formatDisplayDate(value, "24-hour"));
    expect(document.querySelector('[role="region"]')?.getAttribute("aria-label")).toBe(
      "Scrollable data table",
    );
    expect(document.querySelector('[role="region"]')?.getAttribute("tabindex")).toBe("0");
    expect(document.querySelector('[role="region"]')?.getAttribute("data-slot")).toBe(
      "scroll-area-viewport",
    );
  });

  it("preserves an authored row header scope", () => {
    const document = renderOutput(
      '<table><tbody><tr><th scope="row">Date</th><td>Value</td></tr></tbody></table>',
    );
    expect(document.querySelector("th")?.scope).toBe("row");
  });

  it("keeps default user-authored and file-preview text exact", () => {
    const document = renderOutput("The identifier is 2026-10-13.", false);
    expect(document.querySelector("time")).toBeNull();
    expect(document.body.textContent).toContain("The identifier is 2026-10-13.");
  });

  it("preserves link labels, code, HTML, URLs and file paths", () => {
    const document = renderOutput(
      "`2026-10-13` [2026-10-13](https://example.com/2026-10-13)\n\n<span>2026-10-13</span>\n\n/tmp/2026-10-13.csv https://example.com/2026-10-13",
    );
    expect(document.querySelector("time")).toBeNull();
    expect(document.querySelector("code")?.textContent).toBe("2026-10-13");
    expect(document.querySelector("a")?.getAttribute("href")).toBe(
      "https://example.com/2026-10-13",
    );
  });
});
