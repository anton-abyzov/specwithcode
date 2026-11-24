/**
 * The Word editor: a .docx as rich text with Word's keys, a formatting bar,
 * autosave and the same "changed on disk" banner as Sheets. It holds no RPC:
 * the document comes in, and saves and exports go out through callbacks.
 */
import type { OfficeDocument } from "@specweave-studio/contracts";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import {
  AlignCenterIcon,
  AlignJustifyIcon,
  AlignLeftIcon,
  AlignRightIcon,
  BoldIcon,
  CodeIcon,
  DownloadIcon,
  ImageIcon,
  IndentDecreaseIcon,
  IndentIncreaseIcon,
  ItalicIcon,
  KeyboardIcon,
  LinkIcon,
  ListIcon,
  ListOrderedIcon,
  MinusIcon,
  QuoteIcon,
  Redo2Icon,
  StrikethroughIcon,
  TableIcon,
  UnderlineIcon,
  Undo2Icon,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Button } from "../../ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../../ui/menu";
import {
  DOCUMENT_SHORTCUTS,
  MAX_PICTURE_BYTES,
  SAFE_LINK_RE,
  documentExtensions,
  type DocumentKeyHandlers,
} from "./documentExtensions";
import { contentToDocument, documentToContent } from "./documentModel";
import "./document.css";

export type DocumentSaveOutcome = "saved" | "conflict" | "failed";

export interface DocumentEditorProps {
  /** The file's name, shown and used for exports. */
  readonly name: string;
  readonly document: OfficeDocument;
  /** What a save would drop; saving waits until the person accepts it. */
  readonly lossOnSave?: ReadonlyArray<string> | undefined;
  /** Kept on save but not shown here. */
  readonly keptNotShown?: ReadonlyArray<string> | undefined;
  /** Saves the document; absent for a person who may only read. */
  readonly onSave?:
    | ((document: OfficeDocument, options: { readonly force: boolean }) => Promise<DocumentSaveOutcome>)
    | undefined;
  /** Loads the file from disk again (the conflict banner's Reload). */
  readonly onReload?: (() => void) | undefined;
  readonly onExportDocx?: ((document: OfficeDocument) => Promise<void> | void) | undefined;
  readonly onExportPdf?: ((document: OfficeDocument) => Promise<void> | void) | undefined;
  readonly onExportMarkdown?: ((document: OfficeDocument) => void) | undefined;
  /** Quiet time before an autosave, in milliseconds. */
  readonly autosaveMs?: number | undefined;
}

type SaveState = "saved" | "dirty" | "saving" | "failed" | "conflict";

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const keyLabel = (keys: string) =>
  isMac ? keys.replace(/Mod\+/g, "⌘").replace(/Alt\+/g, "⌥").replace(/Shift\+/g, "⇧") : keys.replace(/Mod\+/g, "Ctrl+");

function readPicture(file: File): Promise<string | null> {
  if (file.size > MAX_PICTURE_BYTES) return Promise.resolve(null);
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : null);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

function ToolButton(props: {
  readonly label: string;
  readonly keys?: string;
  readonly active?: boolean;
  readonly disabled?: boolean;
  readonly onClick: () => void;
  readonly children: ReactNode;
}): ReactNode {
  const title = props.keys ? `${props.label} (${keyLabel(props.keys)})` : props.label;
  return (
    <button
      type="button"
      className="office-doc-tool"
      aria-label={props.label}
      title={title}
      aria-pressed={props.active === undefined ? undefined : props.active}
      disabled={props.disabled}
      // Keep the selection in the page while the bar is used.
      onMouseDown={(event) => event.preventDefault()}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  );
}

function blockStyleOf(editor: Editor): string {
  for (let level = 1; level <= 6; level += 1) {
    if (editor.isActive("heading", { level })) return `h${level}`;
  }
  if (editor.isActive("codeBlock")) return "code";
  if (editor.isActive("blockquote")) return "quote";
  return "p";
}

function setBlockStyle(editor: Editor, style: string): void {
  const chain = editor.chain().focus();
  if (style === "quote") {
    if (!editor.isActive("blockquote")) chain.setParagraph().setBlockquote().run();
    return;
  }
  if (editor.isActive("blockquote")) chain.unsetBlockquote();
  if (style === "code") chain.setCodeBlock().run();
  else if (style.startsWith("h")) {
    chain.setHeading({ level: Number(style.slice(1)) as 1 | 2 | 3 | 4 | 5 | 6 }).run();
  } else chain.setParagraph().run();
}

export function DocumentEditor(props: DocumentEditorProps): ReactNode {
  const loss = props.lossOnSave ?? [];
  const [state, setState] = useState<SaveState>("saved");
  const [lossAccepted, setLossAccepted] = useState(loss.length === 0);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const linkInput = useRef<HTMLInputElement>(null);
  const pictureInput = useRef<HTMLInputElement>(null);
  const saving = useRef(false);
  const again = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const editable = props.onSave !== undefined;
  const latest = useRef(props);
  latest.current = props;
  const stateRef = useRef(state);
  stateRef.current = state;
  const lossAcceptedRef = useRef(lossAccepted);
  lossAcceptedRef.current = lossAccepted;
  const editorRef = useRef<Editor | null>(null);

  const insertPicture = useCallback(async (file: File) => {
    const src = await readPicture(file);
    if (src === null) {
      setNotice(`Pictures up to ${MAX_PICTURE_BYTES / (1024 * 1024)} MB can be added.`);
      return;
    }
    editorRef.current?.chain().focus().setImage({ src, alt: file.name.replace(/\.[^.]+$/, "") }).run();
  }, []);

  const save = useCallback(async (force = false): Promise<void> => {
    const editor = editorRef.current;
    const onSave = latest.current.onSave;
    if (!editor || !onSave) return;
    if (!lossAcceptedRef.current && !force) return;
    if (stateRef.current === "conflict" && !force) return;
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    if (saving.current) {
      again.current = true;
      return;
    }
    saving.current = true;
    setState("saving");
    // Pictures from the file go back as references, not their bytes again.
    const document = contentToDocument(editor.getJSON(), { assetReferences: true });
    const outcome = await onSave(document, { force });
    saving.current = false;
    if (outcome === "conflict") {
      setState("conflict");
      return;
    }
    if (outcome === "failed") {
      setState("failed");
      return;
    }
    if (again.current) {
      again.current = false;
      setState("dirty");
      void save();
      return;
    }
    setState("saved");
  }, []);

  const handlers = useRef<DocumentKeyHandlers>({
    onSave: () => void save(),
    onLink: () => openLink(),
    onShortcuts: () => setShowShortcuts((open) => !open),
    onPictureFile: (file) => void insertPicture(file),
  });

  const extensions = useMemo(() => documentExtensions(() => handlers.current), []);
  const editor = useEditor({
    extensions,
    content: documentToContent(props.document),
    editable,
    shouldRerenderOnTransaction: true,
    immediatelyRender: true,
    editorProps: {
      attributes: {
        class: "office-doc-page",
        "aria-label": `${props.name} document`,
        spellcheck: "true",
      },
    },
    onUpdate: ({ transaction }) => {
      // Only a person's edit makes the file unsaved; loading it does not.
      if (!transaction.docChanged) return;
      if (stateRef.current !== "conflict") setState(saving.current ? "saving" : "dirty");
      if (saving.current) again.current = true;
      if (timer.current !== null) clearTimeout(timer.current);
      if (lossAcceptedRef.current && stateRef.current !== "conflict") {
        timer.current = setTimeout(() => void save(), latest.current.autosaveMs ?? 1200);
      }
    },
  });
  editorRef.current = editor;

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  function openLink(): void {
    const current = editorRef.current?.getAttributes("link").href;
    setLink(typeof current === "string" ? current : "");
    requestAnimationFrame(() => linkInput.current?.focus());
  }

  const applyLink = (value: string) => {
    if (!editor) return;
    const raw = value.trim();
    const chain = editor.chain().focus().extendMarkRange("link");
    if (raw.length === 0) {
      chain.unsetLink().run();
    } else {
      const href = SAFE_LINK_RE.test(raw)
        ? raw
        : /^[\w.-]+\.[a-z]{2,}(\/\S*)?$/i.test(raw)
          ? `https://${raw}`
          : /^[^\s@]+@[^\s@]+$/.test(raw)
            ? `mailto:${raw}`
            : null;
      if (href === null) {
        setNotice("Links can be web addresses, e-mail addresses or #places in the document.");
        return;
      }
      if (editor.state.selection.empty && !editor.isActive("link")) {
        chain.insertContent({ type: "text", text: raw, marks: [{ type: "link", attrs: { href } }] }).run();
      } else chain.setLink({ href }).run();
    }
    setLink(null);
  };

  if (!editor) return null;
  const current = () => contentToDocument(editor.getJSON());
  const inTable = editor.isActive("table");
  const statusText =
    state === "saving"
      ? "Saving…"
      : state === "dirty"
        ? lossAccepted
          ? "Unsaved changes"
          : "Not saved yet"
        : state === "failed"
          ? "Could not save"
          : state === "conflict"
            ? "Changed on disk"
            : "Saved";

  return (
    <div
      className="office-surface office-doc"
      data-document-editor
      // The app's own shortcuts stay out of the page while it has focus.
      data-keybinding-capture
      onKeyDown={(event) => {
        if (event.key === "Escape" && (showShortcuts || link !== null)) {
          setShowShortcuts(false);
          setLink(null);
          editor.commands.focus();
          event.stopPropagation();
        }
      }}
    >
      {editable ? (
        <div className="office-doc-bar" role="toolbar" aria-label="Formatting">
          <select
            className="office-doc-style"
            aria-label="Paragraph style"
            value={blockStyleOf(editor)}
            onChange={(event) => setBlockStyle(editor, event.target.value)}
          >
            <option value="p">Normal text</option>
            <option value="h1">Heading 1</option>
            <option value="h2">Heading 2</option>
            <option value="h3">Heading 3</option>
            <option value="h4">Heading 4</option>
            <option value="quote">Quote</option>
            <option value="code">Code</option>
          </select>
          <span className="office-doc-sep" />
          <ToolButton label="Bold" keys="Mod+B" active={editor.isActive("bold")} onClick={() => editor.chain().focus().toggleBold().run()}>
            <BoldIcon />
          </ToolButton>
          <ToolButton label="Italic" keys="Mod+I" active={editor.isActive("italic")} onClick={() => editor.chain().focus().toggleItalic().run()}>
            <ItalicIcon />
          </ToolButton>
          <ToolButton label="Underline" keys="Mod+U" active={editor.isActive("underline")} onClick={() => editor.chain().focus().toggleUnderline().run()}>
            <UnderlineIcon />
          </ToolButton>
          <ToolButton label="Strikethrough" keys="Mod+Shift+X" active={editor.isActive("strike")} onClick={() => editor.chain().focus().toggleStrike().run()}>
            <StrikethroughIcon />
          </ToolButton>
          <ToolButton label="Inline code" keys="Mod+E" active={editor.isActive("code")} onClick={() => editor.chain().focus().toggleCode().run()}>
            <CodeIcon />
          </ToolButton>
          <ToolButton label="Link" keys="Mod+K" active={editor.isActive("link")} onClick={openLink}>
            <LinkIcon />
          </ToolButton>
          <span className="office-doc-sep" />
          <ToolButton label="Bulleted list" keys="Mod+Shift+8" active={editor.isActive("bulletList")} onClick={() => editor.chain().focus().toggleBulletList().run()}>
            <ListIcon />
          </ToolButton>
          <ToolButton label="Numbered list" keys="Mod+Shift+7" active={editor.isActive("orderedList")} onClick={() => editor.chain().focus().toggleOrderedList().run()}>
            <ListOrderedIcon />
          </ToolButton>
          <ToolButton label="Outdent" keys="Shift+Tab" disabled={!editor.can().liftListItem("listItem")} onClick={() => editor.chain().focus().liftListItem("listItem").run()}>
            <IndentDecreaseIcon />
          </ToolButton>
          <ToolButton label="Indent" keys="Tab" disabled={!editor.can().sinkListItem("listItem")} onClick={() => editor.chain().focus().sinkListItem("listItem").run()}>
            <IndentIncreaseIcon />
          </ToolButton>
          <ToolButton label="Quote" keys="Mod+Shift+B" active={editor.isActive("blockquote")} onClick={() => editor.chain().focus().toggleBlockquote().run()}>
            <QuoteIcon />
          </ToolButton>
          <span className="office-doc-sep" />
          <ToolButton label="Align left" keys="Mod+Shift+L" active={!editor.isActive({ textAlign: "center" }) && !editor.isActive({ textAlign: "right" }) && !editor.isActive({ textAlign: "justify" })} onClick={() => editor.chain().focus().unsetTextAlign().run()}>
            <AlignLeftIcon />
          </ToolButton>
          <ToolButton label="Center" keys="Mod+Shift+E" active={editor.isActive({ textAlign: "center" })} onClick={() => editor.chain().focus().setTextAlign("center").run()}>
            <AlignCenterIcon />
          </ToolButton>
          <ToolButton label="Align right" keys="Mod+Shift+R" active={editor.isActive({ textAlign: "right" })} onClick={() => editor.chain().focus().setTextAlign("right").run()}>
            <AlignRightIcon />
          </ToolButton>
          <ToolButton label="Justify" keys="Mod+Shift+J" active={editor.isActive({ textAlign: "justify" })} onClick={() => editor.chain().focus().setTextAlign("justify").run()}>
            <AlignJustifyIcon />
          </ToolButton>
          <span className="office-doc-sep" />
          <ToolButton label="Insert table" onClick={() => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}>
            <TableIcon />
          </ToolButton>
          <ToolButton label="Insert picture" onClick={() => pictureInput.current?.click()}>
            <ImageIcon />
          </ToolButton>
          <ToolButton label="Insert divider" onClick={() => editor.chain().focus().setHorizontalRule().run()}>
            <MinusIcon />
          </ToolButton>
          <span className="office-doc-sep" />
          <ToolButton label="Undo" keys="Mod+Z" disabled={!editor.can().undo()} onClick={() => editor.chain().focus().undo().run()}>
            <Undo2Icon />
          </ToolButton>
          <ToolButton label="Redo" keys="Mod+Shift+Z" disabled={!editor.can().redo()} onClick={() => editor.chain().focus().redo().run()}>
            <Redo2Icon />
          </ToolButton>
          <span className="office-doc-spacer" />
          <span className="office-doc-status" role="status" data-save-state={state}>
            {statusText}
          </span>
          <ToolButton label="Keyboard shortcuts" keys="Mod+/" onClick={() => setShowShortcuts((open) => !open)}>
            <KeyboardIcon />
          </ToolButton>
          <ExportMenu {...props} current={current} />
          <input
            ref={pictureInput}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void insertPicture(file);
            }}
          />
        </div>
      ) : (
        <div className="office-doc-bar" role="toolbar" aria-label="Document">
          <span className="office-doc-readonly">Read only</span>
          <span className="office-doc-spacer" />
          <ExportMenu {...props} current={current} />
        </div>
      )}
      {inTable && editable ? (
        <div className="office-doc-subbar" role="toolbar" aria-label="Table">
          <button type="button" onClick={() => editor.chain().focus().addRowAfter().run()}>Add row</button>
          <button type="button" onClick={() => editor.chain().focus().addColumnAfter().run()}>Add column</button>
          <button type="button" onClick={() => editor.chain().focus().deleteRow().run()}>Delete row</button>
          <button type="button" onClick={() => editor.chain().focus().deleteColumn().run()}>Delete column</button>
          <button type="button" onClick={() => editor.chain().focus().toggleHeaderRow().run()}>Header row</button>
          <button type="button" onClick={() => editor.chain().focus().deleteTable().run()}>Delete table</button>
        </div>
      ) : null}
      {link !== null ? (
        <form
          className="office-doc-subbar"
          aria-label="Link"
          onSubmit={(event) => {
            event.preventDefault();
            applyLink(linkInput.current?.value ?? "");
          }}
        >
          <LinkIcon aria-hidden className="size-4 text-muted-foreground" />
          <input
            ref={linkInput}
            className="office-doc-link-input"
            defaultValue={link}
            placeholder="https://example.com, name@example.com or #heading"
            aria-label="Link address"
          />
          <Button type="submit" size="sm">Apply</Button>
          {link ? (
            <Button type="button" size="sm" variant="outline" onClick={() => applyLink("")}>
              Remove link
            </Button>
          ) : null}
          <Button type="button" size="sm" variant="ghost" onClick={() => setLink(null)}>
            Cancel
          </Button>
        </form>
      ) : null}
      {editable && !lossAccepted ? (
        <div className="office-doc-banner" role="alert" data-document-loss>
          <span>
            Saving rewrites this file without: {loss.join(", ")}.
            {(props.keptNotShown ?? []).length > 0
              ? ` ${(props.keptNotShown ?? []).join(", ")} stay as they are.`
              : ""}{" "}
            Edits are not saved until you choose.
          </span>
          <Button
            type="button"
            size="sm"
            data-document-loss-accept
            onClick={() => {
              setLossAccepted(true);
              lossAcceptedRef.current = true;
              if (stateRef.current === "dirty") void save();
            }}
          >
            Save anyway
          </Button>
        </div>
      ) : null}
      {state === "conflict" ? (
        <div className="office-doc-banner" role="alert" data-document-conflict>
          <span>This document changed on disk while you were editing.</span>
          <span className="office-doc-banner-actions">
            <Button type="button" size="sm" variant="outline" data-document-conflict-reload onClick={() => props.onReload?.()}>
              Reload latest
            </Button>
            <Button type="button" size="sm" data-document-conflict-keep onClick={() => void save(true)}>
              Keep my edits
            </Button>
          </span>
        </div>
      ) : null}
      {state === "failed" ? (
        <div className="office-doc-banner" role="alert">
          <span>The document could not be saved. Your edits are still here.</span>
          <Button type="button" size="sm" variant="outline" onClick={() => void save(true)}>
            Try again
          </Button>
        </div>
      ) : null}
      {notice !== null ? (
        <div className="office-doc-banner" role="status">
          <span>{notice}</span>
          <Button type="button" size="sm" variant="ghost" onClick={() => setNotice(null)}>
            Dismiss
          </Button>
        </div>
      ) : null}
      <div className="office-doc-scroll">
        <EditorContent editor={editor} className="office-doc-paper" />
      </div>
      {showShortcuts ? (
        <div className="office-doc-shortcuts" role="dialog" aria-label="Keyboard shortcuts">
          <div className="office-doc-shortcuts-head">
            <strong>Keyboard shortcuts</strong>
            <Button type="button" size="sm" variant="ghost" onClick={() => setShowShortcuts(false)}>
              Close
            </Button>
          </div>
          <table>
            <tbody>
              {DOCUMENT_SHORTCUTS.map((entry) => (
                <tr key={entry.action}>
                  <td>{entry.action}</td>
                  <td>
                    <kbd>{keyLabel(entry.keys)}</kbd>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}

function ExportMenu(props: DocumentEditorProps & { readonly current: () => OfficeDocument }): ReactNode {
  if (!props.onExportDocx && !props.onExportPdf && !props.onExportMarkdown) return null;
  return (
    <Menu>
      <MenuTrigger
        render={<button type="button" className="office-doc-tool office-doc-export" />}
        aria-label="Export"
      >
        <DownloadIcon aria-hidden />
        <span>Export</span>
      </MenuTrigger>
      <MenuPopup align="end" side="bottom" className="min-w-52">
        {props.onExportDocx ? (
          <MenuItem onClick={() => void props.onExportDocx!(props.current())}>Word document (.docx)</MenuItem>
        ) : null}
        {props.onExportPdf ? (
          <MenuItem onClick={() => void props.onExportPdf!(props.current())}>PDF</MenuItem>
        ) : null}
        {props.onExportMarkdown ? (
          <>
            <MenuSeparator />
            <MenuItem onClick={() => props.onExportMarkdown!(props.current())}>Markdown (.md)</MenuItem>
          </>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}
