/**
 * "New" and "Import" on the project's Artifacts shelf. Each kind of artifact
 * that can be made here (a sheet, a whiteboard, a document) contributes one
 * entry; the menu lists them, and Import hands a picked file to the entry that
 * takes its extension. An entry writes the file and returns where it is, and
 * the shelf opens it.
 */
import { FileUpIcon, PlusIcon } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";

import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../../ui/menu";

/** A file an entry made, relative to the project. */
export interface CreatedArtifact {
  readonly path: string;
  readonly title: string;
}

export interface ArtifactNewEntry {
  readonly id: string;
  /** The menu item, such as "Sheet". */
  readonly label: string;
  readonly icon: ReactNode;
  readonly create: () => Promise<CreatedArtifact | null>;
  /** Files this kind converts into a new artifact, by lowercase extension without the dot. */
  readonly imports?: {
    readonly extensions: ReadonlyArray<string>;
    readonly run: (file: File) => Promise<CreatedArtifact | null>;
  };
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function ArtifactNewMenu(props: {
  readonly entries: ReadonlyArray<ArtifactNewEntry>;
  readonly onCreated: (created: CreatedArtifact) => void;
}): ReactNode {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  if (props.entries.length === 0) return null;
  const importers = props.entries.filter((entry) => entry.imports !== undefined);
  const extensions = importers.flatMap((entry) => entry.imports!.extensions);

  const run = (task: () => Promise<CreatedArtifact | null>) => {
    if (busy) return;
    setBusy(true);
    void task()
      .then((created) => {
        if (created !== null) props.onCreated(created);
      })
      .finally(() => setBusy(false));
  };

  return (
    <>
      <Menu>
        <MenuTrigger
          render={<button type="button" className="sws-icon-button" disabled={busy} />}
          aria-label="New artifact"
          title="New"
          data-artifact-new
        >
          <PlusIcon aria-hidden />
        </MenuTrigger>
        <MenuPopup align="end" side="bottom" className="min-w-40">
          {props.entries.map((entry) => (
            <MenuItem key={entry.id} onClick={() => run(entry.create)} data-artifact-new-item={entry.id}>
              {entry.icon}
              {entry.label}
            </MenuItem>
          ))}
        </MenuPopup>
      </Menu>
      {importers.length > 0 ? (
        <>
          <button
            type="button"
            className="sws-icon-button"
            aria-label={`Import ${extensions.map((extension) => `.${extension}`).join(", ")}`}
            title="Import"
            disabled={busy}
            onClick={() => input.current?.click()}
            data-artifact-import
          >
            <FileUpIcon aria-hidden />
          </button>
          <input
            ref={input}
            type="file"
            accept={extensions.map((extension) => `.${extension}`).join(",")}
            hidden
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = "";
              if (!file) return;
              const entry = importers.find((item) => item.imports!.extensions.includes(extensionOf(file.name)));
              if (entry) run(() => entry.imports!.run(file));
            }}
            data-artifact-import-input
          />
        </>
      ) : null}
    </>
  );
}
