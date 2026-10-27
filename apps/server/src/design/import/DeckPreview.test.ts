// @effect-diagnostics nodeBuiltinImport:off - Reads the fixture deck with Node APIs.
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { DesignPreviewDeckResult } from "@specweave-studio/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../../config.ts";
import * as WorkspaceSensitivePaths from "../../workspace/WorkspaceSensitivePaths.ts";
import { previewDeck, previewDeckBytes, previewImages } from "./DeckPreview.ts";
import { readPptxDeck } from "./pptxImport.ts";
import { minimalDeck } from "./pptxImport.testkit.ts";

const layerConfig = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "studio-deck-preview-test-",
});
const decodePreview = Schema.decodeUnknownSync(DesignPreviewDeckResult);
const layerTest = layerConfig.pipe(Layer.provideMerge(NodeServices.layer));

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  "base64",
);
const picture = (name: string, rel: string) =>
  `<p:pic><p:nvPicPr><p:cNvPr id="2" name="${name}"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="${rel}"/></p:blipFill><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="6350000" cy="3175000"/></a:xfrm></p:spPr></p:pic>`;
const title = (text: string) =>
  `<p:sp><p:nvSpPr><p:cNvPr id="3" name="Title"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="6350000" cy="635000"/></a:xfrm></p:spPr><p:txBody><a:bodyPr/><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp>`;
const pictureDeck = () =>
  minimalDeck({
    slides: [picture("Logo", "rIdLogo") + title("Launch"), title("Thanks")],
    slideRels: `<Relationship Id="rIdLogo" Type="x/image" Target="../media/logo.png"/>`,
    files: [["ppt/media/logo.png", PNG_1X1]],
  });

describe("deck preview", () => {
  it("reads every slide of a deck, pictures as data URLs the image nodes name", async () => {
    const preview = await previewDeckBytes(pictureDeck());
    // What the server sends is what the contract decodes.
    decodePreview(preview);
    expect(preview.pages).toHaveLength(2);
    const [first] = preview.pages;
    expect(first!.nodes[0]).toMatchObject({ type: "frame", width: 1920, height: 1080 });
    const image = first!.nodes.find((node) => node.type === "image");
    expect(image).toBeDefined();
    const asset = image!.type === "image" ? image!.asset : "";
    expect(asset).toMatch(/^[a-f0-9]{64}\.png$/);
    expect(preview.images[asset]).toBe(`data:image/png;base64,${PNG_1X1.toString("base64")}`);
    expect(first!.nodes.some((node) => node.type === "text" && node.text === "Launch")).toBe(true);
    expect(preview.imagesOmitted).toBe(0);
  });

  it("leaves out pictures past the picture budget and says so", async () => {
    let id = 0;
    const deck = await readPptxDeck(pictureDeck(), () => `n_test${(id += 1)}`);
    const kept = previewImages(deck, PNG_1X1.byteLength);
    expect(Object.keys(kept.images)).toHaveLength(1);
    const none = previewImages(deck, PNG_1X1.byteLength - 1);
    expect(none).toMatchObject({ omitted: 1, images: {} });
    expect(none.assets.size).toBe(0);
  });

  it.effect("previews a deck outside any workspace and explains files it cannot preview", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "studio-deck-preview-" });
      const deck = path.join(root, "exports", "installed-deck.pptx");
      yield* fileSystem.makeDirectory(path.dirname(deck), { recursive: true });
      yield* fileSystem.writeFile(deck, pictureDeck());
      const preview = yield* previewDeck({ path: deck });
      expect(preview.pages).toHaveLength(2);

      const fixture = NodePath.join(import.meta.dirname, "fixtures", "third-party-6-slides.pptx");
      if (NodeFS.existsSync(fixture)) {
        expect((yield* previewDeck({ path: fixture })).pages).toHaveLength(6);
      }

      const corrupt = path.join(root, "corrupt.pptx");
      yield* fileSystem.writeFileString(corrupt, "not a zip");
      const failures = {
        relative: { path: "exports/installed-deck.pptx" },
        other: { path: path.join(root, "notes.docx") },
        missing: { path: path.join(root, "gone.pptx") },
        corrupt: { path: corrupt },
      };
      yield* fileSystem.writeFileString(failures.other.path, "docx");
      const codes: Record<string, { code: string; detail: string }> = {};
      for (const [name, input] of Object.entries(failures)) {
        const error = yield* previewDeck(input).pipe(Effect.flip);
        codes[name] = { code: error.code, detail: error.detail };
      }
      expect(codes).toMatchObject({
        relative: { code: "invalid" },
        other: { code: "invalid", detail: "Only PowerPoint decks (.pptx) have a slide preview." },
        missing: { code: "not_found" },
        corrupt: { code: "invalid" },
      });

      // A protected file is answered as missing, as media files are.
      yield* fileSystem.makeDirectory(config.secretsDir, { recursive: true });
      const secret = path.join(config.secretsDir, "deck.pptx");
      yield* fileSystem.writeFile(secret, pictureDeck());
      const refused = yield* previewDeck({ path: secret }).pipe(Effect.flip);
      expect(refused.code).toBe("not_found");
    }).pipe(
      Effect.provide(layerTest),
      Effect.provideService(WorkspaceSensitivePaths.SensitivePathsHomeDirectory, NodeOS.tmpdir()),
    ),
  );
});
