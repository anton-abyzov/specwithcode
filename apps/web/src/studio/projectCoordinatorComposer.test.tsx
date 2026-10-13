// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vite-plus/test";
import {
  getProjectCoordinatorComposer,
  useProjectCoordinatorComposer,
} from "./projectCoordinatorComposer";
import {
  enqueueProjectCoordinatorDraft,
  useProjectCoordinatorDraft,
} from "./projectCoordinatorDraft";

let root: Root, container: HTMLElement;
let sequence = 0;
let projectId: string;
function Harness({ environmentId = "m4" }: { environmentId?: string }) {
  const draft = useProjectCoordinatorComposer(environmentId, projectId);
  useProjectCoordinatorDraft(environmentId, projectId, (text) =>
    draft.setPrompt((current) => (current ? `${current}\n\n${text}` : text)),
  );
  return <output>{draft.prompt}</output>;
}
beforeEach(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  projectId = `composer-${++sequence}`;
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
});

it("retains a draft across settings navigation and consumes queued prefill only once", async () => {
  const store = getProjectCoordinatorComposer("m4", projectId);
  store.setPrompt("My original request");
  enqueueProjectCoordinatorDraft({ environmentId: "m4", projectId, text: "Additional context" });
  await act(async () =>
    root.render(
      <StrictMode>
        <Harness />
      </StrictMode>,
    ),
  );
  expect(container.textContent).toBe("My original request\n\nAdditional context");
  await act(async () => root.render(<div>Provider settings</div>));
  await act(async () =>
    root.render(
      <StrictMode>
        <Harness />
      </StrictMode>,
    ),
  );
  expect(container.textContent).toBe("My original request\n\nAdditional context");
});

it("isolates environment and project identities, including delimiter characters", () => {
  const one = getProjectCoordinatorComposer("m4", projectId);
  const two = getProjectCoordinatorComposer("m1", projectId);
  const three = getProjectCoordinatorComposer("m4", `${projectId}-other`);
  one.setPrompt("First");
  two.setPrompt("Second");
  three.setPrompt("Third");
  expect([one, two, three].map((draft) => draft.getSnapshot().prompt)).toEqual([
    "First",
    "Second",
    "Third",
  ]);
  expect(getProjectCoordinatorComposer("m4:project", "other")).not.toBe(
    getProjectCoordinatorComposer("m4", "project:other"),
  );
});

it("clears only an unchanged sent revision, preserving new edits and the same text retyped", () => {
  const store = getProjectCoordinatorComposer("m4", projectId);
  store.setPrompt("Send this");
  const sent = store.getSnapshot().promptRevision;
  store.setPrompt("New request");
  store.clearSentPrompt(sent);
  expect(store.getSnapshot().prompt).toBe("New request");
  store.setPrompt("Send this");
  store.clearSentPrompt(sent);
  expect(store.getSnapshot().prompt).toBe("Send this");
  store.clearSentPrompt(store.getSnapshot().promptRevision);
  expect(store.getSnapshot().prompt).toBe("");
});

it("retains exact attachment bytes, preview URLs and pending preparation between mounts", async () => {
  const store = getProjectCoordinatorComposer("m4", projectId);
  const file = new File(["image"], "screenshot.png", { type: "image/png" });
  const image = {
    type: "image" as const,
    id: "image",
    name: file.name,
    mimeType: file.type,
    sizeBytes: file.size,
    file,
    previewUrl: "blob:retained",
  };
  store.setAttachments([image]);
  store.setPreparing([{ id: "next", name: "next.heic" }]);
  store.setSubmitting(true);
  await act(async () => root.render(<Harness />));
  await act(async () => root.render(<div>Provider settings</div>));
  await act(async () => root.render(<Harness />));
  expect(getProjectCoordinatorComposer("m4", projectId)).toBe(store);
  expect(store.getSnapshot().attachments[0]).toBe(image);
  expect(store.getSnapshot().attachments[0]!.file).toBe(file);
  expect(store.getSnapshot().preparing).toEqual([{ id: "next", name: "next.heic" }]);
  expect(store.getSnapshot().submitting).toBe(true);
});
