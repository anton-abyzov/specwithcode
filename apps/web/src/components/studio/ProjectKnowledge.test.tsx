// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  PROJECT_KNOWLEDGE_INLINE_CHARACTER_LIMIT,
  PROJECT_KNOWLEDGE_INLINE_RETURN_CHARACTER_LIMIT,
  PROJECT_KNOWLEDGE_MAX_BYTES,
  PROJECT_KNOWLEDGE_MAX_DOCUMENTS,
  ProjectId,
  type ProjectKnowledgeSearchHit,
  type ProjectKnowledgeSearchResult,
  type ProjectKnowledgeStatus,
  type ProjectWorkspaceReadResult,
} from "@specweave-studio/contracts";

const state = vi.hoisted(() => ({
  supported: true as boolean | undefined,
  config: true,
  phase: "connected",
  files: "granted",
  status: null as unknown,
  /** When the host's current answer arrived; the first render stamps it with the clock. */
  updatedAt: 0,
  queried: [] as unknown[],
  refresh: vi.fn(),
  canRebuild: true,
  search: vi.fn(),
  reindex: vi.fn(),
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => state.canRebuild }));
vi.mock("../../state/environments", () => ({
  useEnvironment: () => ({
    label: "Mac mini",
    connection: { phase: state.phase },
    serverConfig: state.config
      ? { environment: { capabilities: { projectKnowledge: state.supported } } }
      : null,
  }),
}));
vi.mock("../../state/session", () => ({
  useEnvironmentScopeAccess: (_id: unknown, scope: string) =>
    scope.includes("filesystem") ? state.files : "granted",
}));
vi.mock("../../studio/projectWorkspace", () => ({
  projectWorkspace: {
    knowledge: (target: unknown) => ({ query: target }),
    knowledgeSearch: "search",
    knowledgeReindex: { permissionAtom: () => "reindex-permission" },
  },
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (atom: unknown) => {
    state.queried.push(atom);
    if (atom !== null && state.updatedAt === 0) state.updatedAt = Date.now();
    return {
      data: atom === null ? null : state.status,
      dataUpdatedAt: atom === null ? 0 : state.updatedAt,
      refresh: state.refresh,
      isPending: false,
      error: null,
    };
  },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) => (command === "search" ? state.search : state.reindex),
}));
vi.mock("@specweave-studio/client-runtime/state/runtime", () => ({
  squashAtomCommandFailure: (result: { error: Error }) => result.error,
}));

import { ProjectKnowledge } from "./ProjectKnowledge";

const status = (patch: Partial<ProjectKnowledgeStatus> = {}): ProjectKnowledgeStatus => ({
  projectId: ProjectId.make("project"),
  mode: "inline",
  state: "ready",
  documents: 42,
  characters: 120_000,
  inlineCharacters: 8_000,
  inlineLimit: PROJECT_KNOWLEDGE_INLINE_CHARACTER_LIMIT,
  inlineReturnLimit: PROJECT_KNOWLEDGE_INLINE_RETURN_CHARACTER_LIMIT,
  bytes: 130_000,
  capacityBytes: PROJECT_KNOWLEDGE_MAX_BYTES,
  capacityDocuments: PROJECT_KNOWLEDGE_MAX_DOCUMENTS,
  sources: [
    { kind: "memory", label: "Project memory", documents: 2, characters: 6_000 },
    { kind: "library", label: "Increments", documents: 40, characters: 114_000 },
  ],
  skipped: { tooLarge: 1, overCapacity: 0, unreadable: 0 },
  indexedAt: new Date().toISOString(),
  problem: null,
  ...patch,
});
const memory = (revision: number): ProjectWorkspaceReadResult["memory"] =>
  ({
    files: [{ name: "MEMORY.md", revision, byteLength: 10, updatedAt: "2026-10-20T00:00:00Z" }],
    totalBytes: 10,
  }) as unknown as ProjectWorkspaceReadResult["memory"];

let root: Root, container: HTMLDivElement;
beforeEach(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  Object.assign(state, {
    supported: true,
    config: true,
    phase: "connected",
    files: "granted",
    status: status(),
    updatedAt: 0,
    queried: [],
    canRebuild: true,
  });
  state.refresh.mockReset();
  state.search.mockReset();
  state.reindex.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
});
async function render(revision = 1) {
  await act(async () =>
    root.render(
      <ProjectKnowledge
        environmentId={EnvironmentId.make("host")}
        projectId={ProjectId.make("project")}
        memory={memory(revision)}
      />,
    ),
  );
}
/** The host answers the card's last question now, stamped with the (fake) clock. */
async function answer(next: ProjectKnowledgeStatus) {
  state.status = next;
  state.updatedAt = Date.now();
  await render(1);
}
const button = (name: string) =>
  [...container.querySelectorAll("button")].find((b) => b.textContent === name)!;
/** The line beside the mode's title: when the index was built, or that it is building. */
const stateLine = () =>
  container.querySelector(".project-knowledge-mode [role='status']")?.textContent;
/** The visually hidden line a screen reader hears about searches. */
const announced = () => container.querySelector(".sr-only[role='status']");
async function searchFor(query: string) {
  const input = container.querySelector<HTMLInputElement>("input[type='search']")!;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, query);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => button("Search").click());
}
const hit = (n: number): ProjectKnowledgeSearchHit => ({
  documentId: `file:docs/note-${n}.md`,
  title: `Note ${n}`,
  location: `docs/note-${n}.md`,
  kind: "library",
  heading: "",
  excerpt: `Passage ${n} about the storage decision.`,
  offset: 0,
  modifiedAt: "2026-10-12T12:00:00.000Z",
  score: 1,
});
const searched = (patch: Partial<ProjectKnowledgeSearchResult>) => ({
  _tag: "Success",
  value: {
    projectId: ProjectId.make("project"),
    mode: "search",
    state: "ready",
    truncated: false,
    results: [],
    ...patch,
  } satisfies ProjectKnowledgeSearchResult,
});

describe("Project knowledge card", () => {
  it("shows the mode, how full the index is, each source and what was left out", async () => {
    await render();
    expect(container.querySelector("h2")?.textContent).toBe("Project knowledge");
    expect(container.textContent).toContain("Memory sent in full");
    expect(container.textContent).toContain("Indexed just now.");
    expect(container.querySelector("[role='meter']")?.getAttribute("aria-valuenow")).toBe("0");
    expect(container.textContent).toContain("42 documents, about 40K tokens.");
    const sources = [...container.querySelectorAll("ul[aria-label='Knowledge sources'] li")];
    expect(sources.map((row) => row.textContent)).toEqual([
      "Project memory2 documents · about 2K tokens",
      "Increments40 documents · about 38K tokens",
    ]);
    expect(container.textContent).toContain("1 file left out: 1 over 2 MB.");
    expect(container.textContent).toContain("about 2.7K tokens of the 8K threads receive in full");
  });

  it("fills the bar by the host's size and document limits, not by extracted text", async () => {
    state.status = status({
      documents: 42,
      capacityDocuments: 50,
      characters: 900_000_000,
      bytes: 10,
    });
    await render();
    const meter = container.querySelector("[role='meter']")!;
    expect(meter.getAttribute("aria-valuenow")).toBe("84");
    expect(meter.getAttribute("data-tone")).toBe("warn");
    expect(container.textContent).toContain("The index is 84% full.");
  });

  it("names a first build that failed, says why once, and never says Indexed", async () => {
    const problem =
      "The knowledge index could not be updated. Rebuild it, or check that the project folder is readable.";
    state.status = status({
      mode: "empty",
      state: "failed",
      documents: 0,
      characters: 0,
      inlineCharacters: 0,
      bytes: 0,
      sources: [],
      skipped: { tooLarge: 0, overCapacity: 0, unreadable: 0 },
      indexedAt: null,
      problem,
    });
    await render();
    expect(container.querySelector(".project-knowledge-mode strong")?.textContent).toBe(
      "Index not built",
    );
    expect(container.textContent).not.toContain("Nothing to index yet");
    expect(stateLine()).toBe(`Not indexed yet. ${problem}`);
    expect(container.textContent).not.toContain("Indexed");
    expect(container.textContent!.split(problem)).toHaveLength(2);
  });

  it("asks for an update on an older host instead of querying it", async () => {
    state.supported = undefined;
    await render();
    expect(container.textContent).toContain(
      "Update SpecWithCode on Mac mini to see this project's knowledge.",
    );
    expect(state.queried.every((atom) => atom === null)).toBe(true);
    expect(container.querySelector("button")).toBeNull();
  });

  it("says nothing until the host's config arrives", async () => {
    state.config = false;
    await render();
    expect(container.textContent).not.toContain("Update SpecWithCode");
    expect(container.querySelector("[role='status']")).toBeNull();
    expect(state.queried.every((atom) => atom === null)).toBe(true);
  });

  it("says a missing file permission is the problem, without querying", async () => {
    state.files = "denied";
    await render();
    expect(container.textContent).toContain("needs permission to read files on that machine");
    expect(state.queried.every((atom) => atom === null)).toBe(true);
  });

  it("searches as a thread would and lists each passage with its place and date", async () => {
    state.search.mockResolvedValue({
      _tag: "Success",
      value: {
        projectId: "project",
        mode: "inline",
        state: "ready",
        truncated: true,
        results: [
          {
            documentId: "file:.specweave/increments/0927/spec.md",
            title: "Project knowledge",
            location: ".specweave/increments/0927/spec.md",
            kind: "library",
            heading: "Approach > Storage",
            excerpt: "One SQLite file per project with FTS5.",
            offset: 120,
            modifiedAt: "2026-10-12T12:00:00.000Z",
            score: 3,
          },
        ],
      },
    });
    await render();
    const input = container.querySelector<HTMLInputElement>("input[type='search']")!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "  storage decision ");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      container
        .querySelector("form[role='search']")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(state.search).toHaveBeenCalledWith({
      environmentId: "host",
      input: { projectId: "project", query: "storage decision" },
    });
    const result = container.querySelector("ol[aria-label='Search results'] li")!;
    expect(result.textContent).toContain("Project knowledge");
    expect(result.textContent).toContain(".specweave/increments/0927/spec.md · Approach > Storage");
    expect(result.textContent).toContain("One SQLite file per project with FTS5.");
    expect(result.textContent).toMatch(/2026/);
    expect(container.textContent).toContain("More passages matched.");
  });

  it("says when nothing matches, without claiming more passages", async () => {
    state.search.mockResolvedValue({
      _tag: "Success",
      value: { projectId: "project", mode: "inline", state: "ready", truncated: true, results: [] },
    });
    await render();
    await searchFor("nothing here");
    expect(container.textContent).toContain("Nothing in this project's knowledge matches.");
    expect(container.textContent).not.toContain("More passages matched.");
  });

  it("does not call a search of an index still being built definitive", async () => {
    const caveat = "The index is still being built, so results may be incomplete.";
    state.search.mockResolvedValue(searched({ state: "indexing" }));
    await render();
    await searchFor("storage decision");
    const results = container.querySelector(".project-knowledge-results")!;
    expect(results.textContent).toBe(`Nothing indexed so far matches. ${caveat}`);
    expect(container.textContent).not.toContain("Nothing in this project's knowledge matches.");
    state.search.mockResolvedValue(searched({ state: "indexing", results: [hit(1)] }));
    await searchFor("storage");
    expect(container.querySelector(".project-knowledge-results > p")?.textContent).toBe(caveat);
    expect(container.querySelectorAll("ol[aria-label='Search results'] li")).toHaveLength(1);
    state.search.mockResolvedValue(searched({ results: [hit(1)] }));
    await searchFor("storage");
    expect(container.textContent).not.toContain("may be incomplete");
  });

  it("announces each search in a short line, from a live region present before the first", async () => {
    await render();
    const live = announced();
    expect(live?.textContent).toBe("");
    let reply: (value: unknown) => void = () => {};
    state.search.mockImplementation(() => new Promise((resolve) => (reply = resolve)));
    await searchFor("storage decision");
    expect(live?.textContent).toBe("Searching…");
    await act(async () => reply(searched({ results: [hit(1), hit(2), hit(3)] })));
    expect(live?.textContent).toBe("3 passages found.");
    // The passages are not read out: the results are not a live region of their own.
    expect(container.querySelector(".project-knowledge-results")?.hasAttribute("aria-live")).toBe(
      false,
    );
    expect(container.querySelectorAll("[aria-live]")).toHaveLength(0);
    state.search.mockResolvedValue(searched({}));
    await searchFor("nothing here");
    expect(live?.textContent).toBe("Nothing matches.");
    state.search.mockResolvedValue(searched({ state: "indexing", results: [hit(1)] }));
    await searchFor("storage");
    expect(live?.textContent).toBe(
      "1 passage found. The index is still being built, so results may be incomplete.",
    );
    // The same element throughout, so screen readers keep listening to it.
    expect(announced()).toBe(live);
  });

  it("shows a failed search inline, without the passages of the one before", async () => {
    state.search.mockResolvedValue(searched({ results: [hit(1)] }));
    await render();
    await searchFor("storage");
    expect(container.querySelectorAll("ol[aria-label='Search results'] li")).toHaveLength(1);
    state.search.mockResolvedValue({ _tag: "Failure", error: new Error("Search is busy.") });
    await searchFor("anything");
    expect(container.querySelector("[role='alert']")?.textContent).toBe("Search is busy.");
    expect(container.querySelector("ol[aria-label='Search results']")).toBeNull();
    expect(announced()?.textContent).toBe("");
  });

  it("shows the rebuild at once and keeps Rebuild index off until the host answers again", async () => {
    vi.useFakeTimers();
    state.reindex.mockResolvedValue({ _tag: "Success", value: status({ state: "indexing" }) });
    await render();
    expect(stateLine()).toBe("Indexed just now.");
    // Two clicks before the card re-renders start one rebuild.
    await act(async () => {
      button("Rebuild index").click();
      button("Rebuild index").click();
    });
    expect(state.reindex).toHaveBeenCalledTimes(1);
    expect(state.reindex).toHaveBeenCalledWith({
      environmentId: "host",
      input: { projectId: "project" },
    });
    // The status the rebuild returned shows at once; the host has not answered since.
    expect(stateLine()).toBe("Indexing…");
    expect(button("Rebuild index").disabled).toBe(true);
    await render(1);
    expect(stateLine()).toBe("Indexing…");
    await act(async () => button("Rebuild index").click());
    expect(state.reindex).toHaveBeenCalledTimes(1);
    // The card asks again 1.5 s after the rebuild's answer.
    await act(async () => vi.advanceTimersByTime(1_499));
    expect(state.refresh).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTime(1));
    expect(state.refresh).toHaveBeenCalledTimes(1);
    // The host says it is still building: the button stays off.
    await answer(status({ state: "indexing" }));
    expect(stateLine()).toBe("Indexing…");
    expect(button("Rebuild index").disabled).toBe(true);
    // Built: the new index shows, and the button can start another rebuild.
    await answer(status());
    expect(stateLine()).toBe("Indexed just now.");
    expect(button("Rebuild index").disabled).toBe(false);
    await act(async () => button("Rebuild index").click());
    expect(state.reindex).toHaveBeenCalledTimes(2);
  });

  it("keeps the old status when a rebuild fails, and says so", async () => {
    state.reindex.mockResolvedValue({ _tag: "Failure", error: new Error("The host is busy.") });
    await render();
    await act(async () => button("Rebuild index").click());
    expect(container.querySelector("[role='alert']")?.textContent).toBe("The host is busy.");
    expect(stateLine()).toBe("Indexed just now.");
    expect(button("Rebuild index").disabled).toBe(false);
  });

  it("disables Rebuild index without permission to run work", async () => {
    state.canRebuild = false;
    await render();
    expect(button("Rebuild index").disabled).toBe(true);
    expect(container.textContent).toContain(
      "Rebuilding the index needs permission to run work on Mac mini.",
    );
  });

  it("asks again 1.5 s after each answer while the index builds, never while one is pending", async () => {
    vi.useFakeTimers();
    state.status = status({ state: "indexing" });
    await render();
    expect(stateLine()).toBe("Indexing…");
    await act(async () => vi.advanceTimersByTime(1_499));
    expect(state.refresh).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTime(1));
    expect(state.refresh).toHaveBeenCalledTimes(1);
    // That question is not answered yet, so nothing more is asked.
    await act(async () => vi.advanceTimersByTime(5_000));
    expect(state.refresh).toHaveBeenCalledTimes(1);
    // Still building: the next question follows 1.5 s after this answer.
    await answer(status({ state: "indexing" }));
    await act(async () => vi.advanceTimersByTime(1_499));
    expect(state.refresh).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTime(1));
    expect(state.refresh).toHaveBeenCalledTimes(2);
    // Built: the card stops asking.
    await answer(status());
    await act(async () => vi.advanceTimersByTime(5_000));
    expect(state.refresh).toHaveBeenCalledTimes(2);
  });

  it("asks again once a saved memory file lands", async () => {
    await render(1);
    await render(1);
    expect(state.refresh).not.toHaveBeenCalled();
    await render(2);
    expect(state.refresh).toHaveBeenCalledTimes(1);
  });
});
