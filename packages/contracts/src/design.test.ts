import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  DESIGN_DOCUMENT_SCHEMA,
  DESIGN_NODE_TYPES,
  DesignDocument,
  DesignError,
  DesignMoveInput,
  DesignNode,
  DesignOperation,
  DesignSystem,
  type DesignNode as DesignNodeType,
} from "./design.ts";
import { CLIENT_GUARDED_RPC_SCOPES, clientRpcRequiredScopes } from "./clientRpcPermissions.ts";
import { WS_METHODS } from "./rpc.ts";

const base = { parentId: "frame_1", x: 10, y: 20, width: 100, height: 40 };

const everyNode: readonly DesignNodeType[] = [
  {
    ...base,
    id: "frame_1",
    parentId: null,
    type: "frame",
    fill: { token: "wv-canvas" },
    clip: true,
  },
  {
    ...base,
    id: "rect_1",
    type: "rect",
    fill: "#ff0000",
    radius: 8,
    stroke: "#000",
    strokeWidth: 1,
  },
  { ...base, id: "ellipse_1", type: "ellipse", fill: "#00ff00" },
  {
    ...base,
    id: "line_1",
    type: "line",
    points: [
      [0, 0],
      [100, 0],
    ],
    stroke: "#000",
  },
  {
    ...base,
    id: "path_1",
    type: "path",
    points: [
      [0, 0],
      [5, 5],
      [10, 0],
    ],
    closed: true,
  },
  {
    ...base,
    id: "text_1",
    type: "text",
    text: "Hello",
    fontSize: { token: "wv-text-lg" },
    fontWeight: 600,
    align: "center",
  },
  { ...base, id: "image_1", type: "image", asset: `${"a".repeat(64)}.png`, fit: "contain" },
  { ...base, id: "note_1", type: "note", text: "Remember", color: "blue" },
  { ...base, id: "html_1", type: "html", html: "<button>Go</button>" },
  {
    ...base,
    id: "comp_1",
    type: "component",
    componentId: "Button",
    props: { variant: "primary" },
  },
];

const document = {
  schema: DESIGN_DOCUMENT_SCHEMA,
  id: "d_test",
  kind: "design",
  title: "Test",
  revision: 3,
  createdAt: "2026-10-20T00:00:00.000Z",
  updatedAt: "2026-10-20T00:00:00.000Z",
  designSystem: null,
  pages: [{ id: "p_1", name: "Page 1", nodes: everyNode }],
  comments: [
    {
      id: "c_1",
      pageId: "p_1",
      nodeId: "rect_1",
      x: 0,
      y: 0,
      text: "Bigger",
      author: { kind: "user" },
      createdAt: "2026-10-20T00:00:00.000Z",
      resolved: false,
    },
  ],
  createdBy: { kind: "user" },
  copiedFrom: null,
} as const;

describe("design contracts", () => {
  it("round-trips a document with every node type", () => {
    expect(new Set(everyNode.map((node) => node.type))).toEqual(new Set(DESIGN_NODE_TYPES));
    const decoded = Schema.decodeUnknownSync(DesignDocument)(document);
    const encoded = Schema.encodeSync(DesignDocument)(decoded);
    expect(JSON.parse(JSON.stringify(encoded))).toEqual(JSON.parse(JSON.stringify(document)));
  });

  it("threads a reply by parentId and still reads documents from before replies", () => {
    const reply = { ...document.comments[0], id: "c_2", text: "Agreed", parentId: "c_1" };
    const threaded = { ...document, comments: [...document.comments, reply] };
    const decoded = Schema.decodeUnknownSync(DesignDocument)(threaded);
    expect(decoded.comments[1]?.parentId).toBe("c_1");
    expect(JSON.parse(JSON.stringify(Schema.encodeSync(DesignDocument)(decoded)))).toEqual(
      JSON.parse(JSON.stringify(threaded)),
    );
    const older = Schema.encodeSync(DesignDocument)(
      Schema.decodeUnknownSync(DesignDocument)(document),
    );
    expect(older.comments[0]).not.toHaveProperty("parentId");
    expect(() =>
      Schema.decodeUnknownSync(DesignDocument)({
        ...document,
        comments: [{ ...reply, parentId: "../c_1" }],
      }),
    ).toThrow();
  });

  it("rejects unknown node types", () => {
    expect(() =>
      Schema.decodeUnknownSync(DesignNode)({ ...base, id: "x", type: "video", src: "a.mp4" }),
    ).toThrow();
  });

  it("rejects non-finite geometry", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 2e6]) {
      expect(() =>
        Schema.decodeUnknownSync(DesignNode)({ ...base, id: "x", type: "rect", x: bad }),
      ).toThrow();
    }
    expect(() =>
      Schema.decodeUnknownSync(DesignNode)({ ...base, id: "x", type: "rect", width: -1 }),
    ).toThrow();
  });

  it("rejects ids that are not path-safe", () => {
    expect(() =>
      Schema.decodeUnknownSync(DesignNode)({ ...base, id: "../escape", type: "rect" }),
    ).toThrow();
    expect(() => Schema.decodeUnknownSync(DesignDocument)({ ...document, id: "a/b" })).toThrow();
  });

  it("rejects image assets that are not content-hash names", () => {
    expect(() =>
      Schema.decodeUnknownSync(DesignNode)({
        ...base,
        id: "i",
        type: "image",
        asset: "../../x.png",
      }),
    ).toThrow();
  });

  it("decodes operations and a design system with provenance", () => {
    expect(
      Schema.decodeUnknownSync(DesignOperation)({
        op: "update_node",
        pageId: "p_1",
        id: "rect_1",
        patch: { fill: { token: "wv-iris" } },
      }).op,
    ).toBe("update_node");
    const system = Schema.decodeUnknownSync(DesignSystem)({
      schema: "swc.design-system/1",
      id: "s_weave",
      name: "Weave",
      revision: 1,
      createdAt: "2026-10-20T00:00:00.000Z",
      updatedAt: "2026-10-20T00:00:00.000Z",
      modes: [
        { id: "light", name: "Light" },
        { id: "dark", name: "Dark" },
      ],
      tokens: [
        {
          name: "wv-canvas",
          type: "color",
          values: {
            light: {
              raw: "#f8f7f9",
              resolved: "#f8f7f9",
              provenance: {
                source: "file",
                location: "design/weave/tokens.json",
                line: 11,
                sha256: "0".repeat(64),
                extractor: "weave-json",
              },
            },
          },
        },
      ],
      components: [],
      sources: [
        { kind: "file", location: "design/weave/tokens.json", readAt: "2026-10-20T00:00:00.000Z" },
      ],
      copiedFrom: null,
    });
    expect(system.tokens[0]?.values.light?.provenance.line).toBe(11);
  });
});

describe("design read permissions", () => {
  // Unary reads must be guarded tags: the plain query family's default guard
  // denies every scoped method, which left the gallery empty on a real server.
  it("puts every unary design read in the guarded map with filesystem:read", () => {
    for (const tag of [
      WS_METHODS.designList,
      WS_METHODS.designGet,
      WS_METHODS.designHistory,
      WS_METHODS.designExport,
      WS_METHODS.designSystemList,
      WS_METHODS.designSystemGet,
    ]) {
      expect(Object.hasOwn(CLIENT_GUARDED_RPC_SCOPES, tag)).toBe(true);
      expect(clientRpcRequiredScopes(tag, {})).toEqual(["filesystem:read"]);
    }
    expect(clientRpcRequiredScopes(WS_METHODS.designWatch, {})).toEqual(["filesystem:read"]);
  });
});

describe("design move contracts (1046)", () => {
  it("decodes a move into a project and refuses a bad target or revision", () => {
    const input = Schema.decodeUnknownSync(DesignMoveInput)({
      owner: { kind: "playground" },
      designId: "d_abc",
      to: { kind: "project", projectId: "project-a" },
      expectedRevision: 3,
    });
    expect(input).toEqual({
      owner: { kind: "playground" },
      designId: "d_abc",
      to: { kind: "project", projectId: "project-a" },
      expectedRevision: 3,
    });
    for (const bad of [
      { ...input, to: { kind: "elsewhere" } },
      { ...input, expectedRevision: -1 },
      { ...input, designId: "../d_abc" },
    ]) {
      expect(() => Schema.decodeUnknownSync(DesignMoveInput)(bad)).toThrow();
    }
  });

  it("decodes a design error with and without movedTo", () => {
    const decode = Schema.decodeUnknownSync(DesignError);
    const plain = decode({ _tag: "DesignError", code: "not_found", detail: "No design d_abc." });
    expect(plain.movedTo).toBeUndefined();
    const moved = decode({
      _tag: "DesignError",
      code: "not_found",
      detail: "Moved to Alpha.",
      movedTo: { owner: { kind: "project", projectId: "project-a" }, designId: "d_abc" },
    });
    expect(moved.movedTo).toEqual({
      owner: { kind: "project", projectId: "project-a" },
      designId: "d_abc",
    });
    expect(Schema.encodeSync(DesignError)(moved)).toMatchObject({
      movedTo: { designId: "d_abc" },
    });
    expect(() =>
      decode({
        _tag: "DesignError",
        code: "not_found",
        detail: "Moved.",
        movedTo: { owner: { kind: "project" }, designId: "d_abc" },
      }),
    ).toThrow();
  });
});
