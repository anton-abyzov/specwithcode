import { describe, expect, it } from "vite-plus/test";

import { feedbackIssueUrl, feedbackOsLabel } from "./feedback";

const context = { version: "1.0.218", platform: "MacIntel", desktop: true, machineCount: 3 };

function params(url: string) {
  const parsed = new URL(url);
  expect(parsed.origin + parsed.pathname).toBe(
    "https://github.com/anton-abyzov/specwithcode/issues/new",
  );
  return Object.fromEntries(parsed.searchParams);
}

describe("feedbackIssueUrl", () => {
  it("prefills the bug form with version and environment only", () => {
    expect(params(feedbackIssueUrl("bug", context))).toEqual({
      template: "bug_report.yml",
      version: "1.0.218",
      environment: "macOS, desktop app, 3 machines",
    });
  });

  it("puts everything in the feature form's combined field", () => {
    expect(params(feedbackIssueUrl("idea", { ...context, machineCount: 1 }))).toEqual({
      template: "feature_request.yml",
      version: "1.0.218, macOS, desktop app, 1 machine",
    });
  });

  it("uses the question form on the web app", () => {
    expect(
      params(feedbackIssueUrl("question", { ...context, platform: "Win32", desktop: false })),
    ).toEqual({
      template: "question.yml",
      version: "1.0.218",
      environment: "Windows, web app, 3 machines",
    });
  });
});

describe("feedbackOsLabel", () => {
  it("reduces the platform to an OS family", () => {
    expect(feedbackOsLabel("darwin")).toBe("macOS");
    expect(feedbackOsLabel("win32")).toBe("Windows");
    expect(feedbackOsLabel("linux")).toBe("Linux");
    expect(feedbackOsLabel("Linux x86_64")).toBe("Linux");
    expect(feedbackOsLabel("")).toBe("Other");
  });
});
