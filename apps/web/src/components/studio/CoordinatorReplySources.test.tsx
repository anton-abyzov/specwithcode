// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { CoordinatorReplySources } from "./CoordinatorReplySources";
it("opens the scoped source without toggling its enclosing disclosure", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const open = vi.fn();
  await act(async () =>
    root.render(
      <details>
        <summary>
          Checked{" "}
          <CoordinatorReplySources
            inline
            sources={[
              {
                kind: "thread",
                threadId: "same-id",
                environmentId: "remote",
                title: "Remote worker",
              },
            ]}
            onOpenThread={open}
          />
        </summary>
        Expanded
      </details>,
    ),
  );
  await act(async () => host.querySelector("button")!.click());
  expect(open).toHaveBeenCalledWith("same-id", "remote");
  expect(host.querySelector("details")!.open).toBe(false);
  await act(async () => root.unmount());
  host.remove();
});
it("renders multiple sources and PR-only events", async () => {
  const host = document.createElement("div");
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <CoordinatorReplySources
        sources={[
          {
            kind: "thread",
            threadId: "archived",
            environmentId: "local",
            title: "Archived worker",
          },
          { kind: "pull_request", url: "https://github.com/example/repo/pull/1", title: "PR #1" },
          { kind: "event", title: "Task completed" },
        ]}
        onOpenThread={() => {}}
        resolveTitle={() => "Renamed worker"}
      />,
    ),
  );
  expect(host.querySelectorAll("button")).toHaveLength(1);
  expect(host.querySelector("button")!.textContent).toContain("Renamed worker");
  expect(host.querySelector("a")!.href).toBe("https://github.com/example/repo/pull/1");
  expect(host.textContent).toContain("re: Task completed");
  await act(async () => root.unmount());
});
it("leaves unavailable remote sources explicit and inert", async () => {
  const host = document.createElement("div");
  const root = createRoot(host);
  const open = vi.fn();
  await act(async () =>
    root.render(
      <CoordinatorReplySources
        sources={[
          { kind: "thread", threadId: "same-id", environmentId: "offline", title: "Remote worker" },
        ]}
        onOpenThread={open}
        canOpenThread={() => false}
      />,
    ),
  );
  const button = host.querySelector("button")!;
  expect(button.disabled).toBe(true);
  expect(button.textContent).toContain("unavailable");
  await act(async () => button.click());
  expect(open).not.toHaveBeenCalled();
  await act(async () => root.unmount());
});
