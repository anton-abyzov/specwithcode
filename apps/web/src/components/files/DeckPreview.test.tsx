import {
  DesignError,
  EnvironmentId,
  type DesignPage,
  type DesignPreviewDeckResult,
} from "@specweave-studio/contracts";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  capabilities: { designDeckPreview: true } as Record<string, boolean> | undefined,
  query: { data: null, error: null, failure: null } as {
    data: unknown;
    error: string | null;
    failure: unknown;
  },
  asked: [] as unknown[],
  activated: [] as Array<{ action: string; filePath: string }>,
  files: { canOpenDefault: true, revealLabel: "Show in Finder" as string | undefined },
}));

vi.mock("~/state/entities", () => ({
  useServerConfigs: () =>
    new Map([["deck-host", { environment: { capabilities: state.capabilities } }]]),
}));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: (atom: unknown) => {
    state.asked.push(atom);
    return atom === null ? { data: null, error: null, failure: null } : state.query;
  },
}));
vi.mock("~/studio/design", () => ({
  design: { previewDeck: (target: unknown) => ({ previewDeck: target }) },
}));
vi.mock("~/fileContextMenu", () => ({
  useFileContextMenu: () => ({
    capabilities: { ...state.files, editorIds: [] },
    activate: async (action: string, target: { filePath: string }) => {
      state.activated.push({ action, filePath: target.filePath });
    },
  }),
}));
vi.mock("../design/slides/SlideThumbnail", () => ({
  SlideThumbnail: (props: { page: DesignPage }) => <div data-slide-page={props.page.name} />,
}));

import { deckFailureReason, deckSummary, FilePreviewCard, HostDeckPreview } from "./DeckPreview";
import { hostFilePreview, noPreviewReason } from "./hostFilePreview";

const environmentId = EnvironmentId.make("deck-host");
const DECK = "/Users/me/.specwithcode/m4/evidence/exports/installed-1.0.92-deck.pptx";

const page = (name: string, skipped = false): DesignPage => ({
  id: `p_${name.replace(/\s/g, "")}`,
  name,
  nodes: [
    {
      id: `n_${name.replace(/\s/g, "")}`,
      parentId: null,
      type: "frame",
      name,
      x: 0,
      y: 0,
      width: 1920,
      height: 1080,
      fill: "#ffffff",
    },
  ],
  ...(skipped ? { skipped: true } : {}),
});
const preview = (overrides: Partial<DesignPreviewDeckResult> = {}): DesignPreviewDeckResult => ({
  pages: [1, 2, 3, 4, 5].map((index) => page(`Slide ${index}`, index === 4)),
  images: {},
  imagesOmitted: 0,
  notImported: [],
  ...overrides,
});

let renderer: ReactTestRenderer | undefined;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.capabilities = { designDeckPreview: true };
  state.query = { data: null, error: null, failure: null };
  state.asked = [];
  state.activated = [];
  state.files = { canOpenDefault: true, revealLabel: "Show in Finder" };
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

const text = () =>
  renderer!.root
    .findAll((node) => typeof node.type === "string")
    .flatMap((node) => node.children.filter((child) => typeof child === "string"))
    .join(" ");
const button = (label: string) =>
  renderer!.root
    .findAllByType("button")
    .find((node) => node.findAll((child) => child.children.includes(label)).length > 0);

it("previews .pptx decks, cards office files and archives, and reads the rest as text", () => {
  expect(hostFilePreview(DECK)).toBe("deck");
  expect(hostFilePreview("/tmp/DECK.PPTX")).toBe("deck");
  for (const path of ["/tmp/a.key", "/tmp/b.docx", "/tmp/c.xlsx", "/tmp/d.ppt", "/tmp/e.zip"]) {
    expect(hostFilePreview(path), path).toBe("card");
  }
  for (const path of ["/tmp/Makefile", "/tmp/notes.txt", "/tmp/app.ts", "/tmp/LICENSE"]) {
    expect(hostFilePreview(path), path).toBe("text");
  }
  expect(noPreviewReason("talk.key")).toBe("Keynote presentations have no preview here.");
  expect(noPreviewReason("brief.docx")).toBe("Word documents have no preview here.");
  expect(noPreviewReason("old.ppt")).toBe(
    "Only PowerPoint decks saved as .pptx have a slide preview.",
  );
  expect(noPreviewReason("bundle.zip")).toBe("bundle.zip has no preview here.");
});

it("says how many slides there are and what the preview leaves out", () => {
  expect(deckSummary(preview())).toBe("5 slides");
  expect(deckSummary(preview({ pages: [page("Only")] }))).toBe("1 slide");
  expect(
    deckSummary(preview({ notImported: [{ slide: 2, items: ["Chart"] }], imagesOmitted: 2 })),
  ).toBe(
    "5 slides. Not drawn here: charts, tables, media and effects and 2 large pictures. The deck opens complete in its app.",
  );
});

it("draws every slide of the deck the host read, a hidden one marked", async () => {
  state.query = { data: preview(), error: null, failure: null };
  await act(async () => {
    renderer = create(<HostDeckPreview environmentId={environmentId} path={DECK} name="deck" />);
  });
  expect(state.asked).toContainEqual({ previewDeck: { environmentId, input: { path: DECK } } });
  const slides = renderer!.root.findAll(
    (node) => typeof node.type === "string" && node.props["data-deck-slide"] !== undefined,
  );
  expect(
    slides.map(
      (node) =>
        node.findAll((child) => child.props["data-slide-page"] !== undefined)[0]!.props[
          "data-slide-page"
        ],
    ),
  ).toEqual(["Slide 1", "Slide 2", "Slide 3", "Slide 4", "Slide 5"]);
  // The rail has a thumbnail per slide; the one pressed is current.
  const thumb = (index: number) => renderer!.root.findByProps({ "data-deck-thumb": index });
  expect(thumb(1).props["aria-current"]).toBe("true");
  await act(async () => thumb(3).props.onClick());
  expect(thumb(3).props["aria-current"]).toBe("true");
  expect(thumb(1).props["aria-current"]).toBeUndefined();
  expect(text()).toContain("5 slides");
  expect(text()).toContain("Hidden slide");
  expect(text()).not.toContain("Failed to read file");
});

it("turns a deck that cannot be previewed into a card that opens it in its app", async () => {
  state.query = {
    data: null,
    error: "The deck has no slides.",
    failure: new DesignError({ code: "invalid", detail: "The deck has no slides." }),
  };
  await act(async () => {
    renderer = create(
      <HostDeckPreview
        environmentId={environmentId}
        path={DECK}
        name="installed-1.0.92-deck.pptx"
      />,
    );
  });
  expect(text()).toContain("No preview: The deck has no slides.");
  expect(text()).toContain(DECK);
  await act(async () => button("Open in default app")!.props.onClick());
  await act(async () => button("Show in Finder")!.props.onClick());
  expect(state.activated).toEqual([
    { action: "open", filePath: DECK },
    { action: "reveal-in-folder", filePath: DECK },
  ]);
});

it("asks nothing of a server too old to preview decks, and says so", async () => {
  state.capabilities = {};
  await act(async () => {
    renderer = create(<HostDeckPreview environmentId={environmentId} path={DECK} name="deck" />);
  });
  expect(state.asked).toEqual([null]);
  expect(text()).toContain("too old to preview decks");
  expect(button("Open in default app")).toBeDefined();
});

it("offers the path to copy when the host cannot open files", async () => {
  state.files = { canOpenDefault: false, revealLabel: undefined };
  await act(async () => {
    renderer = create(
      <FilePreviewCard
        environmentId={environmentId}
        path="/tmp/talk.key"
        name="talk.key"
        reason={noPreviewReason("talk.key")}
      />,
    );
  });
  expect(button("Open in default app")).toBeUndefined();
  expect(button("Copy path")).toBeDefined();
});

it("words the server's refusals for the card", () => {
  expect(
    deckFailureReason(
      new DesignError({ code: "too_large", detail: "The deck is larger than 50 MB." }),
      null,
    ),
  ).toBe("No preview: The deck is larger than 50 MB.");
  expect(
    deckFailureReason(new DesignError({ code: "not_found", detail: "Gone." }), "fallback"),
  ).toBe("Gone.");
  expect(deckFailureReason(null, "You need filesystem:read.")).toBe("You need filesystem:read.");
  expect(deckFailureReason(null, null)).toBe("The deck could not be read for a preview.");
});
