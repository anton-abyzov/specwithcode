/** "+ New set": a set is a folder under assets/, so it starts with its first files. */
import { FolderPlusIcon, XIcon } from "lucide-react";
import { useId, useRef, useState } from "react";

import { cn } from "~/lib/utils";

import { Button } from "../../../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../../ui/dialog";
import { Input } from "../../../ui/input";
import { Label } from "../../../ui/label";
import { hasFiles } from "./AssetSetCard";
import { formatSize } from "./filesModel";
import { ACCEPT_ATTRIBUTE, setNameProblem } from "./storedPaths";

export function NewSetDialog({
  existing,
  onCreate,
  onClose,
}: {
  existing: readonly string[];
  /** Resolves to an error message, or null once the files are stored. */
  onCreate: (name: string, files: File[]) => Promise<string | null>;
  onClose: () => void;
}) {
  const id = useId();
  const [name, setName] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dropping, setDropping] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const add = (picked: File[]) => {
    setError(null);
    setFiles((current) => [
      ...current,
      ...picked.filter((file) => !current.some((known) => known.name === file.name)),
    ]);
  };

  const submit = () => {
    const problem = setNameProblem(name, existing);
    if (problem !== null) return setError(problem);
    if (files.length === 0) return setError("Choose at least one file for the set.");
    setBusy(true);
    setError(null);
    void onCreate(name.trim(), files).then((failure) => {
      setBusy(false);
      if (failure === null) onClose();
      else setError(failure);
    });
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogPopup className="sm:max-w-md" data-testid="new-set-dialog">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>New set</DialogTitle>
            <DialogDescription>
              A set is a folder in assets/. It starts with its first files: drop or choose some.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`${id}-name`}>Name</Label>
                <Input
                  id={`${id}-name`}
                  size="sm"
                  value={name}
                  maxLength={60}
                  placeholder="e.g. Logos"
                  onChange={(event) => {
                    setName(event.target.value);
                    setError(null);
                  }}
                />
              </div>
              <div
                className={cn(
                  "flex flex-col items-start gap-2 rounded-lg border border-dashed border-border p-3",
                  dropping && "border-ring bg-accent/40",
                )}
                onDragOver={(event) => {
                  if (!hasFiles(event)) return;
                  event.preventDefault();
                  setDropping(true);
                }}
                onDragLeave={() => setDropping(false)}
                onDrop={(event) => {
                  event.preventDefault();
                  setDropping(false);
                  add([...event.dataTransfer.files]);
                }}
              >
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => input.current?.click()}
                >
                  <FolderPlusIcon aria-hidden />
                  Choose files…
                </Button>
                <input
                  ref={input}
                  type="file"
                  multiple
                  accept={ACCEPT_ATTRIBUTE}
                  className="sr-only"
                  tabIndex={-1}
                  aria-hidden
                  data-testid="new-set-input"
                  onChange={(event) => {
                    add([...(event.target.files ?? [])]);
                    event.target.value = "";
                  }}
                />
                {files.length === 0 ? (
                  <p className="text-xs text-muted-foreground">Or drop files here.</p>
                ) : (
                  <ul className="flex w-full flex-col gap-1 text-xs" data-testid="new-set-files">
                    {files.map((file) => (
                      <li key={file.name} className="flex min-w-0 items-center gap-2">
                        <span className="min-w-0 flex-1 truncate text-foreground">{file.name}</span>
                        <span className="shrink-0 text-muted-foreground tabular-nums">
                          {formatSize(file.size)}
                        </span>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-xs"
                          aria-label={`Leave out ${file.name}`}
                          onClick={() =>
                            setFiles((current) => current.filter((known) => known !== file))
                          }
                        >
                          <XIcon aria-hidden />
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              {error ? (
                <p role="alert" className="text-sm text-destructive-foreground">
                  {error}
                </p>
              ) : null}
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Adding files…" : "Create set"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
