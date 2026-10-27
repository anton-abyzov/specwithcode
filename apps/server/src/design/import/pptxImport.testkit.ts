// @effect-diagnostics nodeBuiltinImport:off - Builds test archives with Node APIs.
import * as NodeZlib from "node:zlib";
import {
  DESIGN_DOCUMENT_SCHEMA,
  type DesignDocument,
  type DesignNode,
} from "@specweave-studio/contracts";
import type { DesignRenderContext } from "@specweave-studio/shared/designRender";

import { planPptx, writePptx } from "../export/pptx.ts";
import { exportSheets } from "../export/sheets.ts";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
const ASSET = `${"a".repeat(64)}.png`;

/** A ZIP of stored (uncompressed) entries; names are written as given. */
export function storedZip(
  files: ReadonlyArray<readonly [string, string | Buffer]>,
  /** Uncompressed sizes to claim in the central directory, by entry name. */
  claimed: ReadonlyMap<string, number> = new Map(),
): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of files) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
    const nameBytes = Buffer.from(name, "utf8");
    const crc = NodeZlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    // A stored entry's two sizes agree; a claimed size is never read back.
    central.writeUInt32LE(claimed.get(name) ?? data.length, 20);
    central.writeUInt32LE(claimed.get(name) ?? data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const frame = (id: string, fill: string): DesignNode => ({
  id,
  parentId: null,
  type: "frame",
  name: id,
  x: 0,
  y: 0,
  width: 1920,
  height: 1080,
  fill,
  clip: true,
});

const deck: DesignDocument = {
  schema: DESIGN_DOCUMENT_SCHEMA,
  id: "d_round",
  kind: "slides",
  title: "Round trip",
  revision: 1,
  createdAt: "2026-10-24T12:00:00.000Z",
  updatedAt: "2026-10-24T12:00:00.000Z",
  designSystem: null,
  comments: [],
  createdBy: { kind: "user" },
  copiedFrom: null,
  pages: [
    {
      id: "p_one",
      name: "Title",
      notes: "Open with the date.",
      nodes: [
        frame("n_f1", "#0F172B"),
        {
          id: "n_title",
          parentId: "n_f1",
          type: "text",
          name: "Title",
          text: "Matchday launch",
          x: 120,
          y: 400,
          width: 1680,
          height: 140,
          color: "#FFFFFF",
          fontSize: 96,
          fontWeight: 700,
        },
        {
          id: "n_card",
          parentId: "n_f1",
          type: "rect",
          name: "Card",
          x: 120,
          y: 700,
          width: 400,
          height: 200,
          fill: "#EA580C",
        },
      ],
    },
    {
      id: "p_two",
      name: "Body",
      notes: "Two lines and a picture.",
      nodes: [
        frame("n_f2", "#FFFFFF"),
        {
          id: "n_body",
          parentId: "n_f2",
          type: "text",
          name: "Body",
          text: "First line\nSecond line",
          x: 120,
          y: 120,
          width: 900,
          height: 200,
          color: "#111827",
          fontSize: 40,
        },
        {
          id: "n_dot",
          parentId: "n_f2",
          type: "ellipse",
          name: "Dot",
          x: 1600,
          y: 80,
          width: 80,
          height: 80,
          fill: "#EF4444",
        },
        {
          id: "n_photo",
          parentId: "n_f2",
          type: "image",
          name: "Photo",
          asset: ASSET,
          fit: "fill",
          x: 1000,
          y: 400,
          width: 640,
          height: 360,
        },
      ],
    },
    {
      id: "p_three",
      name: "Close",
      notes: "Thank the team.",
      nodes: [
        frame("n_f3", "#FFFFFF"),
        {
          id: "n_close",
          parentId: "n_f3",
          type: "text",
          name: "Close",
          text: "Thanks",
          x: 120,
          y: 120,
          width: 900,
          height: 200,
          fontSize: 64,
        },
      ],
    },
  ],
};

const context: DesignRenderContext = {
  system: null,
  mode: "light",
  assetUrl: () => `data:image/png;base64,${PNG_1X1.toString("base64")}`,
};

/** The deck exported by our own PPTX writer. */
export const exportedDeck = async () => {
  const plan = planPptx(deck, exportSheets(deck), context);
  if (plan.rasters.length > 0) throw new Error("The round-trip deck should export without images.");
  return writePptx(plan, [], { title: deck.title });
};

export const NS =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
export const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/** A hand-written deck: one slide part per entry of `slides` (its spTree body), plus extra files. */
export function minimalDeck(input: {
  readonly slides: ReadonlyArray<string>;
  /** Slides listed in presentation.xml; defaults to every slide. */
  readonly listed?: number;
  readonly slideRels?: string;
  readonly files?: ReadonlyArray<readonly [string, string | Buffer]>;
  readonly claimed?: ReadonlyMap<string, number>;
  /** The `p:sldSz` attributes; a 16:9 widescreen slide by default. */
  readonly slideSize?: string;
  /** Attributes of every `p:sld`, and a `p:bg` before its tree. */
  readonly slideAttributes?: string;
  readonly background?: string;
}): Buffer {
  const listed = input.listed ?? input.slides.length;
  const ids = Array.from(
    { length: listed },
    (_, index) => `<p:sldId id="${256 + index}" r:id="rId${index + 1}"/>`,
  ).join("");
  const rels = Array.from(
    { length: listed },
    (_, index) =>
      `<Relationship Id="rId${index + 1}" Type="${REL}/slide" Target="slides/slide${(index % Math.max(1, input.slides.length)) + 1}.xml"/>`,
  ).join("");
  return storedZip(
    [
      [
        "[Content_Types].xml",
        `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/></Types>`,
      ],
      [
        "ppt/presentation.xml",
        `<?xml version="1.0"?><p:presentation ${NS}><p:sldIdLst>${ids}</p:sldIdLst><p:sldSz ${input.slideSize ?? 'cx="12192000" cy="6858000"'}/></p:presentation>`,
      ],
      [
        "ppt/_rels/presentation.xml.rels",
        `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`,
      ],
      ...input.slides.flatMap((tree, index) => [
        [
          `ppt/slides/slide${index + 1}.xml`,
          `<?xml version="1.0"?><p:sld ${NS} ${input.slideAttributes ?? ""}><p:cSld>${input.background ?? ""}<p:spTree>${tree}</p:spTree></p:cSld></p:sld>`,
        ] as const,
        [
          `ppt/slides/_rels/slide${index + 1}.xml.rels`,
          `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${input.slideRels ?? ""}</Relationships>`,
        ] as const,
      ]),
      ...(input.files ?? []),
    ],
    input.claimed,
  );
}
