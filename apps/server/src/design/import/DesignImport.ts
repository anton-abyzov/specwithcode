/**
 * `design.importDeck`: a PowerPoint deck becomes a new slides document. The
 * deck is read first (`pptxImport.ts`), so a refused file leaves nothing
 * behind; then the document is created, its pictures stored through the
 * design asset store and its slides written in one apply. A failure, defect
 * or interruption (the client going away) after creation removes the
 * half-made design.
 */
import {
  DESIGN_DECK_IMPORT_MAX_BYTES,
  DESIGN_MAX_PAGES,
  DesignError,
  type DesignGetResult,
  type DesignImportDeckInput,
  type DesignImportDeckResult,
  type DesignImportSkipped,
  type DesignNode,
  type DesignOperation,
  type DesignPage,
} from "@specweave-studio/contracts";
import { designId } from "@specweave-studio/shared/designOps";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Result from "effect/Result";

import type { DesignCaller, DesignService } from "../DesignService.ts";
import { megabytes, PptxImportError, readPptxDeck, type ImportedDeck } from "./pptxImport.ts";

const SLIDE_WIDTH = 1920;
const SLIDE_HEIGHT = 1080;
/** What `DesignImportSkipped` holds for one slide: items, and characters per item. */
const SKIPPED_ITEMS = 50;
const SKIPPED_ITEM_CHARS = 300;

const skippedItem = (item: string) =>
  item.length > SKIPPED_ITEM_CHARS ? `${item.slice(0, SKIPPED_ITEM_CHARS - 1)}…` : item;

const readDeck = (bytes: Uint8Array) =>
  Effect.tryPromise({
    try: () => readPptxDeck(bytes, () => designId("n")),
    catch: (error) =>
      error instanceof PptxImportError
        ? new DesignError({ code: error.code, detail: error.message })
        : new DesignError({
            code: "invalid",
            detail: "The file could not be read as a PowerPoint deck (.pptx).",
          }),
  });

/** The pages of an imported deck, with stored asset names in its image nodes. */
export function importedPages(
  deck: ImportedDeck,
  assets: ReadonlyMap<string, string>,
): { readonly pages: DesignPage[]; readonly notImported: DesignImportSkipped[] } {
  const notImported: DesignImportSkipped[] = [];
  const pages = deck.slides.map((slide, index): DesignPage => {
    const items = [...slide.notImported];
    const nodes: DesignNode[] = [
      {
        id: slide.frameId,
        parentId: null,
        type: "frame",
        name: slide.name,
        x: 0,
        y: 0,
        width: SLIDE_WIDTH,
        height: SLIDE_HEIGHT,
        fill: slide.background ?? "#ffffff",
        clip: true,
      },
    ];
    for (const item of slide.nodes) {
      if (item.kind === "node") {
        nodes.push(item.node);
        continue;
      }
      const asset = assets.get(item.media);
      if (asset === undefined) {
        // Pictures over the store's limit were already listed when the deck was read.
        items.push(
          item.node.name === undefined
            ? "Picture that could not be stored"
            : `Picture "${item.node.name}" could not be stored`,
        );
        continue;
      }
      nodes.push({ ...item.node, asset });
    }
    if (items.length > 0) {
      notImported.push({
        slide: index + 1,
        items: items.slice(0, SKIPPED_ITEMS).map(skippedItem),
      });
    }
    return {
      id: designId("p"),
      name: slide.name,
      nodes,
      ...(slide.notes === undefined ? {} : { notes: slide.notes }),
      ...(slide.skipped ? { skipped: true } : {}),
    };
  });
  return { pages, notImported };
}

export const importDeck = (
  designs: DesignService["Service"],
  caller: DesignCaller,
  input: DesignImportDeckInput,
) =>
  Effect.gen(function* () {
    if (caller.actor.kind !== "user") {
      return yield* new DesignError({
        code: "forbidden",
        detail: "Only a person can import a PowerPoint deck.",
      });
    }
    const bytes = Buffer.from(input.data, "base64");
    if (bytes.byteLength > DESIGN_DECK_IMPORT_MAX_BYTES) {
      return yield* new DesignError({
        code: "too_large",
        detail: `The file is larger than ${megabytes(DESIGN_DECK_IMPORT_MAX_BYTES)}, the import limit.`,
      });
    }
    // The reader refuses more slides than a slides document holds.
    const deck = yield* readDeck(bytes);
    const create = designs.create(caller, {
      owner: input.owner,
      kind: "slides",
      title: input.title,
      designSystem: input.designSystem,
    });
    const addressOf = (created: DesignGetResult) => ({
      owner: input.owner,
      designId: created.ref.designId,
    });
    const fill = (created: DesignGetResult) =>
      Effect.gen(function* () {
        const address = addressOf(created);
        const assets = new Map<string, string>();
        for (const [media, image] of deck.media) {
          const stored = yield* designs
            .putAsset(caller, {
              ...address,
              mimeType: image.mimeType,
              data: Buffer.from(image.bytes).toString("base64"),
            })
            .pipe(Effect.result);
          if (Result.isSuccess(stored)) assets.set(media, stored.success.asset);
        }
        const { pages, notImported } = importedPages(deck, assets);
        // The new design starts with one blank page, removed once the slides are in. Slides
        // past the page limit while it is still there go in after the removal, so a deck at
        // the limit fits.
        const blank = created.document.pages;
        const room = Math.max(0, DESIGN_MAX_PAGES - blank.length);
        const add = (page: (typeof pages)[number], index: number) =>
          ({ op: "add_page", page, index }) as const;
        const operations: DesignOperation[] = [
          ...pages.slice(0, room).map(add),
          ...blank.map((page) => ({ op: "delete_page" as const, pageId: page.id })),
          ...pages.slice(room).map((page, offset) => add(page, room + offset)),
        ];
        const applied = yield* designs.apply(caller, {
          ...address,
          expectedRevision: created.document.revision,
          operations,
        });
        return { ref: applied.ref, notImported } satisfies DesignImportDeckResult;
      });
    // Creation runs uninterruptibly, and the removal runs on any exit but success,
    // interruption included, so no half-made design is left behind.
    return yield* Effect.acquireUseRelease(create, fill, (created, exit) =>
      Exit.isSuccess(exit)
        ? Effect.void
        : designs.remove(caller, addressOf(created)).pipe(Effect.ignore),
    );
  }).pipe(Effect.withSpan("DesignImport.importDeck"));
