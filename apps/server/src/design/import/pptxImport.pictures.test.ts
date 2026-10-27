// @effect-diagnostics nodeBuiltinImport:off - Reads the fixture deck with Node APIs.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import {
  DESIGN_DOCUMENT_SCHEMA,
  type DesignDocument,
  type DesignNode,
} from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import { planPptx, writePptx } from "../export/pptx.ts";
import { exportSheets } from "../export/sheets.ts";
import { readPptxDeck, type ImportedDeck, type ImportedSlide } from "./pptxImport.ts";
import { minimalDeck, NS, REL } from "./pptxImport.testkit.ts";

let counter = 0;
const nodeId = () => `n_pic${(counter += 1)}`;

const named = (slide: ImportedSlide, name: string) =>
  slide.nodes.find((item) => item.node.name === name && item.node.type === "image");

/** A node's box, to the nearest pixel. */
const boxOf = (node: DesignNode | undefined) =>
  node === undefined
    ? undefined
    : [node.x, node.y, node.width, node.height].map((value) => Math.round(value));

const mediaType = (deck: ImportedDeck, slide: ImportedSlide, name: string) => {
  const item = named(slide, name);
  return item?.kind === "image" ? deck.media.get(item.media)?.mimeType : undefined;
};

// A 1 x 1 PNG whose header claims 400 x 200, so fits have a shape to work with.
const PHOTO = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
PHOTO.writeUInt32BE(400, 16);
PHOTO.writeUInt32BE(200, 20);

const picture = (name: string, rel: string, extra = "", box = 'x="0" y="0"') =>
  `<p:pic><p:nvPicPr><p:cNvPr id="2" name="${name}"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="${rel}">${extra}</a:blip><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off ${box}/><a:ext cx="1270000" cy="635000"/></a:xfrm></p:spPr></p:pic>`;
const filledShape = (name: string, geometry: string, rel: string) =>
  `<p:sp><p:nvSpPr><p:cNvPr id="4" name="${name}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="635000" y="635000"/><a:ext cx="1270000" cy="1270000"/></a:xfrm><a:prstGeom prst="${geometry}"><a:avLst/></a:prstGeom><a:blipFill><a:blip r:embed="${rel}"/><a:stretch><a:fillRect/></a:stretch></a:blipFill></p:spPr></p:sp>`;
const rels = (entries: ReadonlyArray<readonly [string, string, string]>) =>
  `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${entries
    .map(
      ([id, type, target]) => `<Relationship Id="${id}" Type="${REL}/${type}" Target="${target}"/>`,
    )
    .join("")}</Relationships>`;

/** A slide on a layout with a band picture and a placeholder, on a master with a logo and a picture background. */
const themedDeck = (slideAttributes?: string) =>
  minimalDeck({
    slides: [
      picture("Faded", "rIdPhoto", '<a:alphaModFix amt="40000"/>') +
        filledShape("Card", "roundRect", "rIdPhoto") +
        filledShape("Oval", "ellipse", "rIdPhoto"),
    ],
    ...(slideAttributes === undefined ? {} : { slideAttributes }),
    slideRels: `<Relationship Id="rIdLayout" Type="${REL}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rIdPhoto" Type="${REL}/image" Target="../media/photo.png"/>`,
    files: [
      [
        "ppt/slideLayouts/slideLayout1.xml",
        `<?xml version="1.0"?><p:sldLayout ${NS}><p:cSld><p:spTree>${picture("Band", "rIdBand", "", 'x="0" y="6223000"')}<p:pic><p:nvPicPr><p:cNvPr id="3" name="Prompt"/><p:cNvPicPr/><p:nvPr><p:ph type="pic" idx="1"/></p:nvPr></p:nvPicPr><p:blipFill><a:blip r:embed="rIdBand"/></p:blipFill><p:spPr/></p:pic></p:spTree></p:cSld></p:sldLayout>`,
      ],
      [
        "ppt/slideLayouts/_rels/slideLayout1.xml.rels",
        rels([
          ["rIdMaster", "slideMaster", "../slideMasters/slideMaster1.xml"],
          ["rIdBand", "image", "../media/band.png"],
        ]),
      ],
      [
        "ppt/slideMasters/slideMaster1.xml",
        `<?xml version="1.0"?><p:sldMaster ${NS}><p:cSld><p:bg><p:bgPr><a:blipFill><a:blip r:embed="rIdBg"/><a:stretch><a:fillRect/></a:stretch></a:blipFill></p:bgPr></p:bg><p:spTree>${picture("Logo", "rIdLogo", "", 'x="10922000" y="0"')}</p:spTree></p:cSld></p:sldMaster>`,
      ],
      [
        "ppt/slideMasters/_rels/slideMaster1.xml.rels",
        rels([
          ["rIdBg", "image", "../media/background.jpeg"],
          ["rIdLogo", "image", "../media/logo.png"],
        ]),
      ],
      ["ppt/media/photo.png", PHOTO],
      ["ppt/media/band.png", PHOTO],
      ["ppt/media/logo.png", PHOTO],
      ["ppt/media/background.jpeg", Buffer.from([0xff, 0xd8, 0xff, 0xd9])],
    ],
  });

describe("readPptxDeck pictures", () => {
  it("keeps every picture of a python-pptx deck where PowerPoint shows it", async () => {
    const deck = await readPptxDeck(
      NodeFS.readFileSync(NodePath.join(import.meta.dirname, "fixtures", "pictures-8-slides.pptx")),
      nodeId,
    );
    const [plain, cropped, placeholder, background, groups, svg, filled, offset] = deck.slides;
    expect(deck.slides.map((slide) => slide.notImported)).toEqual(deck.slides.map(() => []));

    expect(boxOf(named(plain!, "Quadrants PNG")?.node)).toEqual([144, 144, 576, 288]);
    expect(mediaType(deck, plain!, "Quadrants PNG")).toBe("image/png");
    expect(boxOf(named(plain!, "Sunset JPEG")?.node)).toEqual([864, 144, 922, 518]);
    expect(mediaType(deck, plain!, "Sunset JPEG")).toBe("image/jpeg");
    expect(named(plain!, "Rotated logo")?.node).toMatchObject({ rotation: 30, fit: "fill" });

    // The middle half of a 2:1 picture in a square box is a cover fit.
    expect(named(cropped!, "Cropped BC")?.node).toMatchObject({ fit: "cover" });
    expect(boxOf(named(cropped!, "Cropped BC")?.node)).toEqual([288, 216, 576, 576]);

    // A picture placeholder has no position of its own; the layout's applies.
    const inPlaceholder = named(placeholder!, "Placeholder picture")?.node;
    expect(inPlaceholder).toMatchObject({ fit: "cover", width: 864, height: 648 });

    expect(background!.nodes[0]!.node).toMatchObject({
      type: "image",
      name: "Background picture",
      fit: "fill",
    });
    // python-pptx's slide is a hair narrower than 16:9, so the slide area is too.
    expect(boxOf(background!.nodes[0]!.node)).toEqual([0, 0, 1920, 1080]);
    expect(mediaType(deck, background!, "Background picture")).toBe("image/jpeg");

    expect(groups!.nodes.map((item) => item.node.name)).toEqual([
      "Grouped logo",
      "Grouped quadrants",
      "Scaled logo",
    ]);
    expect(boxOf(named(groups!, "Scaled logo")?.node)).toEqual([1296, 576, 144, 144]);

    // An SVG picture arrives as its PNG fallback.
    expect(mediaType(deck, svg!, "SVG badge")).toBe("image/png");

    expect(boxOf(named(filled!, "Picture-filled rectangle")?.node)).toEqual([288, 144, 864, 486]);

    // An off-center crop: a clipping frame on the box, the whole picture inside it.
    const [, frame, image] = [undefined, ...offset!.nodes.map((item) => item.node)];
    expect(frame).toMatchObject({ type: "frame", name: "Offset crop CD", clip: true });
    expect(boxOf(frame)).toEqual([288, 216, 864, 360]);
    expect(image).toMatchObject({ type: "image", parentId: frame!.id, fit: "fill" });
    expect(boxOf(image)).toEqual([-864, -40, 1728, 400]);
  });

  it("adds the master's and layout's pictures and background under the slide, with transparency", async () => {
    const deck = await readPptxDeck(themedDeck(), nodeId);
    const [slide] = deck.slides;
    expect(slide!.nodes.map((item) => item.node.name)).toEqual([
      "Background picture",
      "Logo",
      "Band",
      "Faded",
      "Card",
    ]);
    expect(slide!.nodes.map((item) => item.node.type)).toEqual(Array(5).fill("image"));
    expect(slide!.nodes[0]!.node).toMatchObject({ x: 0, y: 0, width: 1920, height: 1080 });
    expect(mediaType(deck, slide!, "Background picture")).toBe("image/jpeg");
    expect(slide!.nodes[2]!.node).toMatchObject({ x: 0, y: 980, width: 200, height: 100 });
    expect(slide!.nodes[3]!.node).toMatchObject({ opacity: 0.4 });
    expect(slide!.nodes[4]!.node).toMatchObject({ x: 100, y: 100, width: 200, height: 200 });
    expect((slide!.nodes[4]!.node as { radius?: number }).radius).toBeCloseTo(33.33, 1);
    expect(slide!.notImported).toEqual(['Picture-filled shape (ellipse) "Oval"']);
    expect([...deck.media.keys()].sort()).toEqual([
      "ppt/media/background.jpeg",
      "ppt/media/band.png",
      "ppt/media/logo.png",
      "ppt/media/photo.png",
    ]);
  });

  it("leaves the master's and layout's pictures out of a slide that hides them", async () => {
    const deck = await readPptxDeck(themedDeck('showMasterSp="0"'), nodeId);
    expect(deck.slides[0]!.nodes.map((item) => item.node.name)).toEqual([
      "Background picture",
      "Faded",
      "Card",
    ]);
  });

  it("letterboxes a 4:3 deck's background picture with its slide area", async () => {
    const deck = await readPptxDeck(
      minimalDeck({
        slides: [picture("Photo", "rIdBg")],
        slideSize: 'cx="9144000" cy="6858000"',
        background:
          '<p:bg><p:bgPr><a:blipFill><a:blip r:embed="rIdBg"/><a:stretch><a:fillRect/></a:stretch></a:blipFill></p:bgPr></p:bg>',
        slideRels: rels([["rIdBg", "image", "../media/background.png"]]).replace(
          /^.*<Relationships[^>]*>|<\/Relationships>$/g,
          "",
        ),
        files: [["ppt/media/background.png", PHOTO]],
      }),
      nodeId,
    );
    const [slide] = deck.slides;
    expect(slide!.nodes.map((item) => item.node.name)).toEqual(["Background picture", "Photo"]);
    expect(slide!.nodes[0]!.node).toMatchObject({
      x: 240,
      y: 0,
      width: 1440,
      height: 1080,
      fit: "fill",
    });
    // The slide's own shapes use the same letterbox.
    expect(boxOf(slide!.nodes[1]!.node)).toEqual([240, 0, 200, 100]);
  });

  it("imports a picture-filled placeholder with no geometry of its own as a rectangle", async () => {
    const deck = await readPptxDeck(
      minimalDeck({
        slides: [
          `<p:sp><p:nvSpPr><p:cNvPr id="5" name="Filled placeholder"/><p:cNvSpPr/><p:nvPr><p:ph type="pic" idx="1"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1270000" cy="635000"/></a:xfrm><a:blipFill><a:blip r:embed="rIdPhoto"/><a:stretch><a:fillRect/></a:stretch></a:blipFill></p:spPr></p:sp>`,
        ],
        slideRels: rels([["rIdPhoto", "image", "../media/photo.png"]]).replace(
          /^.*<Relationships[^>]*>|<\/Relationships>$/g,
          "",
        ),
        files: [["ppt/media/photo.png", PHOTO]],
      }),
      nodeId,
    );
    const [slide] = deck.slides;
    expect(boxOf(named(slide!, "Filled placeholder")?.node)).toEqual([0, 0, 200, 100]);
    expect(slide!.notImported).toEqual([]);
  });

  it("round-trips our exporter's cover, contain and clipped pictures", async () => {
    const asset = `${"a".repeat(64)}.png`;
    const image = (id: string, parentId: string, box: number[], extra: object = {}): DesignNode =>
      ({
        id,
        parentId,
        type: "image",
        name: id,
        asset,
        x: box[0]!,
        y: box[1]!,
        width: box[2]!,
        height: box[3]!,
        ...extra,
      }) as DesignNode;
    const document: DesignDocument = {
      schema: DESIGN_DOCUMENT_SCHEMA,
      id: "d_pictures",
      kind: "slides",
      title: "Pictures",
      revision: 1,
      createdAt: "2026-10-26T12:00:00.000Z",
      updatedAt: "2026-10-26T12:00:00.000Z",
      designSystem: null,
      comments: [],
      createdBy: { kind: "user" },
      copiedFrom: null,
      pages: [
        {
          id: "p_one",
          name: "One",
          nodes: [
            {
              id: "n_slide",
              parentId: null,
              type: "frame",
              x: 0,
              y: 0,
              width: 1920,
              height: 1080,
              fill: "#FFFFFF",
            },
            image("n_cover", "n_slide", [100, 100, 600, 600], { fit: "cover", opacity: 0.5 }),
            image("n_contain", "n_slide", [800, 100, 400, 400], { fit: "contain" }),
            {
              id: "n_window",
              parentId: "n_slide",
              type: "frame",
              name: "Window",
              x: 1300,
              y: 100,
              width: 400,
              height: 300,
            },
            image("n_clipped", "n_window", [-100, -50, 800, 400], { fit: "fill" }),
            image("n_outside", "n_window", [500, 0, 100, 100], { fit: "fill" }),
            // The slide frame clips too: only the left half of this one shows.
            image("n_edge", "n_slide", [1720, 800, 400, 200], { fit: "fill" }),
          ],
        },
      ],
    };
    const plan = planPptx(document, exportSheets(document), {
      system: null,
      mode: "light",
      assetUrl: () => `data:image/png;base64,${PHOTO.toString("base64")}`,
    });
    expect(plan.slides[0]!.items.map((item) => item.options.objectName)).toEqual([
      "n_cover",
      "n_contain",
      "n_clipped",
      "n_edge",
    ]);
    const back = await readPptxDeck(await writePptx(plan, [], { title: "Pictures" }), nodeId);
    const nodes = back.slides[0]!.nodes.map((item) => item.node);
    const find = (name: string) => nodes.find((node) => node.name === name);
    expect(find("n_cover")).toMatchObject({ type: "image", fit: "cover", opacity: 0.5 });
    expect(boxOf(find("n_cover"))).toEqual([100, 100, 600, 600]);
    // Contain is the whole picture at its shown size.
    expect(find("n_contain")).toMatchObject({ type: "image", fit: "fill" });
    expect(boxOf(find("n_contain"))).toEqual([800, 200, 400, 200]);
    const clipped = nodes.filter((node) => node.name === "n_clipped");
    expect(clipped.map((node) => node.type)).toEqual(["frame", "image"]);
    expect(boxOf(clipped[0])).toEqual([1300, 100, 400, 300]);
    expect(boxOf(clipped[1])).toEqual([-100, -50, 800, 400]);
    const edge = nodes.filter((node) => node.name === "n_edge");
    expect(boxOf(edge[0])).toEqual([1720, 800, 200, 200]);
    expect(boxOf(edge[1])).toEqual([0, 0, 400, 200]);
  });
});
