import type { ThreadPullRequestLink } from "@specweave-studio/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

// A zone west of UTC exposes a clock read as local time (it once ran 4h fast).
process.env.TZ = "America/New_York";
// The real clock's shape: a UTC minute with no zone suffix.
vi.mock("~/hooks/useNowMinute", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/hooks/useNowMinute")>()),
  useNowMinute: () => "2026-10-15T12:00",
}));

import { folderBasename, formatRunDuration, ThreadMetaRow } from "./ThreadMetaRow";

const pr = (number: number, state: "open" | "merged", linkedAt: string) =>
  ({
    host: "github.com",
    repository: "anton-abyzov/specweave",
    number,
    url: `https://github.com/anton-abyzov/specweave/pull/${number}`,
    linkedAt,
    snapshot: { state, isDraft: false, headBranch: `cw/branch-${number}`, title: `PR ${number}` },
  }) as unknown as ThreadPullRequestLink;

const folder = {
  label: "~/Projects/github/specweave-umb/repositories/anton-abyzov/specweave",
  path: "/Users/someone/Projects/github/specweave-umb/repositories/anton-abyzov/specweave",
};

describe("ThreadMetaRow", () => {
  beforeEach(() => vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-15T12:00:00Z")));
  afterEach(() => vi.restoreAllMocks());
  it("labels settled timing as the last turn, not cumulative work", () => {
    const html = renderToStaticMarkup(
      <ThreadMetaRow
        origin={null}
        folder={null}
        run={{ startedAt: "2026-10-15T10:00:00Z", completedAt: "2026-10-15T10:01:30Z" }}
        pullRequests={[]}
        onOpenPullRequest={() => {}}
      />,
    );
    expect(html).toContain("Last turn 1m");
    expect(html).toContain("Timing details");
    expect(html).not.toContain("Ran 1m");
  });
  it("names the machine first, even with nothing else to show", () => {
    const html = renderToStaticMarkup(
      <ThreadMetaRow
        machine={{
          kind: "laptop",
          label: "linuxbox",
          tip: "Runs on linuxbox (Linux). Its commands, files and terminal are on that machine.",
          warning: "Can't reach",
        }}
        origin={null}
        folder={folder}
        run={null}
        pullRequests={[]}
        onOpenPullRequest={() => {}}
      />,
    );
    const chips = [...html.matchAll(/data-thread-meta="([a-z-]+)"/g)].map((match) => match[1]);
    expect(chips).toEqual(["machine", "folder"]);
    expect(html).toContain("linuxbox");
    expect(html).toContain("Can&#x27;t reach");
    expect(
      renderToStaticMarkup(
        <ThreadMetaRow
          machine={{ kind: "server", label: "VPS", tip: "Runs on VPS.", warning: null }}
          origin={null}
          folder={null}
          run={null}
          pullRequests={[]}
          onOpenPullRequest={() => {}}
        />,
      ),
    ).toContain('data-thread-meta="machine"');
  });

  it("paints opaque chips so timeline rows never show through", () => {
    const html = renderToStaticMarkup(
      <ThreadMetaRow
        origin={null}
        folder={folder}
        run={null}
        pullRequests={[pr(2060, "open", "2026-10-15T09:00:00Z")]}
        onOpenPullRequest={() => {}}
      />,
    );
    expect(html).toContain("lane-surface");
    expect(html).not.toMatch(/(?:^|\s)bg-card\/\d+|backdrop-blur/);
  });

  it("is one row: folder, duration, then pull requests; a worker has no origin chip", () => {
    const html = renderToStaticMarkup(
      <ThreadMetaRow
        origin={null}
        folder={folder}
        run={{ startedAt: "2026-10-15T08:05:00.000Z", completedAt: null }}
        pullRequests={[
          pr(2060, "merged", "2026-10-15T09:00:00Z"),
          pr(2062, "merged", "2026-10-15T11:00:00Z"),
          pr(2061, "open", "2026-10-15T10:00:00Z"),
          pr(2059, "merged", "2026-10-15T08:00:00Z"),
        ]}
        onOpenPullRequest={vi.fn()}
      />,
    );
    expect(html.match(/data-thread-meta-row/g)).toHaveLength(1);
    const order = [...html.matchAll(/data-thread-meta="([^"]+)"/g)].map((match) => match[1]);
    expect(order).toEqual(["folder", "duration", "pull-request", "pull-request", "pull-request"]);
    expect(html).not.toContain("Worker");
    expect(html).not.toContain("Subagent of");
    // The folder chip shows its name only; the path waits in the tooltip.
    expect(html).toMatch(/data-thread-meta="folder"[\s\S]*?>specweave</);
    expect(html).not.toContain("repositories/anton-abyzov/specweave<");
    expect(html).toContain("Running · 3h 55m elapsed");
    const numbers = [...html.matchAll(/>#(\d+)</g)].map((match) => match[1]);
    expect(numbers).toEqual(["2062", "2061", "2060"]);
    expect(html).toContain("+1");
    expect(html).not.toContain("Working in folder");
  });

  it("names the parent of a nested subagent and the length of a finished turn", () => {
    const html = renderToStaticMarkup(
      <ThreadMetaRow
        origin={{ kind: "subagent", parentTitle: "Release macOS app", onOpen: vi.fn() }}
        folder={null}
        run={{ startedAt: "2026-10-15T10:00:00.000Z", completedAt: "2026-10-15T10:31:18.000Z" }}
        pullRequests={[]}
        onOpenPullRequest={vi.fn()}
      />,
    );
    expect(html).toContain("Subagent of");
    expect(html).toContain("Release macOS app");
    expect(html).not.toContain("Worker");
    expect(html).toContain("Last turn 31m");
  });

  it("times a running turn from its start in UTC, whatever the local zone", () => {
    const html = renderToStaticMarkup(
      <ThreadMetaRow
        origin={null}
        folder={null}
        run={{ startedAt: "2026-10-15T11:56:10.000Z", completedAt: null }}
        pullRequests={[]}
        onOpenPullRequest={vi.fn()}
      />,
    );
    expect(html).toContain("Running · 3m elapsed");
  });

  it("reads a turn blocked on the person as waiting on you, in the waiting tone", () => {
    const render = (awaitingPerson: "approval" | "answer" | "sign-in" | null) =>
      renderToStaticMarkup(
        <ThreadMetaRow
          origin={null}
          folder={null}
          run={{ startedAt: "2026-10-14T20:50:00.000Z", completedAt: null }}
          awaitingPerson={awaitingPerson}
          pullRequests={[]}
          onOpenPullRequest={vi.fn()}
        />,
      );
    const approval = render("approval");
    expect(approval).toContain("Waiting on you");
    expect(approval).not.toContain("Running");
    expect(approval).toContain('data-run-state="waiting"');
    expect(approval).toContain("text-warning-foreground");
    expect(render("answer")).toContain("Waiting on you");
    expect(render("sign-in")).toContain("Waiting on you");
    // With nothing asked of the person the same turn is still running.
    const running = render(null);
    expect(running).toContain("Running · 15h 10m elapsed");
    expect(running).not.toContain("text-warning-foreground");
  });

  it("keeps a finished turn's length, whatever it last waited on", () => {
    const html = renderToStaticMarkup(
      <ThreadMetaRow
        origin={null}
        folder={null}
        run={{ startedAt: "2026-10-15T10:00:00.000Z", completedAt: "2026-10-15T10:31:18.000Z" }}
        awaitingPerson="approval"
        pullRequests={[]}
        onOpenPullRequest={vi.fn()}
      />,
    );
    expect(html).toContain("Last turn 31m");
    expect(html).not.toContain("Waiting on you");
  });

  it("renders nothing without anything to show", () => {
    const html = renderToStaticMarkup(
      <ThreadMetaRow
        origin={null}
        folder={null}
        run={null}
        pullRequests={[]}
        onOpenPullRequest={vi.fn()}
      />,
    );
    expect(html).toBe("");
  });

  it.each([
    ["/Users/someone/Projects/specweave", "specweave"],
    ["/srv/app/", "app"],
    ["C:\\work\\repo", "repo"],
  ])("names %s by its folder %s", (path, name) => {
    expect(folderBasename(path)).toBe(name);
  });

  it.each([
    [20_000, "<1m"],
    [31 * 60_000 + 18_000, "31m"],
    [235 * 60_000, "3h 55m"],
    [120 * 60_000, "2h"],
    [52 * 3_600_000, "2d 4h"],
  ])("formats %s ms as %s", (ms, label) => {
    expect(formatRunDuration(ms)).toBe(label);
  });
});
