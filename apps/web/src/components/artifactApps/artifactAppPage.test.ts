import { describe, expect, it } from "vite-plus/test";

import {
  artifactAppViewState,
  newestArtifactAppPage,
  type ArtifactAppTurnItem,
} from "./artifactAppPage";

function page(
  attachmentId: string,
  title: string,
  options: { status?: string; kind?: "visual"; toolName?: string; isError?: boolean } = {},
): ArtifactAppTurnItem {
  return {
    type: "dynamic_tool",
    status: options.status ?? "completed",
    toolName: options.toolName ?? "mcp__studio-code__html_render",
    output: {
      ...(options.isError ? { isError: true } : {}),
      htmlRender: {
        attachmentId,
        title,
        height: 400,
        ...(options.kind ? { kind: options.kind } : {}),
      },
    },
  };
}

const install = { title: "Morning dashboard", attachmentId: "att-1" };

describe("newestArtifactAppPage", () => {
  it("shows the newest completed page with the install's title", () => {
    const items = [
      page("att-1", "Morning dashboard"),
      { type: "assistant_message", status: "completed" },
      page("att-2", "Other report"),
      page("att-3", "  Morning dashboard "),
    ];
    expect(newestArtifactAppPage(items, install)?.attachmentId).toBe("att-3");
  });

  it("ignores a page still running, a failed call and visuals with the title", () => {
    const items = [
      page("att-1", "Morning dashboard"),
      page("att-2", "Morning dashboard", { status: "inProgress" }),
      page("att-3", "Morning dashboard", { isError: true }),
      page("att-4", "Morning dashboard", { kind: "visual", toolName: "show_visual" }),
    ];
    expect(newestArtifactAppPage(items, install)?.attachmentId).toBe("att-1");
  });

  it("falls back to the installed attachment once the title is gone", () => {
    const items = [page("att-1", "Renamed dashboard"), page("att-2", "Other report")];
    expect(newestArtifactAppPage(items, install)?.attachmentId).toBe("att-1");
  });

  it("prefers a page with the title over the installed attachment", () => {
    const items = [page("att-1", "Renamed dashboard"), page("att-5", "Morning dashboard")];
    expect(newestArtifactAppPage(items, install)?.attachmentId).toBe("att-5");
  });

  it("matches the title exactly, case included", () => {
    expect(newestArtifactAppPage([page("att-9", "morning dashboard")], install)).toBeNull();
  });

  it("finds nothing in a thread without the page", () => {
    expect(newestArtifactAppPage([], install)).toBeNull();
    expect(newestArtifactAppPage([page("att-7", "Other report")], install)).toBeNull();
  });

  it("ignores tools other than page publishing", () => {
    const items = [page("att-1", "Morning dashboard", { toolName: "Read" })];
    expect(newestArtifactAppPage(items, install)).toBeNull();
  });
});

describe("artifactAppViewState", () => {
  const ready = {
    install: { installId: "a".repeat(32) },
    routeInstallId: "a".repeat(32),
    environmentUnreachable: false,
    threadListLoaded: true,
    threadListed: true,
    threadDeleted: false,
    threadStatus: "live" as const,
    pageFound: true,
    olderHistoryPending: false,
    waitedTooLong: false,
  };

  it("shows a found page", () => {
    expect(artifactAppViewState(ready)).toBe("ready");
  });

  it("waits for the shell, then refuses a window without its install", () => {
    expect(artifactAppViewState({ ...ready, install: undefined })).toBe("loading");
    expect(artifactAppViewState({ ...ready, install: null })).toBe("not-installed");
    expect(artifactAppViewState({ ...ready, routeInstallId: "b".repeat(32) })).toBe(
      "not-installed",
    );
  });

  it("says the thread is unavailable when it is deleted or not listed", () => {
    expect(artifactAppViewState({ ...ready, threadDeleted: true })).toBe("thread-unavailable");
    expect(artifactAppViewState({ ...ready, threadStatus: "deleted" })).toBe("thread-unavailable");
    expect(artifactAppViewState({ ...ready, threadListed: false })).toBe("thread-unavailable");
  });

  it("keeps loading while the thread list or the thread is still arriving", () => {
    expect(
      artifactAppViewState({
        ...ready,
        threadListLoaded: false,
        threadListed: false,
        threadStatus: "empty",
        pageFound: false,
      }),
    ).toBe("loading");
    expect(
      artifactAppViewState({ ...ready, threadStatus: "synchronizing", pageFound: false }),
    ).toBe("loading");
  });

  it("calls the page gone only once the live thread, all its history read, lacks it", () => {
    expect(artifactAppViewState({ ...ready, pageFound: false })).toBe("page-missing");
    expect(artifactAppViewState({ ...ready, pageFound: false, olderHistoryPending: true })).toBe(
      "loading",
    );
    expect(artifactAppViewState({ ...ready, threadStatus: "cached", pageFound: false })).toBe(
      "loading",
    );
  });

  it("stops loading for a machine that is down or a wait past its limit", () => {
    const waiting = { ...ready, threadStatus: "empty" as const, pageFound: false };
    expect(artifactAppViewState({ ...waiting, environmentUnreachable: true })).toBe(
      "thread-unavailable",
    );
    expect(artifactAppViewState({ ...waiting, waitedTooLong: true })).toBe("thread-unavailable");
  });

  // The view then says the thread is unavailable until the page's URL can be minted.
  it("keeps a cached page while its machine is down", () => {
    expect(
      artifactAppViewState({ ...ready, threadStatus: "cached", environmentUnreachable: true }),
    ).toBe("ready");
  });
});
