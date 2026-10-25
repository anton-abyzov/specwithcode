// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vite-plus/test";

import {
  QUESTION_SETTLED_ELSEWHERE,
  QuestionLiveStatus,
  useLiveAnnouncement,
  useQuestionSettleAnnouncements,
} from "./questionLiveStatus";

let root: Root, container: HTMLDivElement;
let settle: ReturnType<typeof useQuestionSettleAnnouncements>;
let announce: (text: string) => void;
function Probe(props: { scope: string | null; pending: ReadonlyArray<string> }) {
  const [announcement, announceText] = useLiveAnnouncement();
  announce = announceText;
  settle = useQuestionSettleAnnouncements(props.scope, props.pending, announceText);
  return <QuestionLiveStatus announcement={announcement} />;
}
const render = (scope: string | null, pending: ReadonlyArray<string>) =>
  act(async () => root.render(<Probe scope={scope} pending={pending} />));
const status = () => container.querySelector("[data-question-live-status]")!;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

it("is a polite live region in the page before anything is said", async () => {
  await render("host:thread-1", ["ask-1"]);
  expect(status().getAttribute("role")).toBe("status");
  expect(status().getAttribute("aria-live")).toBe("polite");
  expect(status().textContent).toBe("");
});

it("says a question settled elsewhere, and not one this page answered", async () => {
  await render("host:thread-1", ["ask-1", "ask-2"]);
  settle.claim("ask-1");
  await render("host:thread-1", ["ask-2"]);
  expect(status().textContent).toBe("");
  await render("host:thread-1", []);
  expect(status().textContent).toBe(QUESTION_SETTLED_ELSEWHERE);
});

it("says it again for a refused answer whose question then settles", async () => {
  await render("host:thread-1", ["ask-1"]);
  settle.claim("ask-1");
  settle.release("ask-1");
  await render("host:thread-1", []);
  expect(status().textContent).toBe(QUESTION_SETTLED_ELSEWHERE);
});

it("stays silent while a conversation loads or another one opens", async () => {
  await render(null, []);
  await render("host:thread-1", ["ask-1"]);
  await render("host:thread-2", []);
  await render(null, []);
  await render("host:thread-2", ["ask-9"]);
  expect(status().textContent).toBe("");
});

it("reads the same words again as a new announcement", async () => {
  await render("host:thread-1", []);
  await act(async () => announce("Answer sent."));
  const first = status().firstElementChild;
  await act(async () => announce("Answer sent."));
  expect(status().textContent).toBe("Answer sent.");
  expect(status().firstElementChild).not.toBe(first);
});

it("says what an uncertain send came to once its question settles", async () => {
  await render("host:thread-1", ["ask-1", "ask-2"]);
  settle.expect("ask-1", () => "Answer sent.");
  settle.expect("ask-2", () => null);
  await render("host:thread-1", ["ask-2"]);
  expect(status().textContent).toBe("Answer sent.");
  await render("host:thread-1", []);
  expect(status().textContent).toBe("Answer sent.");
});

it("forgets what it expected when another conversation opens", async () => {
  await render("host:thread-1", ["ask-1"]);
  settle.expect("ask-1", () => "Answer sent.");
  await render("host:thread-2", []);
  await render("host:thread-1", ["ask-1"]);
  await render("host:thread-1", []);
  expect(status().textContent).toBe(QUESTION_SETTLED_ELSEWHERE);
});
