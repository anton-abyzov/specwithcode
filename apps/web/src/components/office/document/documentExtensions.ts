/**
 * The Word editor's Tiptap extensions: what a .docx holds (headings, marks,
 * lists, tables, pictures, alignment, quotes, code) and nothing that loads or
 * runs anything. Links open only on request and only for http, https, mailto
 * and places in the document; pictures are only data URLs.
 */
import { Extension, Mark, mergeAttributes } from "@tiptap/core";
import Image from "@tiptap/extension-image";
import { Table, TableCell, TableHeader, TableRow } from "@tiptap/extension-table";
import TextAlign from "@tiptap/extension-text-align";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import StarterKit from "@tiptap/starter-kit";

export const SAFE_LINK_RE = /^(https?:\/\/|mailto:|#)\S+$/i;
const DATA_IMAGE_RE = /^data:image\/(png|jpeg|gif|webp);base64,/;
/** Largest picture a paste, drop or Insert picture takes. */
export const MAX_PICTURE_BYTES = 8 * 1024 * 1024;

/** A paragraph's or heading's bookmark name, so links to it survive a save. */
const Bookmark = Extension.create({
  name: "bookmark",
  addGlobalAttributes() {
    return [
      {
        types: ["paragraph", "heading"],
        attributes: {
          bookmark: {
            default: null,
            parseHTML: (element) => element.getAttribute("data-bookmark"),
            renderHTML: (attributes) =>
              typeof attributes.bookmark === "string" && attributes.bookmark
                ? { "data-bookmark": attributes.bookmark }
                : {},
          },
        },
      },
    ];
  },
});

/** Text colour from the file (`#RRGGBB` only). */
const TextColor = Mark.create({
  name: "textColor",
  addAttributes() {
    return {
      color: {
        default: null,
        parseHTML: (element) => {
          const value = element.getAttribute("data-color");
          return value && /^#[0-9A-Fa-f]{6}$/.test(value) ? value : null;
        },
        renderHTML: (attributes) =>
          typeof attributes.color === "string" && /^#[0-9A-Fa-f]{6}$/.test(attributes.color)
            ? { "data-color": attributes.color, style: `color: ${attributes.color}` }
            : {},
      },
    };
  },
  parseHTML: () => [{ tag: "span[data-color]" }],
  renderHTML: ({ HTMLAttributes }) => ["span", mergeAttributes(HTMLAttributes), 0],
});

/** A picture: data URLs only, with the file's hash and alignment kept. */
const DocumentImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      src: {
        default: null,
        parseHTML: (element) => {
          const src = element.getAttribute("src") ?? "";
          return DATA_IMAGE_RE.test(src) ? src : null;
        },
      },
      asset: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-asset"),
        renderHTML: (attributes) =>
          typeof attributes.asset === "string" ? { "data-asset": attributes.asset } : {},
      },
      align: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-align"),
        renderHTML: (attributes) =>
          typeof attributes.align === "string" ? { "data-align": attributes.align } : {},
      },
    };
  },
  parseHTML() {
    return [{ tag: 'img[src^="data:image/"]' }];
  },
}).configure({ inline: false, allowBase64: true });

/** Drops pasted pictures that are not data URLs, so nothing is fetched. */
export function sanitizePastedHtml(html: string): string {
  return html.replace(/<img\b[^>]*>/gi, (tag) => {
    const src = /\ssrc\s*=\s*("([^"]*)"|'([^']*)')/i.exec(tag);
    const value = src?.[2] ?? src?.[3] ?? "";
    return DATA_IMAGE_RE.test(value) ? tag : "";
  });
}

export interface DocumentKeyHandlers {
  readonly onSave: () => void;
  readonly onLink: () => void;
  readonly onShortcuts: () => void;
  /** A picture file pasted or dropped, read as a data URL. */
  readonly onPictureFile: (file: File) => void;
}

/** Word's keys beyond Tiptap's own (bold, italic, headings, lists and undo are built in). */
function documentKeys(handlers: () => DocumentKeyHandlers) {
  return Extension.create({
    name: "documentKeys",
    addKeyboardShortcuts() {
      return {
        "Mod-s": () => {
          handlers().onSave();
          return true;
        },
        "Mod-k": () => {
          handlers().onLink();
          return true;
        },
        "Mod-/": () => {
          handlers().onShortcuts();
          return true;
        },
        "Mod-Shift-x": () => this.editor.commands.toggleStrike(),
        "Mod-Alt-0": () => this.editor.commands.setParagraph(),
        "Mod-Shift-9": () => this.editor.commands.toggleBulletList(),
        "Mod-Shift-b": () => this.editor.commands.toggleBlockquote(),
        // Tab indents inside a list; elsewhere it types a tab, as Word does.
        Tab: () =>
          this.editor.isActive("listItem")
            ? this.editor.commands.sinkListItem("listItem")
            : this.editor.isActive("table")
              ? false
              : this.editor.commands.insertContent("\t"),
        "Shift-Tab": () =>
          this.editor.isActive("listItem") ? this.editor.commands.liftListItem("listItem") : false,
      };
    },
    addProseMirrorPlugins() {
      const take = (files: FileList | null | undefined): boolean => {
        const pictures = [...(files ?? [])].filter((file) => /^image\/(png|jpeg|gif|webp)$/.test(file.type));
        for (const file of pictures) handlers().onPictureFile(file);
        return pictures.length > 0;
      };
      return [
        new Plugin({
          key: new PluginKey("documentPictures"),
          props: {
            transformPastedHTML: sanitizePastedHtml,
            handlePaste: (_view, event) => take(event.clipboardData?.files),
            handleDrop: (_view, event) => take((event as DragEvent).dataTransfer?.files),
          },
        }),
      ];
    },
  });
}

export function documentExtensions(handlers: () => DocumentKeyHandlers) {
  return [
    StarterKit.configure({
      link: {
        openOnClick: false,
        autolink: true,
        linkOnPaste: true,
        defaultProtocol: "https",
        protocols: ["http", "https", "mailto"],
        isAllowedUri: (url) => SAFE_LINK_RE.test(url),
        HTMLAttributes: { rel: "noopener noreferrer nofollow", target: null },
      },
      heading: { levels: [1, 2, 3, 4, 5, 6] },
    }),
    TextAlign.configure({ types: ["heading", "paragraph"] }),
    Table.configure({ resizable: false }),
    TableRow,
    TableHeader,
    TableCell,
    DocumentImage,
    TextColor,
    Bookmark,
    documentKeys(handlers),
  ];
}

/** The keys the shortcuts list shows, with ⌘ shown as Ctrl off macOS. */
export const DOCUMENT_SHORTCUTS: ReadonlyArray<{ readonly keys: string; readonly action: string }> = [
  { keys: "Mod+B", action: "Bold" },
  { keys: "Mod+I", action: "Italic" },
  { keys: "Mod+U", action: "Underline" },
  { keys: "Mod+Shift+S or Mod+Shift+X", action: "Strikethrough" },
  { keys: "Mod+E", action: "Inline code" },
  { keys: "Mod+K", action: "Add or edit a link" },
  { keys: "Mod+Alt+0", action: "Normal text" },
  { keys: "Mod+Alt+1 to 6", action: "Heading 1 to 6" },
  { keys: "Mod+Shift+7", action: "Numbered list" },
  { keys: "Mod+Shift+8 or Mod+Shift+9", action: "Bulleted list" },
  { keys: "Tab / Shift+Tab", action: "Indent or outdent a list item" },
  { keys: "Mod+Shift+B", action: "Quote" },
  { keys: "Mod+Alt+C", action: "Code block" },
  { keys: "Mod+Shift+L / E / R / J", action: "Align left, center, right, justify" },
  { keys: "Shift+Enter", action: "Line break" },
  { keys: "Mod+Z", action: "Undo" },
  { keys: "Mod+Shift+Z or Mod+Y", action: "Redo" },
  { keys: "Mod+S", action: "Save now" },
  { keys: "Mod+/", action: "This list" },
];
