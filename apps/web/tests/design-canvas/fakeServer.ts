import type {
  DesignSystemId,
  DesignSystemSummary,
  DesignDocument,
  DesignExportResult,
  DesignHistoryEntry,
  DesignOperation,
  DesignSystem,
  EnvironmentId,
  ProjectId,
  ThreadId,
  DesignReuse,
} from "@specweave-studio/contracts";
import { applyDesignOperations, newDesignDocument } from "@specweave-studio/shared/designOps";
import { escapeHtml, renderDesignHtml } from "@specweave-studio/shared/designRender";
import type {
  DesignEditorBackend,
  DesignExportRequest,
  DesignMessage,
} from "../../src/components/design/editor/backend";
import type { DesignApplyResponse } from "../../src/components/design/editor/designSession";

/**
 * An in-memory stand-in for the server's `design` RPCs with the same
 * revision check, so the fixture exercises the real editor, session and
 * reducer. `agentEdit` plays the agent: it applies operations on the server
 * side and pushes the new revision to watchers, as `design.watch` does.
 */

export const ENV = "env-fixture" as EnvironmentId;
export const OTHER_ENV = "env-linked-mini" as EnvironmentId;

let seed = 11;
const random = () => {
  seed = (seed * 16807) % 2147483647;
  return seed / 2147483647;
};

export function fixtureSystem(): DesignSystem {
  const provenance = { source: "file" as const, location: "src/theme.css", extractor: "fixture" };
  const color = (name: string, light: string, dark: string, group = "color") => ({
    name,
    type: "color" as const,
    group,
    values: {
      light: { raw: light, resolved: light, provenance },
      dark: { raw: dark, resolved: dark, provenance },
    },
  });
  const value = (name: string, type: "dimension" | "fontFamily", raw: string) => ({
    name,
    type,
    values: { default: { raw, resolved: raw, provenance } },
  });
  return {
    schema: "swc.design-system/1",
    id: "s_fixture",
    name: "Harbor UI",
    revision: 3,
    createdAt: "2026-10-20T10:00:00.000Z",
    updatedAt: "2026-10-20T10:00:00.000Z",
    modes: [
      { id: "light", name: "Light" },
      { id: "dark", name: "Dark" },
    ],
    tokens: [
      color("surface", "#ffffff", "#17181c"),
      color("surface-muted", "#f2f4f7", "#22242a"),
      color("ink", "#14161a", "#eef0f4"),
      color("ink-muted", "#5b6170", "#a3a9b6"),
      color("accent", "#2f6df6", "#6c9bff"),
      color("accent-ink", "#ffffff", "#0d1424"),
      color("line", "#dfe3ea", "#33363f"),
      value("radius-md", "dimension", "10px"),
      value("radius-lg", "dimension", "16px"),
      value("space-4", "dimension", "16px"),
      value("font-sans", "fontFamily", "Inter, ui-sans-serif, system-ui, sans-serif"),
      value("font-display", "fontFamily", "'Iowan Old Style', Georgia, serif"),
    ],
    components: [
      {
        id: "button-primary",
        name: "Button",
        framework: "react",
        importPath: "@harbor/ui",
        exportName: "Button",
        previewHtml: '<button class="hb-btn">Book a slip</button>',
        provenance,
      },
    ],
    stylesheet:
      ".hb-btn{font:600 14px Inter,system-ui;background:#2f6df6;color:#fff;border:0;border-radius:10px;padding:10px 16px}[data-theme=dark] .hb-btn{background:#6c9bff;color:#0d1424}",
    sources: [{ kind: "file", location: "src/theme.css", readAt: "2026-10-20T10:00:00.000Z" }],
    copiedFrom: null,
  };
}

function seedDocument(nodeCount: number, thread: "none" | "here" | "other"): DesignDocument {
  const doc = newDesignDocument({
    id: "d_fixture",
    kind: "design",
    title: "Marina booking",
    now: "2026-10-20T10:00:00.000Z",
    createdBy: { kind: "user" },
    designSystem: "s_fixture",
    random,
  });
  const page = doc.pages[0]!;
  const frame = page.nodes[0]!;
  const ops: DesignOperation[] = [
    {
      op: "update_node",
      pageId: page.id,
      id: frame.id,
      patch: { name: "Booking", width: 1280, height: 820, fill: { token: "surface" } },
    },
    {
      op: "add_node",
      pageId: page.id,
      node: {
        id: "n_header",
        parentId: frame.id,
        type: "rect",
        name: "Header",
        x: 0,
        y: 0,
        width: 1280,
        height: 72,
        fill: { token: "surface-muted" },
      },
    },
    {
      op: "add_node",
      pageId: page.id,
      node: {
        id: "n_brand",
        parentId: frame.id,
        type: "text",
        name: "Brand",
        text: "Harbor",
        x: 40,
        y: 22,
        width: 200,
        height: 30,
        fontSize: 22,
        fontWeight: 700,
        color: { token: "ink" },
        fontFamily: { token: "font-display" },
      },
    },
    {
      op: "add_node",
      pageId: page.id,
      node: {
        id: "n_title",
        parentId: frame.id,
        type: "text",
        name: "Headline",
        text: "Reserve a slip for tonight",
        x: 40,
        y: 140,
        width: 640,
        height: 64,
        fontSize: 48,
        fontWeight: 700,
        lineHeight: 1.15,
        color: { token: "ink" },
        fontFamily: { token: "font-display" },
      },
    },
    {
      op: "add_node",
      pageId: page.id,
      node: {
        id: "n_body",
        parentId: frame.id,
        type: "text",
        name: "Lede",
        text: "Live berth availability across the marina, updated every few minutes.",
        x: 40,
        y: 224,
        width: 560,
        height: 56,
        fontSize: 18,
        color: { token: "ink-muted" },
        fontFamily: { token: "font-sans" },
      },
    },
    {
      op: "add_node",
      pageId: page.id,
      node: {
        id: "n_card",
        parentId: frame.id,
        type: "rect",
        name: "Map card",
        x: 720,
        y: 120,
        width: 520,
        height: 420,
        fill: { token: "surface-muted" },
        radius: { token: "radius-lg" },
        stroke: { token: "line" },
        strokeWidth: 1,
      },
    },
    {
      op: "add_node",
      pageId: page.id,
      node: {
        id: "n_cta",
        parentId: frame.id,
        type: "component",
        name: "Button",
        componentId: "button-primary",
        x: 40,
        y: 312,
        width: 160,
        height: 44,
      },
    },
    {
      op: "add_node",
      pageId: page.id,
      node: {
        id: "n_html",
        parentId: frame.id,
        type: "html",
        name: "Tide chart",
        x: 760,
        y: 160,
        width: 440,
        height: 200,
        html: '<!doctype html><body style="margin:0;font:13px system-ui;background:#eaf1ff;color:#14161a;display:grid;place-items:center;height:100vh"><div id="t">Tide chart</div><script>let ok="opaque";try{void parent.document.title;ok="LEAK"}catch(e){};const t=document.getElementById("t");t.textContent="Tide chart ("+ok+" origin)";fetch(location.ancestorOrigins?.[0]??"http://127.0.0.1/").then(()=>{t.textContent+=" NET LEAK"},()=>{t.textContent+=", network blocked"});</script></body>',
      },
    },
    {
      op: "add_node",
      pageId: page.id,
      node: {
        id: "n_note",
        parentId: null,
        type: "note",
        text: "Ask the agent for a night variant.",
        x: 1340,
        y: 40,
        width: 220,
        height: 120,
        color: "yellow",
      },
    },
  ];
  if (nodeCount > 0) {
    ops.push({
      op: "add_node",
      pageId: page.id,
      node: {
        id: "n_grid",
        parentId: null,
        type: "frame",
        name: "Stress grid",
        x: 0,
        y: 940,
        width: 2000,
        height: 1000,
        fill: "#ffffff",
        clip: true,
      },
    });
    for (let i = 0; i < nodeCount; i += 1) {
      const kind = i % 3 === 0 ? "ellipse" : i % 3 === 1 ? "rect" : "text";
      const x = (i % 25) * 78 + 12;
      const y = Math.floor(i / 25) * 48 + 12;
      ops.push({
        op: "add_node",
        pageId: page.id,
        node:
          kind === "text"
            ? {
                id: `n_s${i}`,
                parentId: "n_grid",
                type: "text",
                text: `#${i}`,
                x,
                y,
                width: 60,
                height: 24,
                fontSize: 13,
                color: { token: "ink-muted" },
              }
            : {
                id: `n_s${i}`,
                parentId: "n_grid",
                type: kind,
                x,
                y,
                width: 60,
                height: 36,
                fill: i % 2 === 0 ? { token: "accent" } : { token: "line" },
                ...(kind === "rect" ? { radius: 6 } : {}),
              },
      });
    }
  }
  const outcome = applyDesignOperations(doc, ops);
  if (!outcome.ok) throw new Error(outcome.error.detail);
  const binding =
    thread === "none"
      ? {}
      : {
          thread: {
            environmentId: thread === "here" ? ENV : OTHER_ENV,
            threadId: "thread-design" as ThreadId,
          },
        };
  return { ...outcome.document, ...binding, revision: 4 };
}

export interface SentMessage {
  readonly threadId: string;
  readonly text: string;
  readonly images: number;
}

export function createFakeServer(options: {
  nodes: number;
  thread: "none" | "here" | "other";
  latencyMs: number;
  /** Open as a paired device with this level instead of as the owner. */
  member?: "edit" | "comment" | "view";
  /** Refuse every thread binding from this window, as a server that takes it for a member. */
  refuseBinding?: boolean;
  /** Open a design that reuses a system found in its repository instead of an imported one. */
  reuse?: DesignReuse;
  /** Act as an older server that does not thread comment replies. */
  noReplies?: boolean;
  /** Act as an older server that cannot write SVG. */
  noSvgExport?: boolean;
}) {
  let head = seedDocument(options.nodes, options.thread);
  if (options.reuse !== undefined) head = { ...head, designSystem: null, reuse: options.reuse };
  if (options.member !== undefined) {
    const outcome = applyDesignOperations(head, [{ op: "set_access", members: options.member }]);
    if (outcome.ok) head = outcome.document;
  }
  const watchers = new Set<(document: DesignDocument) => void>();
  const assets = new Map<string, string>();
  const sent: SentMessage[] = [];
  const exports: { fileName: string; mimeType: string; bytes: number }[] = [];
  const applied: number[] = [];
  const wait = () => new Promise((resolve) => setTimeout(resolve, options.latencyMs));
  const push = () => {
    for (const watcher of watchers) watcher(head);
  };
  const commit = (operations: readonly DesignOperation[]) => {
    const outcome = applyDesignOperations(head, operations);
    if (!outcome.ok) return outcome.error.detail;
    head = {
      ...outcome.document,
      revision: head.revision + 1,
      updatedAt: new Date().toISOString(),
    };
    applied.push(head.revision);
    return null;
  };
  const system = fixtureSystem();
  const firstRevision = head.revision;
  const named: { revision: number; name: string; savedAt: string }[] = [];
  const restored: number[] = [];
  const versionEntries = (): DesignHistoryEntry[] => [
    ...[...new Set([firstRevision, ...applied, head.revision])].map((revision) => ({
      kind: "revision" as const,
      revision,
      name: null,
      savedAt: head.updatedAt,
      actor: { kind: "user" as const },
    })),
    ...named.map((entry) => ({
      kind: "version" as const,
      revision: entry.revision,
      name: entry.name,
      savedAt: entry.savedAt,
      actor: { kind: "user" as const },
    })),
  ];

  const exportFile = async (request: DesignExportRequest): Promise<DesignExportResult> => {
    await wait();
    const mode =
      request.mode ?? (document.documentElement.classList.contains("dark") ? "dark" : "light");
    const context = { system, mode, assetUrl: (asset: string) => assets.get(asset) ?? "" };
    let result: DesignExportResult;
    if (request.format === "pdf") {
      const frames = head.pages.flatMap((page) =>
        page.nodes.filter((node) => node.type === "frame" && node.parentId === null),
      );
      const text = `%PDF-1.4\n% fixture: ${frames.length} frames (${frames.map((frame) => frame.name ?? frame.id).join(", ")})\n%%EOF\n`;
      result = {
        fileName: `${head.title}.pdf`,
        mimeType: "application/pdf",
        data: btoa(text),
        width: 0,
        height: 0,
      };
    } else {
      const rendered = renderDesignHtml(
        head,
        {
          pageId: request.pageId,
          ...(request.frameId === undefined ? {} : { frameId: request.frameId }),
        },
        context,
      );
      if (request.format === "svg") {
        const { width, height } = rendered;
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><title>${escapeHtml(head.title)}</title><rect width="${width}" height="${height}" fill="#fff"/></svg>`;
        result = {
          fileName: `${head.title}.svg`,
          mimeType: "image/svg+xml",
          data: btoa(unescape(encodeURIComponent(svg))),
          width,
          height,
        };
      } else if (request.format === "html") {
        result = {
          fileName: `${head.title}.html`,
          mimeType: "text/html",
          data: btoa(unescape(encodeURIComponent(rendered.html))),
          width: rendered.width,
          height: rendered.height,
        };
      } else {
        const scale = request.scale ?? 1;
        const data = await rasterize(rendered.html, rendered.width, rendered.height, scale);
        result = {
          fileName: `${head.title}${scale === 2 ? "@2x" : ""}.png`,
          mimeType: "image/png",
          data,
          width: rendered.width * scale,
          height: rendered.height * scale,
        };
      }
    }
    exports.push({
      fileName: result.fileName,
      mimeType: result.mimeType,
      bytes: result.data.length,
    });
    return result;
  };

  const summary = (
    systemId: string,
    name: string,
    owner: DesignSystemSummary["ref"]["owner"],
    ownerLabel: string,
  ): DesignSystemSummary => ({
    ref: { owner, systemId: systemId as DesignSystemId, path: `${systemId}.json` },
    name,
    revision: 1,
    updatedAt: "2026-10-20T00:00:00.000Z",
    tokenCount: 12,
    componentCount: 3,
    sources: [],
    ownerLabel,
  });
  /** The Playground's own system plus another project's, which the picker offers as a copy. */
  const systems: DesignSystemSummary[] = [
    summary("s_fixture", "Harbor UI", { kind: "playground", environmentId: ENV }, "Playground"),
    summary(
      "s_marina",
      "Marina UI",
      { kind: "project", environmentId: ENV, projectId: "p_marina" as ProjectId },
      "Marina",
    ),
  ];
  const copies: string[] = [];

  const backend: DesignEditorBackend = {
    environmentId: ENV,
    address: { owner: { kind: "playground" }, designId: "d_fixture" },
    audience: options.member === undefined ? "owner" : "member",
    commentReplies: options.noReplies !== true,
    svgExport: options.noSvgExport !== true,
    transport: {
      apply: async (expectedRevision, operations): Promise<DesignApplyResponse> => {
        await wait();
        if (expectedRevision !== head.revision)
          return { ok: false, reason: "conflict", currentRevision: head.revision };
        if (options.refuseBinding === true && operations.some((op) => op.op === "set_thread"))
          return {
            ok: false,
            reason: "error",
            code: "forbidden",
            detail: "Only the owner on this machine can change which thread a design is bound to.",
          };
        const error = commit(operations);
        if (error !== null) return { ok: false, reason: "error", detail: error };
        const document = head;
        queueMicrotask(push);
        return { ok: true, document };
      },
      get: async () => {
        await wait();
        return head;
      },
    },
    exportFile,
    assetPut: async (mimeType, data) => {
      await wait();
      const bytes = Uint8Array.from(atob(data), (char) => char.charCodeAt(0));
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      const hex = [...new Uint8Array(digest)]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
      const ext =
        mimeType === "image/jpeg"
          ? "jpg"
          : mimeType === "image/svg+xml"
            ? "svg"
            : mimeType.split("/")[1]!;
      const name = `${hex}.${ext}`;
      assets.set(name, `data:${mimeType};base64,${data}`);
      return name;
    },
    sendToThread: async (thread, message: DesignMessage) => {
      await wait();
      sent.push({ threadId: thread.threadId, text: message.text, images: message.images.length });
      window.dispatchEvent(new CustomEvent("fixture-sent"));
    },
    newThreadId: () => "thread-started" as ThreadId,
    startThread: async (first, { threadId }) => {
      await wait();
      const binding = { environmentId: ENV, threadId };
      sent.push({
        threadId: binding.threadId,
        text: first?.text ?? "(design brief)",
        images: first?.images.length ?? 0,
      });
      window.dispatchEvent(new CustomEvent("fixture-sent"));
      return binding;
    },
    codingThreads: [
      {
        binding: { environmentId: ENV, threadId: "thread-web" as ThreadId },
        title: "Booking page in the web app",
      },
      {
        binding: { environmentId: ENV, threadId: "thread-api" as ThreadId },
        title: "Berth availability API",
      },
    ],
    startCodingThread: async (message) => {
      await wait();
      const binding = { environmentId: ENV, threadId: "thread-implement" as ThreadId };
      sent.push({ threadId: binding.threadId, text: message.text, images: message.images.length });
      window.dispatchEvent(new CustomEvent("fixture-sent"));
      return binding;
    },
    openThread: () => undefined,
    machine: (environmentId) =>
      environmentId === ENV
        ? { environmentId, label: "MacBook Pro", linked: true }
        : environmentId === OTHER_ENV
          ? { environmentId, label: "Mac mini (studio)", linked: true }
          : null,
    share: {
      ownerLabel: "Playground",
      thisMachine: "MacBook Pro",
      devices: ["iPhone", "Chrome on Windows"],
      machines: ["Mac mini (studio)"],
      link: `${location.origin}/design/pg.d_fixture`,
    },
    // Version history: every applied revision is an autosave; Save version names the head.
    versions: {
      list: async () => {
        await wait();
        return versionEntries();
      },
      save: async (name) => {
        await wait();
        named.push({ revision: head.revision, name, savedAt: new Date().toISOString() });
        return versionEntries();
      },
      restore: async (revision, expectedRevision) => {
        await wait();
        if (expectedRevision !== head.revision) throw new Error("The design changed. Try again.");
        head = { ...head, revision: head.revision + 1, updatedAt: new Date().toISOString() };
        applied.push(head.revision);
        restored.push(revision);
        queueMicrotask(push);
        return head;
      },
    },
    designSystems: {
      systems,
      projects: [{ id: "p_marina" as ProjectId, title: "Marina" }],
      copy: async (source) => {
        await wait();
        const copy = summary(
          `${source.ref.systemId}_copy`,
          source.name,
          { kind: "playground", environmentId: ENV },
          "Playground",
        );
        systems.push(copy);
        copies.push(source.ref.systemId);
        return { ok: true, systemId: copy.ref.systemId, name: copy.name };
      },
    },
  };

  return {
    backend,
    restored,
    system,
    assets,
    sent,
    exports,
    applied,
    copies,
    get head() {
      return head;
    },
    watch(listener: (document: DesignDocument) => void) {
      watchers.add(listener);
      return () => watchers.delete(listener);
    },
    /** The agent applies operations on the server; watchers get the new revision. */
    agentEdit(operations: readonly DesignOperation[]) {
      const error = commit(operations);
      if (error === null) push();
      return error;
    },
  };
}

/** Renders standalone HTML to a PNG through an SVG foreignObject; falls back to the frame size in a flat color. */
async function rasterize(
  html: string,
  width: number,
  height: number,
  scale: number,
): Promise<string> {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, width * scale);
  canvas.height = Math.max(1, height * scale);
  const context = canvas.getContext("2d")!;
  context.scale(scale, scale);
  const body = html
    .replace(/^[\s\S]*<body>/, "")
    .replace(/<\/body>[\s\S]*$/, "")
    .replace(/<iframe[^>]*><\/iframe>/g, "");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><foreignObject width="100%" height="100%"><div xmlns="http://www.w3.org/1999/xhtml" style="position:relative;width:${width}px;height:${height}px;font-family:system-ui">${body}</div></foreignObject></svg>`;
  try {
    const image = new Image();
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    await image.decode();
    context.drawImage(image, 0, 0);
    return canvas.toDataURL("image/png").split(",")[1]!;
  } catch {
    context.fillStyle = "#e7e5ea";
    context.fillRect(0, 0, width, height);
    return canvas.toDataURL("image/png").split(",")[1]!;
  }
}
